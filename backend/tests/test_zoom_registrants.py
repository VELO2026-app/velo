# =============================================================================
# Tests: Zoom Registrant Lifecycle (E21 step E -- ПРОМТ №520)
# =============================================================================
#
# telegram_id range: 79200-79299
#   79201-79210: masters
#   79220-79240: regular users (bookers)
#
# ⚠ BACKEND-ONLY, UNPROVEN LOCALLY -- see test_zoom_lifecycle.py's module
# docstring for the exact local blocker (pre-existing stray key in
# backend/.env, observed this session, not touched). Written to be read,
# collection-checked, never executed.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.bookings.models import Booking, BookingStatus
from app.modules.bookings.service import auto_finalize_practice
from app.modules.diary.models import DiaryEvent, DiaryEventKind
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice
from app.modules.users.models import User, UserRole
from app.modules.zoom.models import (
    ZoomMeeting,
    ZoomMeetingStatus,
    ZoomRegistrant,
    ZoomRegistrantRole,
    ZoomRegistrantStatus,
)
from app.modules.zoom.service import create_registrant_for_booking, ensure_host_registrant
from app.modules.zoom.zoom_client import ZoomAPIError
from tests.helpers import auth_headers, login_user

PRACTICES_URL = "/api/v1/practices"
BOOKINGS_URL = "/api/v1/bookings"

_TID_RANGE = "SELECT id FROM users WHERE telegram_id BETWEEN 79200 AND 79299"
_MASTER_RANGE = "SELECT id FROM users WHERE telegram_id BETWEEN 79200 AND 79210"

