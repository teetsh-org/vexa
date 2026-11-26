"""Real-Postgres conformance for the authenticated identity pool (``SqlAlchemyMeetingRepo``).

The in-memory fake decides identity choice in Python; the real adapter does it with an advisory
lock and a JSONB aggregate. These run THAT SQL: concurrent spawns of different users on one
identity pool never share an identity, the least recently used free identity wins, a stopping
meeting holds its identity, and a reopened row takes a free one. Needs SQLAlchemy + asyncpg
(the image installs them) and ``MEETING_API_TEST_DATABASE_URL`` pointing at a throwaway database.
"""
from __future__ import annotations

import asyncio
import os

import pytest

pytestmark = pytest.mark.skipif(
    not os.getenv("MEETING_API_TEST_DATABASE_URL"),
    reason="real-Postgres conformance for the identity pool; set MEETING_API_TEST_DATABASE_URL to run",
)

PATHS = ["userdata/id-1", "userdata/id-2"]


@pytest.fixture
async def repo():
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from meeting_api.bot_spawn.adapters import SqlAlchemyMeetingRepo
    from meeting_api.sessions.models import Base

    engine = create_async_engine(os.environ["MEETING_API_TEST_DATABASE_URL"])
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        # Two meeting indexes call this function, which the admin-api schema sync owns; a stand-in
        # with its signature is enough here, since nothing below sorts by event time.
        await conn.execute(text(
            "CREATE OR REPLACE FUNCTION meeting_event_time(data jsonb, start_time timestamp, "
            "created_at timestamp) RETURNS timestamp LANGUAGE sql IMMUTABLE "
            "AS $$ SELECT COALESCE(start_time, created_at) $$"
        ))
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield SqlAlchemyMeetingRepo(async_sessionmaker(engine, expire_on_commit=False))
    finally:
        await engine.dispose()


async def _create(repo, user_id, native):
    return await repo.create_meeting_guarded(
        user_id=user_id, platform="google_meet", native_meeting_id=native,
        data={"recording_enabled": True}, identity_paths=PATHS,
    )


async def _set_status(repo, meeting_id, status):
    from sqlalchemy import update

    from meeting_api.sessions.models import Meeting

    async with repo._session_factory() as db:
        await db.execute(update(Meeting).where(Meeting.id == meeting_id).values(status=status))
        await db.commit()


async def test_concurrent_spawns_across_users_never_share_an_identity(repo):
    from meeting_api.bot_spawn.ports import AuthSessionBusy

    results = await asyncio.gather(
        *[_create(repo, user_id=u, native=f"nat-{u}") for u in (1, 2, 3, 4)],
        return_exceptions=True,
    )
    rows = [r for r in results if isinstance(r, dict)]
    busy = [r for r in results if isinstance(r, AuthSessionBusy)]
    assert len(rows) == 2 and len(busy) == 2, results
    assert sorted(r["data"]["auth_userdata_path"] for r in rows) == PATHS
    assert sorted(busy[0].conflicting_meeting_ids) == sorted(r["id"] for r in rows)


async def test_least_recently_used_free_identity_and_stopping_holds(repo):
    from meeting_api.bot_spawn.ports import AuthSessionBusy

    first = await _create(repo, 1, "nat-a")
    assert first["data"]["auth_userdata_path"] == "userdata/id-1"     # never-used, config order
    await _set_status(repo, first["id"], "completed")
    second = await _create(repo, 1, "nat-b")
    assert second["data"]["auth_userdata_path"] == "userdata/id-2"    # id-2 never used: older
    await _set_status(repo, second["id"], "completed")
    third = await _create(repo, 2, "nat-c")
    assert third["data"]["auth_userdata_path"] == "userdata/id-1"     # id-1 used longest ago
    await _set_status(repo, third["id"], "stopping")
    fourth = await _create(repo, 2, "nat-d")
    assert fourth["data"]["auth_userdata_path"] == "userdata/id-2"
    with pytest.raises(AuthSessionBusy):                              # stopping still holds id-1
        await _create(repo, 3, "nat-e")


async def test_reopen_takes_a_free_identity(repo):
    first = await _create(repo, 1, "nat-a")
    await _set_status(repo, first["id"], "completed")
    other = await _create(repo, 2, "nat-b")                            # holds id-2
    assert other["data"]["auth_userdata_path"] == "userdata/id-2"
    reopened = await repo.reopen_meeting(meeting_id=first["id"], data_patch={}, identity_paths=PATHS)
    assert reopened["status"] == "requested"
    assert reopened["data"]["auth_userdata_path"] == "userdata/id-1"
