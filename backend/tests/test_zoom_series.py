# =============================================================================
# Tests: Zoom Meeting Creation for Series Children (E21, closing the series
# hole -- ПРОМТ №520; REWRITTEN ПРОМТ №559 -- see below)
# =============================================================================
#
# telegram_id range: 79100-79199 (own band, no overlap with test_zoom_lifecycle
# [79000-79099] or test_zoom_registrants [79200-79299]).
#
# ПРОМТ №559 (OWNER-3): series-child meeting creation is no longer synchronous
# during publish. MEASURED on prod: a series publish made one real Zoom API
# call per child, sequentially, inside one request; a ~29-occurrence series
# comfortably exceeds the frontend's 15s request timeout, the master saw a
# failure that hadn't actually happened, and resubmitted -- three complete
# duplicate series in four minutes. The fix: the ROOT still gets its meeting
# synchronously (it is always the nearest occurrence -- children are only
# ever later dates), every CHILD gets a ZoomMeeting row at
# status=pending_creation (deferred, not failed) and is picked up by the
# existing retry poller in the background. This file's original single test
# asserted the OLD synchronous-per-child behavior (mocking create_meeting to
# fail on the SECOND of four sequential calls) -- that premise no longer
# holds (there is only ONE synchronous call now, for the root), so it is
# replaced with two tests matching the new design, not patched around it.
#
# ⚠ BACKEND-ONLY, UNPROVEN LOCALLY -- see test_zoom_lifecycle.py's module
# docstring for the exact local blocker (pre-existing stray key in
# backend/.env, observed this session, not touched). Same situation here:
# written to be read, collection-checked, never executed.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice
from app.modules.users.models import User, UserRole
from app.modules.zoom.models import ZoomMeeting, ZoomMeetingStatus
from app.modules.zoom.retry_poller import _poll_cycle
from app.modules.zoom.zoom_client import ZoomAPIError
from tests.helpers import auth_headers, login_user

PRACTICES_URL = "/api/v1/practices"

_TID_RANGE = "SELECT id FROM users WHERE telegram_id BETWEEN 79100 AND 79199"
_MASTER_RANGE = "SELECT id FROM users WHERE telegram_id BETWEEN 79100 AND 79120"

_CLEANUP_QUERIES = [
    text(
        "DELETE FROM zoom_meetings WHERE practice_id IN "
        "(SELECT id FROM practices WHERE master_id IN (" + _MASTER_RANGE + "))"
    ),
    text("DELETE FROM practices WHERE master_id IN (" + _MASTER_RANGE + ")"),
    text("DELETE FROM master_profiles WHERE user_id IN (" + _TID_RANGE + ")"),
    text(
        "UPDATE users SET role = 'user' "
        "WHERE telegram_id BETWEEN 79100 AND 79199"
    ),
]


async def _full_cleanup(db_session: AsyncSession) -> None:
    for stmt in _CLEANUP_QUERIES:
        await db_session.execute(stmt)
    await db_session.commit()


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await _full_cleanup(db_session)
    yield
    await _full_cleanup(db_session)


async def _make_verified_master(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int = 79101,
) -> dict:
    user_data = await login_user(
        client, telegram_id=telegram_id, first_name="SeriesMaster",
    )
    user_id = user_data["user"]["id"]
    user = (
        await db_session.execute(select(User).where(User.id == user_id))
    ).scalar_one()
    user.role = UserRole.MASTER.value
    await db_session.flush()
    db_session.add(
        MasterProfile(
            user_id=UUID(user_id), data={"account": {"status": "verified"}},
        )
    )
    await db_session.commit()
    return user_data


def _series_body(recurrence: dict) -> dict:
    return {
        "practice_type": "series",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Zoom Series Test",
        "scheduled_at": (
            datetime.now(timezone.utc) + timedelta(days=8)
        ).isoformat(),
        "duration_minutes": 60,
        "timezone": "UTC",
        "is_free": True,
        "price_cents": 0,
        "currency": "eur",
        "recurrence": recurrence,
    }


