"""Authenticated-bot spawn wiring (#724 C2) + per-identity serialization (#725 C2).

Drives the SHIPPED ``request_bot`` over the in-memory fakes, offline. The deployment-scoped
``BOT_AUTHENTICATED`` knob makes every stock ``POST /bots`` spawn carry the sealed invocation.v1
auth block; without the knob the invocation carries none of it (the anonymous flow untouched).
Config gaps refuse loud (503-shaped) before any DB write; a second concurrent spawn against the
same stored session is refused with a typed 409 naming the conflicting meeting.
"""
from __future__ import annotations

import json

import pytest

from meeting_api.bot_spawn import build_invocation, mint_meeting_token, request_bot
from meeting_api.bot_spawn.fakes import FakeRuntimeClient, InMemoryMeetingRepo
from meeting_api.bot_spawn.invocation import conforms_invocation
from meeting_api.bot_spawn.ports import AuthSessionBusy, AuthSessionNotConfigured

SECRET = "test-admin-token"
USER = 7

AUTH_FIELDS = ("authenticated", "userdataS3Path", "s3Endpoint", "s3Bucket", "s3AccessKey", "s3SecretKey")


def _set_auth_env(monkeypatch, **overrides):
    env = {
        "BOT_AUTHENTICATED": "true",
        "BOT_USERDATA_S3_PATH": "userdata/bot-identity-1",
        "BOT_S3_ENDPOINT": "http://minio:9000",
        "BOT_S3_BUCKET": "vexa",
        "BOT_S3_ACCESS_KEY": "userdata-key",
        "BOT_S3_SECRET_KEY": "userdata-secret",
        "TRANSCRIPTION_SERVICE_URL": "https://stt.vexa.ai",
        "TRANSCRIPTION_SERVICE_TOKEN": "tok-test",
    }
    env.update(overrides)
    for k, v in env.items():
        if v is None:
            monkeypatch.delenv(k, raising=False)
        else:
            monkeypatch.setenv(k, v)


async def _spawn(repo, runtime, native_id="abc-defg-hij"):
    return await request_bot(
        repo, runtime, user_id=USER, platform="google_meet",
        native_meeting_id=native_id, bot_name="VexaBot",
        redis_url="redis://redis:6379/0", meeting_api_url="http://meeting-api:8080",
        token_secret=SECRET,
    )


# ── unit: build_invocation carries the sealed auth block ─────────────────────────────────────────

def test_build_invocation_carries_auth_block():
    token = mint_meeting_token(1, USER, "google_meet", "abc-defg-hij", secret=SECRET)
    base = dict(meeting_id=1, platform="google_meet",
                meeting_url="https://meet.google.com/abc-defg-hij", bot_name="VexaBot",
                token=token, native_meeting_id="abc-defg-hij", connection_id="conn-1",
                redis_url="redis://redis:6379/0")
    inv = build_invocation(**base, authenticated=True, userdata_s3_path="userdata/id-1",
                           s3_endpoint="http://minio:9000", s3_bucket="vexa",
                           s3_access_key="k", s3_secret_key="s")
    conforms_invocation(inv)
    assert inv["authenticated"] is True
    assert inv["userdataS3Path"] == "userdata/id-1"
    assert inv["s3Endpoint"] == "http://minio:9000"
    assert inv["s3Bucket"] == "vexa"
    # negative control: without the params, NO auth field ships (None-stripped).
    plain = build_invocation(**base)
    assert not any(f in plain for f in AUTH_FIELDS)


# ── flow: the deployment knob populates every spawn ──────────────────────────────────────────────

async def test_knob_populates_stock_post_bots_spawn(monkeypatch):
    _set_auth_env(monkeypatch)
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    await _spawn(repo, runtime)
    inv = json.loads(runtime.specs[0]["env"]["VEXA_BOT_CONFIG"])
    conforms_invocation(inv)
    assert inv["authenticated"] is True
    assert inv["userdataS3Path"] == "userdata/bot-identity-1"
    assert inv["s3AccessKey"] == "userdata-key"
    assert inv["s3SecretKey"] == "userdata-secret"


async def test_knob_off_ships_no_auth_fields(monkeypatch):
    """Base control: without the knob the invocation is the anonymous shape — zero auth fields."""
    _set_auth_env(monkeypatch, BOT_AUTHENTICATED=None)
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    await _spawn(repo, runtime)
    inv = json.loads(runtime.specs[0]["env"]["VEXA_BOT_CONFIG"])
    assert not any(f in inv for f in AUTH_FIELDS)


async def test_incomplete_config_refuses_before_any_db_write(monkeypatch):
    _set_auth_env(monkeypatch, BOT_S3_BUCKET=None)
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    with pytest.raises(AuthSessionNotConfigured):
        await _spawn(repo, runtime)
    assert repo._meetings == {}          # refused BEFORE the meeting-row insert
    assert runtime.specs == []           # nothing spawned


