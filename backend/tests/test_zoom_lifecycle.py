# =============================================================================
# Tests: Zoom Meeting Lifecycle (E21 step D, ПРОМТ №519)
# =============================================================================
#
# telegram_id range: 79000-79099
#   79001-79020: masters
#   79021-79099: regular users (unused so far, reserved)
#
# ⚠ BACKEND-ONLY, UNPROVEN LOCALLY -- there is no docker/postgres available in
# this environment (per [[velo_testing]]). These tests were written to be
# read and were exercised via `pytest --collect-only` (import/collection
# succeeds) but never actually RUN against a live database -- collection
# success is NOT the same as passing. See the ГОТОВО report for exactly
# what was and wasn't observed.
#
# STUB MODE: no real Zoom credentials exist in any test environment, so
# settings.is_zoom_stub is True by default here and zoom_client._request()
# always returns deterministic fake data (see zoom_client.py) without a
# network call. Tests that need a FAILURE path mock zoom.service's
# zoom_client-level function directly (create_meeting / patch_meeting /
# list_registrants) to raise ZoomAPIError, since stub mode itself always
# "succeeds".
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus
from app.modules.users.models import User, UserRole
from app.modules.zoom.models import (
    ZoomMeeting,
    ZoomMeetingStatus,
    ZoomRegistrant,
    ZoomRegistrantRole,
    ZoomRegistrantStatus,
)
from app.modules.zoom.retry_poller import _poll_cycle
from app.modules.zoom.zoom_client import ZoomAPIError
from tests.helpers import auth_headers, login_user

PRACTICES_URL = "/api/v1/practices"


# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

_TID_RANGE = "SELECT id FROM users WHERE telegram_id BETWEEN 79000 AND 79099"
_MASTER_RANGE = "SELECT id FROM users WHERE telegram_id BETWEEN 79000 AND 79020"

_CLEANUP_QUERIES = [
    text(
        "DELETE FROM zoom_attendance_segments WHERE zoom_meeting_id IN "
        "(SELECT id FROM zoom_meetings WHERE practice_id IN "
        "(SELECT id FROM practices WHERE master_id IN (" + _MASTER_RANGE + ")))"
    ),
    text(
        "DELETE FROM zoom_registrants WHERE zoom_meeting_id IN "
        "(SELECT id FROM zoom_meetings WHERE practice_id IN "
        "(SELECT id FROM practices WHERE master_id IN (" + _MASTER_RANGE + ")))"
    ),
    text(
        "DELETE FROM zoom_meetings WHERE practice_id IN "
        "(SELECT id FROM practices WHERE master_id IN (" + _MASTER_RANGE + "))"
    ),
    text("DELETE FROM bookings WHERE user_id IN (" + _TID_RANGE + ")"),
    text("DELETE FROM practices WHERE master_id IN (" + _MASTER_RANGE + ")"),
    text("DELETE FROM master_profiles WHERE user_id IN (" + _TID_RANGE + ")"),
    text(
        "UPDATE users SET role = 'user' "
        "WHERE telegram_id BETWEEN 79000 AND 79099"
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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int = 79001,
) -> dict:
    user_data = await login_user(
        client, telegram_id=telegram_id, first_name="ZoomMaster",
    )
    user_id = user_data["user"]["id"]

    user = (
        await db_session.execute(select(User).where(User.id == user_id))
    ).scalar_one()
    user.role = UserRole.MASTER.value
    await db_session.flush()

    db_session.add(
        MasterProfile(
            user_id=UUID(user_id),
            data={"account": {"status": "verified"}},
        )
    )
    await db_session.commit()
    return user_data


async def _create_draft_practice(
    client: AsyncClient,
    master_data: dict,
    *,
    hours_ahead: int = 168,
) -> str:
    body = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Zoom Lifecycle Test Practice",
        "scheduled_at": (
            datetime.now(timezone.utc) + timedelta(hours=hours_ahead)
        ).isoformat(),
        "duration_minutes": 60,
        "timezone": "UTC",
        "is_free": True,
        "price_cents": 0,
        "currency": "eur",
    }
    resp = await client.post(
        PRACTICES_URL, json=body, headers=auth_headers(master_data["session_token"]),
    )
    assert resp.status_code == 201
    return resp.json()["id"]


async def _publish(client: AsyncClient, master_data: dict, practice_id: str):
    return await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"status": "scheduled"},
        headers=auth_headers(master_data["session_token"]),
    )