async def _publish_series(
    client: AsyncClient,
    master: dict,
    recurrence: dict,
    session: AsyncSession,
) -> tuple[str, list[str]]:
    """Create + publish a series, return (root_id, child_ids). Children are
    read directly from the DB (not the list endpoint) -- the same reliable
    approach the original version of this file used."""
    create_resp = await client.post(
        PRACTICES_URL,
        json=_series_body(recurrence),
        headers=auth_headers(master["session_token"]),
    )
    assert create_resp.status_code == 201, create_resp.text
    root_id = create_resp.json()["id"]

    patch_resp = await client.patch(
        f"{PRACTICES_URL}/{root_id}",
        json={"status": "scheduled"},
        headers=auth_headers(master["session_token"]),
    )
    assert patch_resp.status_code == 200, patch_resp.text

    child_ids = (
        await session.execute(
            select(Practice.id).where(Practice.parent_practice_id == UUID(root_id))
        )
    ).scalars().all()
    return root_id, [str(c) for c in child_ids]


@pytest.mark.asyncio
async def test_series_publish_makes_exactly_one_zoom_call_for_the_root_only(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """ПРОМТ №559: publishing an N-occurrence series must call Zoom's
    create_meeting exactly ONCE in-request (the root -- always the nearest
    occurrence, since children are only ever later dates). Every child gets
    a ZoomMeeting row, but at status=pending_creation with ZERO Zoom calls
    made for it during publish -- this is the whole fix for the duplicate-
    series incident (a ~29-call sequential loop inside one request).
    """
    master = await _make_verified_master(client, db_session)

    # after_count=4 -> root + 3 children (daily).
    recurrence = {"period": "daily", "end": "after_count", "count": 4}

    call_count = {"n": 0}
    real_create_meeting = None

    async def _counting_create_meeting(**kwargs):
        call_count["n"] += 1
        nonlocal real_create_meeting
        if real_create_meeting is None:
            from app.modules.zoom.zoom_client import create_meeting as real_fn
            real_create_meeting = real_fn
        return await real_create_meeting(**kwargs)

    with patch(
        "app.modules.zoom.service.create_meeting", side_effect=_counting_create_meeting,
    ):
        root_id, child_ids = await _publish_series(client, master, recurrence, db_session)

    assert len(child_ids) == 3, "expected 3 generated children"
    assert call_count["n"] == 1, (
        f"expected exactly ONE synchronous Zoom call (the root), got {call_count['n']} -- "
        "a series publish must never make one Zoom call per child in-request"
    )

    all_practice_ids = [UUID(root_id)] + [UUID(c) for c in child_ids]
    zoom_meetings = {
        m.practice_id: m
        for m in (
            await db_session.execute(
                select(ZoomMeeting).where(ZoomMeeting.practice_id.in_(all_practice_ids))
            )
        ).scalars().all()
    }
    assert len(zoom_meetings) == 4, (
        "every practice in the series (root + each child) must get its own "
        "ZoomMeeting row -- the series hole (ПРОМТ №520) stays closed"
    )
    assert zoom_meetings[UUID(root_id)].status == ZoomMeetingStatus.ACTIVE.value, (
        "the root's meeting is created synchronously during publish, same as "
        "any non-series practice -- unchanged by this prompt"
    )
    for child_id in child_ids:
        assert zoom_meetings[UUID(child_id)].status == ZoomMeetingStatus.PENDING_CREATION.value, (
            "a fresh child must read as DEFERRED, never as a failure -- "
            "requirement A: a master looking at a fresh series must not see "
            "anything that looks like an error"
        )
        assert zoom_meetings[UUID(child_id)].retry_count == 0


@pytest.mark.asyncio
async def test_poller_creates_pending_children_one_failure_does_not_abort_others(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The retry poller must pick up EVERY pending_creation child (not just
    create_failed ones) and make its first Zoom attempt -- a failure on one
    child must not stop the poller from succeeding on the others, mirroring
    this file's original guarantee (ПРОМТ №520), now verified at the poller
    level instead of the publish level.
    """
    master = await _make_verified_master(client, db_session, telegram_id=79102)
    recurrence = {"period": "daily", "end": "after_count", "count": 4}
    root_id, child_ids = await _publish_series(client, master, recurrence, db_session)
    assert len(child_ids) == 3

    call_count = {"n": 0}
    real_create_meeting = None

    async def _flaky_create_meeting(**kwargs):
        call_count["n"] += 1
        if call_count["n"] == 2:
            raise ZoomAPIError("simulated outage", status_code=500, body="down")
        nonlocal real_create_meeting
        if real_create_meeting is None:
            from app.modules.zoom.zoom_client import create_meeting as real_fn
            real_create_meeting = real_fn
        return await real_create_meeting(**kwargs)

    with patch(
        "app.modules.zoom.retry_poller.create_meeting", side_effect=_flaky_create_meeting,
    ):
        work_done = await _poll_cycle()

    assert work_done is True

    zoom_meetings = (
        await db_session.execute(
            select(ZoomMeeting).where(
                ZoomMeeting.practice_id.in_([UUID(c) for c in child_ids])
            )
        )
    ).scalars().all()
    assert len(zoom_meetings) == 3
    statuses = [m.status for m in zoom_meetings]
    assert statuses.count(ZoomMeetingStatus.CREATE_FAILED.value) == 1, (
        "exactly the one simulated failure should be create_failed"
    )
    assert statuses.count(ZoomMeetingStatus.ACTIVE.value) == 2, (
        "the other two children must have succeeded despite the failure in "
        "between -- one bad Zoom call must not abort the poller's whole batch"
    )
    failed_row = next(
        m for m in zoom_meetings if m.status == ZoomMeetingStatus.CREATE_FAILED.value
    )
    assert failed_row.last_sync_error is not None
    assert "500" in failed_row.last_sync_error
    for row in zoom_meetings:
        assert row.retry_count == 1, "first attempt, not a retry -- still increments once"


@pytest.mark.asyncio
async def test_duplicate_series_submit_creates_no_second_series(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """ПРОМТ №559 (requirement B): submitting the SAME series twice within
    the dedup window (master_id + title + scheduled_at + recurrence, all
    identical -- exactly the retry-after-perceived-timeout shape MEASURED
    on prod) must create exactly one series, not two. create_practice
    returns the EXISTING root unchanged on the second call; the frontend
    skips the redundant publish PATCH when the returned practice is already
    'scheduled' (CreatePracticeView.vue) -- but this test exercises the
    BACKEND guarantee directly: even a second raw POST + PATCH (simulating
    a client that retries the whole flow, not just the frontend's own
    early-exit) must not multiply anything.
    """
    master = await _make_verified_master(client, db_session, telegram_id=79103)
    recurrence = {"period": "daily", "end": "after_count", "count": 4}
    body = _series_body(recurrence)

    first_create = await client.post(
        PRACTICES_URL, json=body, headers=auth_headers(master["session_token"]),
    )
    assert first_create.status_code == 201, first_create.text
    first_id = first_create.json()["id"]
    first_publish = await client.patch(
        f"{PRACTICES_URL}/{first_id}",
        json={"status": "scheduled"},
        headers=auth_headers(master["session_token"]),
    )
    assert first_publish.status_code == 200, first_publish.text

    # Second submit: identical body, well inside the window.
    second_create = await client.post(
        PRACTICES_URL, json=body, headers=auth_headers(master["session_token"]),
    )
    assert second_create.status_code == 201, second_create.text
    second_id = second_create.json()["id"]
    assert second_id == first_id, (
        "a duplicate submit must return the EXISTING root's id, not create a new one"
    )
    assert second_create.json()["status"] == "scheduled", (
        "the returned practice is the ALREADY-published one -- the frontend "
        "uses this to skip a redundant publish PATCH"
    )

    # A client that retries the whole flow regardless (not just the frontend's
    # own early-exit) still must not multiply anything: publishing the SAME
    # (already-scheduled) id again is a no-op at the series-generation layer
    # (generate_series_occurrences' own pre-existing idempotency guard).
    second_publish = await client.patch(
        f"{PRACTICES_URL}/{second_id}",
        json={"status": "scheduled"},
        headers=auth_headers(master["session_token"]),
    )
    assert second_publish.status_code == 400, (
        "scheduled -> scheduled is not a valid transition -- proves the "
        "second call never reached series generation a second time either"
    )

    all_roots = (
        await db_session.execute(
            select(Practice.id).where(
                Practice.master_id == UUID(master["user"]["id"]),
                Practice.parent_practice_id.is_(None),
            )
        )
    ).scalars().all()
    assert len(all_roots) == 1, "exactly one series root must exist after both submits"

    all_children = (
        await db_session.execute(
            select(Practice.id).where(Practice.parent_practice_id == UUID(first_id))
        )
    ).scalars().all()
    assert len(all_children) == 3, (
        "still exactly 3 children -- generate_series_occurrences never ran twice"
    )