# ── per-identity serialization (#725 C2): one stored session, one live bot ───────────────────────

async def test_second_concurrent_authenticated_spawn_refused(monkeypatch):
    _set_auth_env(monkeypatch)
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    first = await _spawn(repo, runtime, native_id="aaa-aaaa-aaa")
    with pytest.raises(AuthSessionBusy) as exc:
        await _spawn(repo, runtime, native_id="bbb-bbbb-bbb")   # different meeting, same identity
    assert exc.value.conflicting_meeting_id == first["id"]      # refusal names the conflict
    assert str(first["id"]) in str(exc.value)
    assert len(runtime.specs) == 1                              # exactly one bot ran


async def test_terminal_meeting_releases_the_identity(monkeypatch):
    """Negative control: once the first meeting is terminal, the next spawn proceeds — the
    serialization gate holds only while the session is actually in use."""
    _set_auth_env(monkeypatch)
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    first = await _spawn(repo, runtime, native_id="aaa-aaaa-aaa")
    repo._meetings[first["id"]]["status"] = "completed"
    second = await _spawn(repo, runtime, native_id="bbb-bbbb-bbb")
    assert second["id"] != first["id"]
    assert len(runtime.specs) == 2


async def test_anonymous_spawns_do_not_serialize(monkeypatch):
    """Anonymous flow untouched: with the knob off, concurrent spawns of different meetings
    never hit the identity gate."""
    _set_auth_env(monkeypatch, BOT_AUTHENTICATED=None)
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    await _spawn(repo, runtime, native_id="aaa-aaaa-aaa")
    await _spawn(repo, runtime, native_id="bbb-bbbb-bbb")
    assert len(runtime.specs) == 2


# ── identity pool: N identities run N concurrent authenticated bots ─────────────────────────────

EXTRA = [
    {"path": "userdata/bot-identity-2", "accessKey": "key-2", "secretKey": "secret-2"},
    {"path": "/userdata/bot-identity-3/", "accessKey": "key-3", "secretKey": "secret-3"},
]


def _identity_of_spec(spec) -> tuple[str, str, str]:
    inv = json.loads(spec["env"]["VEXA_BOT_CONFIG"])
    return inv["userdataS3Path"], inv["s3AccessKey"], inv["s3SecretKey"]


async def test_pool_runs_one_bot_per_identity_with_its_own_keys(monkeypatch):
    _set_auth_env(monkeypatch, BOT_EXTRA_IDENTITIES=json.dumps(EXTRA))
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    rows = [await _spawn(repo, runtime, native_id=n) for n in ("aaa-aaaa-aaa", "bbb-bbbb-bbb", "ccc-cccc-ccc")]
    used = [_identity_of_spec(s) for s in runtime.specs]
    assert sorted(used) == [
        ("userdata/bot-identity-1", "userdata-key", "userdata-secret"),
        ("userdata/bot-identity-2", "key-2", "secret-2"),
        ("userdata/bot-identity-3", "key-3", "secret-3"),
    ]
    # the row records the identity it runs on — the serialization key the next spawn reads
    assert [repo._meetings[r["id"]]["data"]["auth_userdata_path"] for r in rows] == [u[0] for u in used]


async def test_pool_exhausted_refuses_naming_every_holder(monkeypatch):
    _set_auth_env(monkeypatch, BOT_EXTRA_IDENTITIES=json.dumps(EXTRA[:1]))
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    first = await _spawn(repo, runtime, native_id="aaa-aaaa-aaa")
    second = await _spawn(repo, runtime, native_id="bbb-bbbb-bbb")
    with pytest.raises(AuthSessionBusy) as exc:
        await _spawn(repo, runtime, native_id="ccc-cccc-ccc")
    assert sorted(exc.value.conflicting_meeting_ids) == sorted([first["id"], second["id"]])
    assert "userdata/" not in str(exc.value)                    # prefixes locate credentials
    assert len(runtime.specs) == 2
    assert len(repo._meetings) == 2                             # no row for the refused spawn


async def test_pool_takes_the_least_recently_used_free_identity(monkeypatch):
    """Every identity keeps being used (a session only read decays): after identity 1 ran and
    ended, the next spawn takes the never-used identity 2, then identity 1 again."""
    _set_auth_env(monkeypatch, BOT_EXTRA_IDENTITIES=json.dumps(EXTRA[:1]))
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    seen = []
    for n in ("aaa-aaaa-aaa", "bbb-bbbb-bbb", "ccc-cccc-ccc", "ddd-dddd-ddd"):
        row = await _spawn(repo, runtime, native_id=n)
        seen.append(repo._meetings[row["id"]]["data"]["auth_userdata_path"])
        repo._meetings[row["id"]]["status"] = "completed"
    assert seen == ["userdata/bot-identity-1", "userdata/bot-identity-2",
                    "userdata/bot-identity-1", "userdata/bot-identity-2"]