_CLEANUP_QUERIES = [
    text(
        "DELETE FROM zoom_registrants WHERE zoom_meeting_id IN "
        "(SELECT id FROM zoom_meetings WHERE practice_id IN "
        "(SELECT id FROM practices WHERE master_id IN (" + _MASTER_RANGE + ")))"
    ),
    text(
        "DELETE FROM zoom_meetings WHERE practice_id IN "
        "(SELECT id FROM practices WHERE master_id IN (" + _MASTER_RANGE + "))"
    ),
    # ПРОМТ №527: purchases must go before bookings -- purchases_booking_id_fkey
    # (RESTRICT) blocks deleting a booking that still has a purchase pointing at
    # it. This file is the only zoom test file that books through the real
    # /api/v1/bookings endpoint (create_booking always creates a purchase);
    # the sibling files either don't book at all or seed Booking() directly via
    # the ORM, bypassing purchase creation -- same convention as
    # test_cancellation.py's cleanup order.
    text("DELETE FROM purchases WHERE user_id IN (" + _TID_RANGE + ")"),
    # ПРОМТ №530: this file's new stub-mode-finalize test projects diary
    # practice_outcome events -- clean those up too (no FK ordering
    # constraint either way, source_id carries no ForeignKey).
    text("DELETE FROM diary_events WHERE user_id IN (" + _TID_RANGE + ")"),
    text("DELETE FROM bookings WHERE user_id IN (" + _TID_RANGE + ")"),
    text("DELETE FROM practices WHERE master_id IN (" + _MASTER_RANGE + ")"),
    text("DELETE FROM master_profiles WHERE user_id IN (" + _TID_RANGE + ")"),
    text(
        "UPDATE users SET role = 'user' "
        "WHERE telegram_id BETWEEN 79200 AND 79299"
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
    client: AsyncClient, db_session: AsyncSession, telegram_id: int = 79201,
) -> dict:
    user_data = await login_user(
        client, telegram_id=telegram_id, first_name="RegMaster",
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


async def _create_and_publish_practice(
    client: AsyncClient,
    master_data: dict,
    *,
    fail_zoom_create: bool = False,
) -> str:
    body = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Zoom Registrant Test Practice",
        "scheduled_at": (
            datetime.now(timezone.utc) + timedelta(hours=168)
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
    practice_id = resp.json()["id"]

    if fail_zoom_create:
        with patch(
            "app.modules.zoom.service.create_meeting",
            side_effect=ZoomAPIError("simulated outage", status_code=500, body="down"),
        ):
            resp = await client.patch(
                f"{PRACTICES_URL}/{practice_id}",
                json={"status": "scheduled"},
                headers=auth_headers(master_data["session_token"]),
            )
    else:
        resp = await client.patch(
            f"{PRACTICES_URL}/{practice_id}",
            json={"status": "scheduled"},
            headers=auth_headers(master_data["session_token"]),
        )
    assert resp.status_code == 200
    return practice_id


async def _book(client: AsyncClient, user_data: dict, practice_id: str) -> dict:
    return await client.post(
        BOOKINGS_URL,
        json={"practice_id": practice_id},
        headers=auth_headers(user_data["session_token"]),
    )


async def _zoom_registrant_for_booking(
    db_session: AsyncSession, booking_id: str,
) -> ZoomRegistrant | None:
    return (
        await db_session.execute(
            select(ZoomRegistrant).where(ZoomRegistrant.booking_id == UUID(booking_id))
        )
    ).scalar_one_or_none()


# ===================================================================
# 1. Booking succeeds when the meeting isn't active yet -- registrant queued
# ===================================================================


@pytest.mark.asyncio
async def test_booking_succeeds_when_meeting_not_active_registrant_queued(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Publish with a failed Zoom meeting create (meeting stays
    create_failed, never active) -- booking still returns 2xx, and the
    registrant row exists with status=pending (queued for the retry
    poller), never lost.

    Catches: booking creation silently skipping the registrant row instead
    of queuing it, which would make the row unrecoverable once the meeting
    eventually goes active (nothing left to retry).
    """
    master = await _make_verified_master(client, db_session, telegram_id=79201)
    practice_id = await _create_and_publish_practice(
        client, master, fail_zoom_create=True,
    )

    zoom_meeting = (
        await db_session.execute(
            select(ZoomMeeting).where(ZoomMeeting.practice_id == UUID(practice_id))
        )
    ).scalar_one()
    assert zoom_meeting.status == ZoomMeetingStatus.CREATE_FAILED.value

    student = await login_user(client, telegram_id=79221, first_name="Student1")
    resp = await _book(client, student, practice_id)
    assert resp.status_code == 201, resp.text
    booking_id = resp.json()["id"]

    registrant = await _zoom_registrant_for_booking(db_session, booking_id)
    assert registrant is not None, "registrant row must exist, queued not lost"
    assert registrant.status == ZoomRegistrantStatus.PENDING.value
    assert registrant.zoom_registrant_id is None
    assert registrant.role == ZoomRegistrantRole.STUDENT.value


# ===================================================================
# 2. Booking succeeds when the Zoom registrant call itself raises
# ===================================================================


@pytest.mark.asyncio
async def test_booking_succeeds_when_zoom_registrant_call_raises(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Meeting IS active, but create_registrant raises -- booking still
    returns 2xx, registrant row lands create_failed for the retry poller.
    """
    master = await _make_verified_master(client, db_session, telegram_id=79202)
    practice_id = await _create_and_publish_practice(client, master)

    student = await login_user(client, telegram_id=79222, first_name="Student2")
    with patch(
        "app.modules.zoom.service.create_registrant",
        side_effect=ZoomAPIError("simulated failure", status_code=400, body="bad"),
    ):
        resp = await _book(client, student, practice_id)
    assert resp.status_code == 201, resp.text
    booking_id = resp.json()["id"]

    registrant = await _zoom_registrant_for_booking(db_session, booking_id)
    assert registrant is not None
    assert registrant.status == ZoomRegistrantStatus.CREATE_FAILED.value
    assert registrant.last_sync_error is not None
    assert "400" in registrant.last_sync_error


# ===================================================================
# 3. Host registrant created exactly once, no booking_id
# ===================================================================


@pytest.mark.asyncio
async def test_host_registrant_created_once_no_booking_id(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Publishing creates exactly one role='host' registrant with
    booking_id=NULL. Calling ensure_host_registrant again for the same
    meeting is a no-op (idempotent) -- this is what guarantees "exactly
    once" across both the initial-success path and a later retry-poller
    success path for the same meeting.
    """
    master = await _make_verified_master(client, db_session, telegram_id=79203)
    practice_id = await _create_and_publish_practice(client, master)

    zoom_meeting = (
        await db_session.execute(
            select(ZoomMeeting).where(ZoomMeeting.practice_id == UUID(practice_id))
        )
    ).scalar_one()
    assert zoom_meeting.status == ZoomMeetingStatus.ACTIVE.value

    host_rows = (
        await db_session.execute(
            select(ZoomRegistrant).where(
                ZoomRegistrant.zoom_meeting_id == zoom_meeting.id,
                ZoomRegistrant.role == ZoomRegistrantRole.HOST.value,
            )
        )
    ).scalars().all()
    assert len(host_rows) == 1
    assert host_rows[0].booking_id is None
    assert host_rows[0].user_id == UUID(master["user"]["id"])

    # Idempotency: calling it again must not create a second host row (the
    # mechanism a later successful retry relies on for "exactly once").
    practice = await db_session.get(Practice, UUID(practice_id))
    await ensure_host_registrant(zoom_meeting, practice, db_session)
    await db_session.commit()

    host_rows_after = (
        await db_session.execute(
            select(ZoomRegistrant).where(
                ZoomRegistrant.zoom_meeting_id == zoom_meeting.id,
                ZoomRegistrant.role == ZoomRegistrantRole.HOST.value,
            )
        )
    ).scalars().all()
    assert len(host_rows_after) == 1, "must stay exactly one host registrant"


# ===================================================================
# 3b. create_registrant_for_booking is idempotent too (ПРОМТ №525 --
#     this existence check did not exist before; calling it twice for the
#     same booking used to insert a second row and violate
#     uq_zoom_registrant_meeting_user_active)
# ===================================================================


@pytest.mark.asyncio
async def test_create_registrant_for_booking_called_twice_stays_one_row(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Calling create_registrant_for_booking a second time for the SAME
    (meeting, user) pair -- e.g. a retried call for the same booking --
    must not raise and must not create a second row. Confirms the reused
    row is returned, not a fresh insert.
    """
    master = await _make_verified_master(client, db_session, telegram_id=79205)
    practice_id = await _create_and_publish_practice(client, master)

    student = await login_user(client, telegram_id=79225, first_name="Student5")
    book_resp = await _book(client, student, practice_id)
    assert book_resp.status_code == 201, book_resp.text
    booking_id = book_resp.json()["id"]

    registrant = await _zoom_registrant_for_booking(db_session, booking_id)
    assert registrant is not None
    assert registrant.status == ZoomRegistrantStatus.REGISTERED.value

    booking = await db_session.get(Booking, UUID(booking_id))
    user = await db_session.get(User, UUID(student["user"]["id"]))

    result = await create_registrant_for_booking(booking, user, db_session)
    await db_session.commit()

    assert result is not None
    assert result.id == registrant.id, "must reuse the existing row, not insert a second one"

    rows = (
        await db_session.execute(
            select(ZoomRegistrant).where(ZoomRegistrant.zoom_meeting_id == registrant.zoom_meeting_id)
        )
    ).scalars().all()
    student_rows = [r for r in rows if r.role == ZoomRegistrantRole.STUDENT.value]
    assert len(student_rows) == 1, "must stay exactly one student registrant for this user"


# ===================================================================
# 3c. Regression pin (ПРОМТ №530): stub mode must not defer attendance
# ===================================================================


@pytest.mark.asyncio
async def test_finalize_decides_immediately_in_stub_mode_no_deferral(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A stub-mode "active" meeting can never produce a real Zoom report --
    treating it as Zoom-tracked would defer attendance for the full
    settings.zoom_attendance_decision_deadline_minutes (120) before the
    deadline fallback finally decided it. Relies on the suite's stub-mode
    pin (conftest.py, ПРОМТ №543), not on any server's actual credential
    state. Pins the fix directly: the ZoomMeeting row IS still created and
    ACTIVE (stub mode's normal, unchanged behavior -- see
    test_host_registrant_created_once_no_booking_id above), but finalize
    must decide attendance IMMEDIATELY via the legacy proxy anyway, and
    project the diary outcome right away -- no deferral.
    """
    master = await _make_verified_master(client, db_session, telegram_id=79206)
    practice_id = await _create_and_publish_practice(client, master)

    zoom_meeting = (
        await db_session.execute(
            select(ZoomMeeting).where(ZoomMeeting.practice_id == UUID(practice_id))
        )
    ).scalar_one()
    assert zoom_meeting.status == ZoomMeetingStatus.ACTIVE.value, (
        "stub mode still creates a normal, active meeting -- only the "
        "attendance decision treats it as untracked"
    )

    attendee = await login_user(client, telegram_id=79226, first_name="Student6")
    absentee = await login_user(client, telegram_id=79227, first_name="Student7")

    att_resp = await _book(client, attendee, practice_id)
    assert att_resp.status_code == 201, att_resp.text
    att_booking_id = att_resp.json()["id"]

    abs_resp = await _book(client, absentee, practice_id)
    assert abs_resp.status_code == 201, abs_resp.text
    abs_booking_id = abs_resp.json()["id"]

    join_resp = await client.post(
        f"{BOOKINGS_URL}/{att_booking_id}/join",
        headers=auth_headers(attendee["session_token"]),
    )
    assert join_resp.status_code == 200, join_resp.text

    await auto_finalize_practice(UUID(practice_id), db_session)
    await db_session.commit()

    att_booking = await db_session.get(Booking, UUID(att_booking_id))
    abs_booking = await db_session.get(Booking, UUID(abs_booking_id))
    assert att_booking.status == BookingStatus.ATTENDED.value, (
        "must be decided immediately, not left CONFIRMED pending a Zoom report"
    )
    assert abs_booking.status == BookingStatus.NO_SHOW.value

    outcome_events = (
        await db_session.execute(
            select(DiaryEvent).where(
                DiaryEvent.user_id.in_(
                    [UUID(attendee["user"]["id"]), UUID(absentee["user"]["id"])],
                ),
                DiaryEvent.kind == DiaryEventKind.PRACTICE_OUTCOME.value,
            )
        )
    ).scalars().all()
    assert len(outcome_events) == 2, "diary outcome must project immediately, not deferred"


# ===================================================================
# 4. Cancelling a booking marks our row cancelled even if Zoom fails
# ===================================================================


@pytest.mark.asyncio
async def test_cancel_booking_marks_registrant_cancelled_even_when_zoom_fails(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Our row's status is the sole authority (E21 design): even when the
    Zoom registrant-status-update call raises, cancelling the booking still
    marks our ZoomRegistrant row cancelled and the booking cancel itself
    still succeeds.
    """
    master = await _make_verified_master(client, db_session, telegram_id=79204)
    practice_id = await _create_and_publish_practice(client, master)

    student = await login_user(client, telegram_id=79224, first_name="Student4")
    book_resp = await _book(client, student, practice_id)
    assert book_resp.status_code == 201
    booking_id = book_resp.json()["id"]

    registrant = await _zoom_registrant_for_booking(db_session, booking_id)
    assert registrant is not None
    assert registrant.status == ZoomRegistrantStatus.REGISTERED.value
    assert registrant.zoom_registrant_id is not None

    with patch(
        "app.modules.zoom.service.update_registrant_status",
        side_effect=ZoomAPIError("simulated failure", status_code=500, body="down"),
    ):
        cancel_resp = await client.delete(
            f"{BOOKINGS_URL}/{booking_id}",
            headers=auth_headers(student["session_token"]),
        )
    assert cancel_resp.status_code == 200, cancel_resp.text

    await db_session.refresh(registrant)
    assert registrant.status == ZoomRegistrantStatus.CANCELLED.value


# ===================================================================
# 5. A participant's join_url stops being handed out once the meeting is
#    gone (ПРОМТ №563) -- the registrant row itself is never touched when a
#    meeting is deleted outside the normal cancel flow (see
#    zoom/service.get_host_join_url's own docstring), so the list endpoints
#    must consult ZoomMeeting.status themselves, same as the host path.
# ===================================================================


@pytest.mark.asyncio
async def test_participant_join_url_hidden_once_meeting_deleted(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A booked student's join_url is real while the meeting is ACTIVE, then
    disappears from both list_user_bookings and list_upcoming_bookings the
    moment the meeting's status moves off ACTIVE (here: DELETED, simulating
    the meeting vanishing outside bookings/service.py's own cancel_booking
    flow) -- even though the ZoomRegistrant row's own join_url is untouched
    and still non-NULL. Before this fix, bookings/service.py's two list
    queries filtered only on ZoomRegistrant.status/join_url and never joined
    ZoomMeeting at all, so a stale link kept being served.
    """
    from app.modules.bookings.service import list_upcoming_bookings, list_user_bookings

    master = await _make_verified_master(client, db_session, telegram_id=79207)
    practice_id = await _create_and_publish_practice(client, master)

    student = await login_user(client, telegram_id=79228, first_name="Student8")
    book_resp = await _book(client, student, practice_id)
    assert book_resp.status_code == 201, book_resp.text
    booking_id = book_resp.json()["id"]

    registrant = await _zoom_registrant_for_booking(db_session, booking_id)
    assert registrant is not None
    assert registrant.status == ZoomRegistrantStatus.REGISTERED.value
    assert registrant.join_url is not None, "stub mode must still issue a join_url"

    student_user = await db_session.get(User, UUID(student["user"]["id"]))

    # -- Baseline: meeting still ACTIVE, the real link is served. --
    items, _total = await list_user_bookings(student_user, db_session)
    row = next(r for r in items if str(r[0].id) == booking_id)
    assert row[4] == registrant.join_url

    upcoming = await list_upcoming_bookings(student_user, db_session)
    upcoming_row = next(r for r in upcoming if str(r[0].id) == booking_id)
    assert upcoming_row[4] == registrant.join_url

    # -- Meeting vanishes outside the normal cancel flow. The registrant row
    # (and its join_url) is deliberately left untouched -- that is the exact
    # shape get_host_join_url's docstring describes for the host side. --
    zoom_meeting = (
        await db_session.execute(
            select(ZoomMeeting).where(ZoomMeeting.practice_id == UUID(practice_id))
        )
    ).scalar_one()
    zoom_meeting.status = ZoomMeetingStatus.DELETED.value
    await db_session.commit()
    await db_session.refresh(registrant)
    assert registrant.join_url is not None, (
        "sanity: the registrant row itself is untouched by the meeting going away"
    )

    items, _total = await list_user_bookings(student_user, db_session)
    row = next(r for r in items if str(r[0].id) == booking_id)
    assert row[4] is None, "a dead link must not be handed to the participant"

    upcoming = await list_upcoming_bookings(student_user, db_session)
    upcoming_row = next(r for r in upcoming if str(r[0].id) == booking_id)
    assert upcoming_row[4] is None, "same gate on the dashboard's nearest-practice widget"