async def _get_zoom_meeting(
    db_session: AsyncSession, practice_id: str,
) -> ZoomMeeting | None:
    return (
        await db_session.execute(
            select(ZoomMeeting).where(ZoomMeeting.practice_id == UUID(practice_id))
        )
    ).scalar_one_or_none()


# ===================================================================
# 1. Publish always succeeds -- Zoom failure recorded, never raised
# ===================================================================


@pytest.mark.asyncio
async def test_publish_succeeds_when_zoom_create_fails(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """PATCH draft->scheduled returns 2xx even when create_meeting raises.

    Catches: a practice becoming silently unpublishable because a third
    party (Zoom) is unreachable -- the exact failure the design forbids
    (E21 plan sec 2, confirmed ПРОМТ №519 amendment 2).
    """
    master = await _make_verified_master(client, db_session, telegram_id=79001)
    practice_id = await _create_draft_practice(client, master)

    with patch(
        "app.modules.zoom.service.create_meeting",
        side_effect=ZoomAPIError("simulated outage", status_code=503, body="down"),
    ):
        resp = await _publish(client, master, practice_id)

    assert resp.status_code == 200
    assert resp.json()["status"] == PracticeStatus.SCHEDULED.value

    zoom_meeting = await _get_zoom_meeting(db_session, practice_id)
    assert zoom_meeting is not None
    assert zoom_meeting.status == ZoomMeetingStatus.CREATE_FAILED.value
    assert zoom_meeting.last_sync_error is not None
    assert "503" in zoom_meeting.last_sync_error


@pytest.mark.asyncio
async def test_publish_records_active_meeting_on_zoom_success(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Sanity check for the happy path (stub mode succeeds by default):
    publish creates an ACTIVE ZoomMeeting row with Zoom's returned ids."""
    master = await _make_verified_master(client, db_session, telegram_id=79002)
    practice_id = await _create_draft_practice(client, master)

    resp = await _publish(client, master, practice_id)
    assert resp.status_code == 200

    zoom_meeting = await _get_zoom_meeting(db_session, practice_id)
    assert zoom_meeting is not None
    assert zoom_meeting.status == ZoomMeetingStatus.ACTIVE.value
    assert zoom_meeting.zoom_meeting_id is not None


# ===================================================================
# 2. Cancel a practice whose Zoom meeting never created -- no crash
# ===================================================================


@pytest.mark.asyncio
async def test_cancel_does_not_break_when_zoom_meeting_create_failed(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Cancelling a practice whose ZoomMeeting is still create_failed (Zoom
    was down at publish time) does not break the refund/cancel flow.

    Catches: delete_meeting_for_practice assuming an active meeting exists
    and raising / blocking cancellation when it doesn't.
    """
    master = await _make_verified_master(client, db_session, telegram_id=79003)
    practice_id = await _create_draft_practice(client, master)

    with patch(
        "app.modules.zoom.service.create_meeting",
        side_effect=ZoomAPIError("simulated outage", status_code=500, body="down"),
    ):
        resp = await _publish(client, master, practice_id)
    assert resp.status_code == 200

    zoom_meeting = await _get_zoom_meeting(db_session, practice_id)
    assert zoom_meeting.status == ZoomMeetingStatus.CREATE_FAILED.value

    with patch("app.modules.zoom.service.delete_meeting") as mock_delete:
        resp = await client.post(
            f"{PRACTICES_URL}/{practice_id}/cancel",
            json={},
            headers=auth_headers(master["session_token"]),
        )
        # delete_meeting must never be called for a non-active meeting.
        mock_delete.assert_not_called()

    assert resp.status_code == 200
    assert resp.json()["status"] == PracticeStatus.CANCELLED.value


# ===================================================================
# 3. Reschedule re-fetches and overwrites stored join links
# ===================================================================


@pytest.mark.asyncio
async def test_reschedule_refetches_and_overwrites_join_url(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """After a scheduled_at PATCH, stored registrant join_url is overwritten
    with whatever Zoom's registrant list currently returns.

    Catches: the self-healing reschedule design silently not running, which
    would leave a possibly-stale join_url in place with no way to tell
    (the whole reason this shape was chosen over resolving the survives-
    reschedule question up front -- E21 plan sec 2).

    FIXED (ПРОМТ №525): this test used to INSERT a second, manually-built
    ZoomRegistrant row here to play the part of "the stored registrant with
    a stale join_url" -- but `_publish` above already creates the REAL host
    registrant via ensure_host_registrant (E21 step E), for the SAME
    (zoom_meeting_id, user_id) pair. The second insert therefore collided
    with uq_zoom_registrant_meeting_user_active every time this test ran
    for real (never executed locally before this fix -- see the module
    docstring), which is exactly the IntegrityError that broke the deploy
    battery. Mutating the real row in place (simulating that ITS join_url
    has gone stale) exercises the same reschedule-refetch behavior without
    a second insert.
    """
    master = await _make_verified_master(client, db_session, telegram_id=79004)
    practice_id = await _create_draft_practice(client, master, hours_ahead=48)

    resp = await _publish(client, master, practice_id)
    assert resp.status_code == 200
    zoom_meeting = await _get_zoom_meeting(db_session, practice_id)
    assert zoom_meeting.status == ZoomMeetingStatus.ACTIVE.value

    # Mutate the REAL host registrant (created by _publish above) to look
    # stale, instead of inserting a second row for the same (meeting, user).
    stale_registrant = (
        await db_session.execute(
            select(ZoomRegistrant).where(
                ZoomRegistrant.zoom_meeting_id == zoom_meeting.id,
                ZoomRegistrant.role == ZoomRegistrantRole.HOST.value,
            )
        )
    ).scalar_one()
    stale_registrant.zoom_registrant_id = "remote-reg-1"
    stale_registrant.registration_email = "stale@example.com"
    stale_registrant.join_url = "https://zoom.us/w/stale?tk=old"
    await db_session.commit()

    with (
        patch("app.modules.zoom.service.patch_meeting") as mock_patch,
        patch(
            "app.modules.zoom.service.list_registrants",
            return_value=[
                {
                    "registrant_id": "remote-reg-1",
                    "join_url": "https://zoom.us/w/fresh?tk=new",
                }
            ],
        ) as mock_list,
    ):
        resp = await client.patch(
            f"{PRACTICES_URL}/{practice_id}",
            json={
                "scheduled_at": (
                    datetime.now(timezone.utc) + timedelta(hours=72)
                ).isoformat(),
            },
            headers=auth_headers(master["session_token"]),
        )
        assert resp.status_code == 200
        mock_patch.assert_called_once()
        mock_list.assert_called_once()

    await db_session.refresh(stale_registrant)
    assert stale_registrant.join_url == "https://zoom.us/w/fresh?tk=new"


# ===================================================================
# 4. Retry poller respects its cap -- stays visibly failed past it
# ===================================================================


@pytest.mark.asyncio
async def test_retry_poller_stops_at_cap_and_stays_visibly_failed(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A create_failed ZoomMeeting at retry_count == cap is never retried
    again -- status stays create_failed, last_sync_error still readable.

    Catches: unbounded retry (its own silent-failure mode per E21 plan) OR
    the row being silently abandoned with no trace of why once the cap is
    hit.
    """
    master = await _make_verified_master(client, db_session, telegram_id=79005)
    practice_id = await _create_draft_practice(client, master)

    cap = settings.zoom_meeting_create_max_retries

    zoom_meeting = ZoomMeeting(
        practice_id=UUID(practice_id),
        status=ZoomMeetingStatus.CREATE_FAILED.value,
        retry_count=cap,
        last_sync_error="pre-seeded: already at cap",
    )
    db_session.add(zoom_meeting)
    await db_session.commit()

    with patch("app.modules.zoom.retry_poller.create_meeting") as mock_create:
        work_done = await _poll_cycle()
        # At-cap row must not even be claimed, let alone retried.
        mock_create.assert_not_called()

    assert work_done is False

    await db_session.refresh(zoom_meeting)
    assert zoom_meeting.status == ZoomMeetingStatus.CREATE_FAILED.value
    assert zoom_meeting.retry_count == cap
    assert zoom_meeting.last_sync_error == "pre-seeded: already at cap"

    # Sanity: a row genuinely UNDER the cap IS claimed and retried, so the
    # above proves the cap is doing something rather than everything being
    # silently skipped.
    zoom_meeting.retry_count = cap - 1
    zoom_meeting.last_sync_error = "pre-seeded: one under cap"
    await db_session.commit()

    with patch(
        "app.modules.zoom.retry_poller.create_meeting",
        side_effect=ZoomAPIError("still down", status_code=503, body="down"),
    ) as mock_create:
        work_done = await _poll_cycle()
        mock_create.assert_called_once()

    assert work_done is True
    await db_session.refresh(zoom_meeting)
    assert zoom_meeting.retry_count == cap
    assert zoom_meeting.status == ZoomMeetingStatus.CREATE_FAILED.value
    assert "cap reached" in zoom_meeting.last_sync_error
    # Row cleanup happens via the autouse `cleanup` fixture (practice's
    # master is in the 79000-79020 range).


# ===================================================================
# 3b. SW13 (Батч B, ПРОМТ №579): a non-ZoomAPIError exception still
#     counts against the retry cap -- must not retry forever unseen
# ===================================================================


@pytest.mark.asyncio
async def test_meeting_create_generic_exception_counts_against_cap(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """attempt_zoom_meeting_create's docstring has always claimed "Never
    raises -- ZoomAPIError (and anything else) is caught" -- but the code
    only caught ZoomAPIError. A non-ZoomAPIError exception (a bug, a
    malformed response, an unwrapped network error) escaped past this
    function entirely to _retry_one's outer except, which never touches
    retry_count or row.status -- the row would be reclaimed and reattempted
    every cycle forever, uncapped, never surfacing create_failed.

    Proves the fix: a generic (non-Zoom-API) exception now counts against
    the cap exactly like a generic (non-429) ZoomAPIError failure does.
    """
    master = await _make_verified_master(client, db_session, telegram_id=79017)
    practice_id = await _create_draft_practice(client, master)

    zoom_meeting = ZoomMeeting(
        practice_id=UUID(practice_id),
        status=ZoomMeetingStatus.CREATE_FAILED.value,
        retry_count=1,
        last_sync_error="pre-seeded: first failure",
    )
    db_session.add(zoom_meeting)
    await db_session.commit()

    with patch(
        "app.modules.zoom.retry_poller.create_meeting",
        side_effect=RuntimeError("unexpected parsing bug, not a ZoomAPIError"),
    ) as mock_create:
        work_done = await _poll_cycle()
        mock_create.assert_called_once()

    assert work_done is True
    await db_session.refresh(zoom_meeting)
    assert zoom_meeting.status == ZoomMeetingStatus.CREATE_FAILED.value
    assert zoom_meeting.retry_count == 2, (
        "a non-ZoomAPIError failure must still advance retry_count -- "
        "before the fix this stayed at 1 forever, retried every cycle "
        "with no cap and no visible create_failed surfacing"
    )
    assert "unexpected" in zoom_meeting.last_sync_error


@pytest.mark.asyncio
async def test_registrant_create_generic_exception_counts_against_cap(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Same SW13 fix, registrant-creation path: a non-ZoomAPIError exception
    from create_registrant now counts against the cap instead of escaping
    _attempt_registrant_create's except clause entirely."""
    master = await _make_verified_master(client, db_session, telegram_id=79018)
    practice_id = await _create_draft_practice(client, master)

    resp = await _publish(client, master, practice_id)
    assert resp.status_code == 200
    zoom_meeting = await _get_zoom_meeting(db_session, practice_id)
    assert zoom_meeting.status == ZoomMeetingStatus.ACTIVE.value

    # ПРОМТ №583: a DISTINCT student user, not the master's own id -- _publish
    # above already created the real HOST registrant for (zoom_meeting_id,
    # master's user_id) via ensure_host_registrant, so reusing that id here
    # collides with uq_zoom_registrant_meeting_user_active.
    student = await login_user(client, telegram_id=79021, first_name="Student")
    registrant = ZoomRegistrant(
        zoom_meeting_id=zoom_meeting.id,
        user_id=UUID(student["user"]["id"]),
        booking_id=None,
        role=ZoomRegistrantRole.STUDENT.value,
        status=ZoomRegistrantStatus.CREATE_FAILED.value,
        registration_email="buggy-student@users.velo.invalid",
        retry_count=1,
        last_sync_error="pre-seeded: first failure",
    )
    db_session.add(registrant)
    await db_session.commit()

    with patch(
        "app.modules.zoom.retry_poller.create_registrant",
        side_effect=RuntimeError("unexpected parsing bug, not a ZoomAPIError"),
    ) as mock_create:
        work_done = await _poll_cycle()
        mock_create.assert_called_once()

    assert work_done is True
    await db_session.refresh(registrant)
    assert registrant.status == ZoomRegistrantStatus.CREATE_FAILED.value
    assert registrant.retry_count == 2, (
        "a non-ZoomAPIError failure must still advance retry_count on the "
        "registrant path too"
    )
    assert "unexpected" in registrant.last_sync_error


# ===================================================================
# 4a. SW6 (Батч B, ПРОМТ №579): registrant 429 leaves status untouched
# ===================================================================


@pytest.mark.asyncio
async def test_registrant_retry_429_does_not_force_create_failed(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A PENDING ZoomRegistrant whose create_registrant call comes back 429
    stays PENDING -- retry_count untouched (uncapped, same 429 exemption as
    the meeting-create path), status untouched too.

    Before this fix, _attempt_registrant_create's 429 branch set
    row.status = CREATE_FAILED even though last_sync_error in the SAME
    write says "not counted against the retry cap, retried next cycle" --
    a contradiction between the two fields on one row. The sibling
    meeting-create path (attempt_zoom_meeting_create) never touches
    row.status on 429; this pins the registrant path to the same
    discipline.
    """
    master = await _make_verified_master(client, db_session, telegram_id=79016)
    practice_id = await _create_draft_practice(client, master)

    resp = await _publish(client, master, practice_id)
    assert resp.status_code == 200
    zoom_meeting = await _get_zoom_meeting(db_session, practice_id)
    assert zoom_meeting.status == ZoomMeetingStatus.ACTIVE.value

    # ПРОМТ №583: a DISTINCT student user, not the master's own id -- _publish
    # above already created the real HOST registrant for (zoom_meeting_id,
    # master's user_id) via ensure_host_registrant, so reusing that id here
    # collides with uq_zoom_registrant_meeting_user_active.
    student = await login_user(client, telegram_id=79022, first_name="Student")
    registrant = ZoomRegistrant(
        zoom_meeting_id=zoom_meeting.id,
        user_id=UUID(student["user"]["id"]),
        booking_id=None,
        role=ZoomRegistrantRole.STUDENT.value,
        status=ZoomRegistrantStatus.PENDING.value,
        registration_email="rate-limited-student@users.velo.invalid",
        retry_count=0,
    )
    db_session.add(registrant)
    await db_session.commit()

    with patch(
        "app.modules.zoom.retry_poller.create_registrant",
        side_effect=ZoomAPIError("rate limited", status_code=429, body="too many"),
    ) as mock_create:
        work_done = await _poll_cycle()
        mock_create.assert_called_once()

    assert work_done is True
    await db_session.refresh(registrant)
    assert registrant.status == ZoomRegistrantStatus.PENDING.value, (
        "429 must leave status untouched, not force CREATE_FAILED -- "
        "contradicted last_sync_error's own 'retried next cycle' claim"
    )
    assert registrant.retry_count == 0, "429 is never counted against the cap"
    assert "rate-limited" in registrant.last_sync_error
    assert "not counted against the retry cap" in registrant.last_sync_error


# ===================================================================
# 4b. POST /{id}/zoom/retry -- master-triggered retry (A4 V2, ПРОМТ №572)
# ===================================================================

RETRY_URL = PRACTICES_URL + "/{practice_id}/zoom/retry"


@pytest.mark.asyncio
async def test_retry_endpoint_succeeds_and_flips_status_to_active(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A master clicking "Повторить" on a create_failed meeting whose
    retry_count is ALREADY AT the poller's own cap still gets a real
    attempt -- the cap only gates the poller's OWN automatic claiming, not
    this explicit action. Success flips status to active AND the response
    body's zoom_meeting_status reflects it immediately (no reload needed)."""
    master = await _make_verified_master(client, db_session, telegram_id=79012)
    practice_id = await _create_draft_practice(client, master)
    cap = settings.zoom_meeting_create_max_retries

    zoom_meeting = ZoomMeeting(
        practice_id=UUID(practice_id),
        status=ZoomMeetingStatus.CREATE_FAILED.value,
        retry_count=cap,
        last_sync_error="pre-seeded: already at cap",
    )
    db_session.add(zoom_meeting)
    await db_session.commit()

    with patch(
        "app.modules.zoom.retry_poller.create_meeting",
        return_value={"id": 999888777, "uuid": "fake-uuid", "host_id": "host-1"},
    ) as mock_create:
        resp = await client.post(
            RETRY_URL.format(practice_id=practice_id),
            headers=auth_headers(master["session_token"]),
        )
        mock_create.assert_called_once()

    assert resp.status_code == 200
    assert resp.json()["zoom_meeting_status"] == "active"

    await db_session.refresh(zoom_meeting)
    assert zoom_meeting.status == ZoomMeetingStatus.ACTIVE.value
    assert zoom_meeting.retry_count == cap + 1


@pytest.mark.asyncio
async def test_retry_endpoint_still_fails_reports_honest_state_not_500(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Zoom still down on retry: the endpoint itself must not 500 (mirrors
    attempt_zoom_meeting_create's own "never raises" contract) -- it
    succeeds at MAKING the attempt, reports the honest still-failed state,
    and last_sync_error/retry_count both advance so the master (and the
    admin's own zoom_meeting_status view) can see a fresh attempt happened."""
    master = await _make_verified_master(client, db_session, telegram_id=79013)
    practice_id = await _create_draft_practice(client, master)

    zoom_meeting = ZoomMeeting(
        practice_id=UUID(practice_id),
        status=ZoomMeetingStatus.CREATE_FAILED.value,
        retry_count=1,
        last_sync_error="pre-seeded: first failure",
    )
    db_session.add(zoom_meeting)
    await db_session.commit()

    with patch(
        "app.modules.zoom.retry_poller.create_meeting",
        side_effect=ZoomAPIError("still down", status_code=503, body="down"),
    ):
        resp = await client.post(
            RETRY_URL.format(practice_id=practice_id),
            headers=auth_headers(master["session_token"]),
        )

    assert resp.status_code == 200
    assert resp.json()["zoom_meeting_status"] == "create_failed"

    await db_session.refresh(zoom_meeting)
    assert zoom_meeting.status == ZoomMeetingStatus.CREATE_FAILED.value
    assert zoom_meeting.retry_count == 2
    assert "retry #2" in zoom_meeting.last_sync_error


@pytest.mark.asyncio
async def test_retry_endpoint_refuses_a_meeting_that_is_not_failed(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """pending_creation is already queued for the poller -- retrying it
    manually would be a second, redundant attempt racing the poller's own
    claim, not a recovery action. Honest 400, machine-readable code."""
    master = await _make_verified_master(client, db_session, telegram_id=79014)
    practice_id = await _create_draft_practice(client, master)

    zoom_meeting = ZoomMeeting(
        practice_id=UUID(practice_id),
        status=ZoomMeetingStatus.PENDING_CREATION.value,
    )
    db_session.add(zoom_meeting)
    await db_session.commit()

    resp = await client.post(
        RETRY_URL.format(practice_id=practice_id),
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 400
    assert resp.json()["error"] == "zoom_meeting_not_failed"


@pytest.mark.asyncio
async def test_retry_endpoint_404s_when_no_zoom_meeting_exists(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """An unpublished draft has no ZoomMeeting row at all -- nothing to
    retry, honest 404 rather than a 500 on the FOR UPDATE select finding
    nothing."""
    master = await _make_verified_master(client, db_session, telegram_id=79015)
    practice_id = await _create_draft_practice(client, master)

    resp = await client.post(
        RETRY_URL.format(practice_id=practice_id),
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_retry_endpoint_refuses_a_non_owner(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """P-08: a master who does not own the practice gets 404, not 403 --
    same posture as the start-ticket endpoint (test_zoom_start.py)."""
    owner = await _make_verified_master(client, db_session, telegram_id=79016)
    other = await _make_verified_master(client, db_session, telegram_id=79017)
    practice_id = await _create_draft_practice(client, owner)

    zoom_meeting = ZoomMeeting(
        practice_id=UUID(practice_id),
        status=ZoomMeetingStatus.CREATE_FAILED.value,
    )
    db_session.add(zoom_meeting)
    await db_session.commit()

    resp = await client.post(
        RETRY_URL.format(practice_id=practice_id),
        headers=auth_headers(other["session_token"]),
    )
    assert resp.status_code == 404


# ===================================================================
# 5. Publish survives a NON-ZoomAPIError failure inside the registrant
#    step too, not just a Zoom-API failure (ПРОМТ №525)
# ===================================================================


@pytest.mark.asyncio
async def test_publish_succeeds_when_host_registrant_call_raises_unexpectedly(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """"Zoom never blocks" (module docstring) is a blanket rule -- before
    ПРОМТ №525, ensure_host_registrant only caught ZoomAPIError, so ANY
    other exception raised while registering the host (a bug, a database
    conflict, anything) would propagate out of create_meeting_for_practice
    and abort the publish request that had already succeeded otherwise.
    Forces exactly that shape with a plain RuntimeError, which is NOT a
    ZoomAPIError, to prove the new outer backstop actually holds.
    """
    master = await _make_verified_master(client, db_session, telegram_id=79006)
    practice_id = await _create_draft_practice(client, master)

    with patch(
        "app.modules.zoom.service.create_registrant",
        side_effect=RuntimeError("totally unexpected, not a ZoomAPIError"),
    ):
        resp = await _publish(client, master, practice_id)

    assert resp.status_code == 200
    assert resp.json()["status"] == "scheduled"

    zoom_meeting = await _get_zoom_meeting(db_session, practice_id)
    assert zoom_meeting is not None
    assert zoom_meeting.status == ZoomMeetingStatus.ACTIVE.value, (
        "the meeting itself succeeded -- only the host-registrant call failed"
    )

    host_row = (
        await db_session.execute(
            select(ZoomRegistrant).where(
                ZoomRegistrant.zoom_meeting_id == zoom_meeting.id,
                ZoomRegistrant.role == ZoomRegistrantRole.HOST.value,
            )
        )
    ).scalar_one()
    assert host_row.status == ZoomRegistrantStatus.CREATE_FAILED.value
    assert host_row.last_sync_error is not None


# ===================================================================
# 6. ensure_host_registrant's insert survives a DB-level conflict the
#    idempotency check itself cannot see coming (ПРОМТ №525 -- the exact
#    incident shape, constructed directly instead of via a real race)
# ===================================================================


@pytest.mark.asyncio
async def test_ensure_host_registrant_survives_conflicting_row_at_insert(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """uq_zoom_registrant_meeting_user_active is scoped on (zoom_meeting_id,
    user_id) ALONE, not per role -- so a pre-existing, non-cancelled
    registrant for the master under a DIFFERENT role (student) is invisible
    to ensure_host_registrant's own existence check (which only looks for
    role='host'), yet still collides at the actual insert. This is the
    exact shape of the incident that broke the deploy battery (there, a
    test's own manual insert played the part of "the row nobody's
    idempotency check saw coming"). Must not raise, must not leave a
    second row, and the caller's session must stay usable afterward --
    calling db_session.commit() after this succeeding is itself part of
    the proof (a poisoned session would raise PendingRollbackError there).
    """
    master = await _make_verified_master(client, db_session, telegram_id=79007)
    practice_id = await _create_draft_practice(client, master)
    practice = await db_session.get(Practice, UUID(practice_id))

    zoom_meeting = ZoomMeeting(
        practice_id=practice.id,
        zoom_meeting_id="meeting-race-1",
        status=ZoomMeetingStatus.ACTIVE.value,
    )
    db_session.add(zoom_meeting)
    await db_session.flush()

    # Occupies (zoom_meeting_id, user_id=master) under role='student' --
    # a real ZoomRegistrant row ensure_host_registrant's role='host' filter
    # cannot see, exactly the gap a genuine race would exploit.
    conflicting = ZoomRegistrant(
        zoom_meeting_id=zoom_meeting.id,
        user_id=UUID(master["user"]["id"]),
        role=ZoomRegistrantRole.STUDENT.value,
        registration_email="race@example.com",
        status=ZoomRegistrantStatus.REGISTERED.value,
    )
    db_session.add(conflicting)
    await db_session.commit()

    from app.modules.zoom.service import ensure_host_registrant

    await ensure_host_registrant(zoom_meeting, practice, db_session)
    # Must not raise PendingRollbackError -- proves the savepoint, not a
    # bare try/except, is what's actually protecting this session.
    await db_session.commit()

    rows = (
        await db_session.execute(
            select(ZoomRegistrant).where(ZoomRegistrant.zoom_meeting_id == zoom_meeting.id)
        )
    ).scalars().all()
    assert len(rows) == 1, "the host insert must have been absorbed, not landed as a second row"
    assert rows[0].id == conflicting.id
    assert rows[0].role == ZoomRegistrantRole.STUDENT.value