async def test_a_stopping_bot_still_holds_its_identity(monkeypatch):
    """The session write-back runs during teardown: a stopping meeting keeps its identity."""
    _set_auth_env(monkeypatch)
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    first = await _spawn(repo, runtime, native_id="aaa-aaaa-aaa")
    repo._meetings[first["id"]]["status"] = "stopping"
    with pytest.raises(AuthSessionBusy):
        await _spawn(repo, runtime, native_id="bbb-bbbb-bbb")


async def test_concurrent_spawns_never_share_an_identity(monkeypatch):
    import asyncio

    _set_auth_env(monkeypatch, BOT_EXTRA_IDENTITIES=json.dumps(EXTRA))
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    await asyncio.gather(*[_spawn(repo, runtime, native_id=n)
                           for n in ("aaa-aaaa-aaa", "bbb-bbbb-bbb", "ccc-cccc-ccc")])
    paths = [_identity_of_spec(s)[0] for s in runtime.specs]
    assert len(set(paths)) == 3


async def test_continued_meeting_takes_a_free_identity(monkeypatch):
    """continue_meeting reopens a terminal row in place; it records the identity it now runs on,
    which need not be the one the earlier run used."""
    _set_auth_env(monkeypatch, BOT_EXTRA_IDENTITIES=json.dumps(EXTRA[:1]))
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    first = await _spawn(repo, runtime, native_id="aaa-aaaa-aaa")
    repo._meetings[first["id"]]["status"] = "completed"
    busy = await _spawn(repo, runtime, native_id="bbb-bbbb-bbb")        # takes identity 2
    assert repo._meetings[busy["id"]]["data"]["auth_userdata_path"] == "userdata/bot-identity-2"
    again = await request_bot(
        repo, runtime, user_id=USER, platform="google_meet", native_meeting_id="aaa-aaaa-aaa",
        bot_name="VexaBot", redis_url="redis://redis:6379/0",
        meeting_api_url="http://meeting-api:8080", token_secret=SECRET, continue_meeting=True,
    )
    assert again["id"] == first["id"]
    assert repo._meetings[first["id"]]["data"]["auth_userdata_path"] == "userdata/bot-identity-1"
    assert _identity_of_spec(runtime.specs[-1])[0] == "userdata/bot-identity-1"


@pytest.mark.parametrize("extra, reason", [
    ("not json", "not valid JSON"),
    (json.dumps({"path": "userdata/x"}), "JSON list"),
    (json.dumps([{"path": "userdata/x", "accessKey": "k"}]), "own scoped key pair"),
    (json.dumps([{"path": "userdata/bot-identity-1/", "accessKey": "k", "secretKey": "s"}]), "overlap"),
    (json.dumps([{"path": "userdata/bot-identity-1/nested", "accessKey": "k", "secretKey": "s"}]), "overlap"),
    (json.dumps([{"path": "userdata/x", "accessKey": "userdata-key", "secretKey": "s"}]), "share an access key"),
])
async def test_malformed_pool_refuses_before_any_db_write(monkeypatch, extra, reason):
    _set_auth_env(monkeypatch, BOT_EXTRA_IDENTITIES=extra)
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    with pytest.raises(AuthSessionNotConfigured) as exc:
        await _spawn(repo, runtime)
    assert reason in str(exc.value)
    assert repo._meetings == {}
    assert runtime.specs == []


def test_choose_identity_order():
    from datetime import datetime

    from meeting_api.bot_spawn.identities import IdentityUsage, choose_identity

    paths = ["a", "b", "c"]
    old, new = datetime(2026, 1, 1), datetime(2026, 2, 1)
    # never-used first, in configuration order
    assert choose_identity(paths, {"a": IdentityUsage(last_used=new)}) == "b"
    # all used: the oldest last use
    assert choose_identity(paths, {"a": IdentityUsage(last_used=new), "b": IdentityUsage(last_used=new),
                                   "c": IdentityUsage(last_used=old)}) == "c"
    # a held identity is never chosen, however old
    assert choose_identity(paths, {"a": IdentityUsage(last_used=new), "b": IdentityUsage(last_used=new),
                                   "c": IdentityUsage(holder_meeting_id=9, last_used=old)}) in ("a", "b")
    with pytest.raises(AuthSessionBusy) as exc:
        choose_identity(["a"], {"a": IdentityUsage(holder_meeting_id=9)})
    assert exc.value.conflicting_meeting_ids == [9]
