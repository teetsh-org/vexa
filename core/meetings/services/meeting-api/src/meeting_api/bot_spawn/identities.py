"""The authenticated-bot identity pool — which stored browser session a spawn runs on.

An identity is one signed-in account: a userdata prefix holding its provisioned session, plus the
scoped S3 key pair that can read and write that prefix and nothing else. One identity runs one live
bot at a time (one cookie jar live from one place; one writer for the session write-back), so N
concurrent authenticated bots take N identities.

The deployment declares them with env:

  * ``BOT_USERDATA_S3_PATH`` + ``BOT_S3_ACCESS_KEY`` / ``BOT_S3_SECRET_KEY`` — the first identity;
  * ``BOT_EXTRA_IDENTITIES`` — optional, a JSON list of further identities, each
    ``{"path": "userdata/bot-identity-2", "accessKey": "...", "secretKey": "..."}``.

``BOT_S3_ENDPOINT`` and ``BOT_S3_BUCKET`` are shared: every identity lives in the same store.

A spawn takes the least recently used identity that no live meeting holds (``choose_identity``), so
every account keeps being used and its session keeps rotating. When every identity is held, the
spawn is refused with ``AuthSessionBusy`` (HTTP 409) naming the meetings that hold them.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from .ports import AuthSessionBusy, AuthSessionNotConfigured

# A meeting holds its identity from the spawn until the bot has torn down — ``stopping`` included,
# since the session write-back runs during teardown.
IDENTITY_HOLDING_STATUSES = ("requested", "joining", "awaiting_admission", "active", "stopping")

# The deployment-wide advisory lock that serializes identity choice across users and replicas. The
# "IDP\0" namespace sits in the high 32 bits of a single bigint key, disjoint from the per-user
# ``pg_advisory_xact_lock(:user_id)`` keys (high bits 0) and the sweep keys ("SWP\0").
IDENTITY_LOCK_KEY = 0x49445000 << 32


@dataclass(frozen=True)
class BotIdentity:
    path: str
    access_key: Optional[str]
    secret_key: Optional[str]


@dataclass(frozen=True)
class IdentityUsage:
    """What the meetings table says about one identity: a meeting holding it now, if any, and
    when it was last given to a spawn (``None`` when never)."""

    holder_meeting_id: Optional[int] = None
    last_used: Optional[datetime] = None


def _normalized(path: str) -> str:
    return path.strip().strip("/")


def _extra_identities(raw: str) -> list[BotIdentity]:
    try:
        items = json.loads(raw)
    except json.JSONDecodeError as e:
        raise AuthSessionNotConfigured(f"BOT_EXTRA_IDENTITIES is not valid JSON ({e.msg})") from e
    if not isinstance(items, list):
        raise AuthSessionNotConfigured("BOT_EXTRA_IDENTITIES must be a JSON list of identities")
    out = []
    for n, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            raise AuthSessionNotConfigured(f"BOT_EXTRA_IDENTITIES[{n}] must be an object")
        path = _normalized(str(item.get("path") or ""))
        access, secret = item.get("accessKey") or None, item.get("secretKey") or None
        if not (path and access and secret):
            raise AuthSessionNotConfigured(
                f"BOT_EXTRA_IDENTITIES[{n}] needs path, accessKey and secretKey — each identity "
                "carries its own scoped key pair"
            )
        out.append(BotIdentity(path=path, access_key=str(access), secret_key=str(secret)))
    return out


def _nested(a: str, b: str) -> bool:
    return a == b or a.startswith(b + "/") or b.startswith(a + "/")


def load_identities() -> list[BotIdentity]:
    """The deployment's identities, first identity first. Raises ``AuthSessionNotConfigured`` for a
    malformed pool: two identities on one prefix (or one prefix inside another) would share a
    session, and two on one key pair would each reach the other's session."""
    first_path = _normalized(os.getenv("BOT_USERDATA_S3_PATH") or "")
    if not first_path:
        raise AuthSessionNotConfigured(
            "BOT_AUTHENTICATED is set but BOT_USERDATA_S3_PATH is empty; provision the session "
            "with `make login`"
        )
    identities = [BotIdentity(
        path=first_path,
        access_key=os.getenv("BOT_S3_ACCESS_KEY") or None,
        secret_key=os.getenv("BOT_S3_SECRET_KEY") or None,
    )]
    raw = (os.getenv("BOT_EXTRA_IDENTITIES") or "").strip()
    if raw:
        identities += _extra_identities(raw)
    for i, a in enumerate(identities):
        for b in identities[i + 1:]:
            if _nested(a.path, b.path):
                raise AuthSessionNotConfigured(
                    f"bot identities '{a.path}' and '{b.path}' overlap; each identity needs its "
                    "own userdata prefix"
                )
            if a.access_key and a.access_key == b.access_key:
                raise AuthSessionNotConfigured(
                    f"bot identities '{a.path}' and '{b.path}' share an access key; each identity "
                    "needs its own scoped key pair"
                )
    return identities


def choose_identity(paths: list[str], usage: dict[str, IdentityUsage]) -> str:
    """The least recently used free identity among ``paths`` (never-used ones first, in the order
    given). Raises ``AuthSessionBusy`` naming the holding meetings when none is free."""
    free = [p for p in paths if usage.get(p, IdentityUsage()).holder_meeting_id is None]
    if not free:
        raise AuthSessionBusy([usage[p].holder_meeting_id for p in paths])

    def recency(p: str):
        last = usage.get(p, IdentityUsage()).last_used
        return (last is not None, last or datetime.min, paths.index(p))

    return min(free, key=recency)
