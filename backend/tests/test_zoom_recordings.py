# =============================================================================
# Tests: Watch-recording link for a past practice (REC-1, ПРОМТ №618)
# =============================================================================
#
# telegram_id range: 99400-99499
#   99401-99410: masters
#   99420-99499: regular users (students)
#
# ⚠ BACKEND-ONLY, UNPROVEN LOCALLY -- see test_zoom_lifecycle.py's module
# docstring for the exact local blocker (no docker/postgres available in
# this environment, [[velo_testing]]). The HTTP-level tests below were
# written to be read and collection-checked (`pytest --collect-only`), never
# executed against a live database. The pure-predicate tests in the first
# section have NO such caveat -- they touch no session and no client, and
# WERE actually run locally (see the report for exactly what was executed).
#
# STUB MODE: settings.is_zoom_stub is True by default in tests, so
# zoom_client._request() returns deterministic fake data (zoom_client.py's
# _stub_response) with no network call. GET .../recordings in stub mode
# always "succeeds" with a fixed share_url + recording_play_passcode -- the
# 404 (unavailable) and non-404 (error) paths are exercised by mocking
# zoom.service.get_meeting_recordings directly, same technique
# test_zoom_start.py uses for get_meeting's failure path.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from unittest.mock import patch
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.bookings.models import Booking, BookingStatus
from app.modules.bookings.service import is_booking_recording_eligible
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from app.modules.zoom.models import ZoomMeeting, ZoomMeetingStatus
from app.modules.zoom.zoom_client import ZoomAPIError
from tests.helpers import auth_headers, login_user

BOOKINGS_URL = "/api/v1/bookings"

_TID_MIN = 99400
_TID_MAX = 99499


# ---------------------------------------------------------------------------
# 1. Pure predicate -- no DB, no client, actually runnable without Postgres
# ---------------------------------------------------------------------------


def _booking(status: str) -> Booking:
    b = Booking()
    b.status = status
    return b


def _practice(status: str) -> Practice:
    p = Practice()
    p.status = status
    return p


def test_confirmed_and_completed_is_eligible():
    assert is_booking_recording_eligible(
        _booking(BookingStatus.CONFIRMED.value),
        _practice(PracticeStatus.COMPLETED.value),
    )


def test_no_show_is_eligible_same_as_attended():
    """Owner ruling (REC-1): entitlement is the BOOKING, never attendance --
    a no_show gets the exact same access as an attended booking."""
    assert is_booking_recording_eligible(
        _booking(BookingStatus.NO_SHOW.value),
        _practice(PracticeStatus.COMPLETED.value),
    )
    assert is_booking_recording_eligible(
        _booking(BookingStatus.ATTENDED.value),
        _practice(PracticeStatus.COMPLETED.value),
    )


def test_pending_is_not_eligible():
    assert not is_booking_recording_eligible(
        _booking(BookingStatus.PENDING.value),
        _practice(PracticeStatus.COMPLETED.value),
    )


def test_cancelled_is_not_eligible():
    assert not is_booking_recording_eligible(
        _booking(BookingStatus.CANCELLED.value),
        _practice(PracticeStatus.COMPLETED.value),
    )


def test_confirmed_but_practice_not_completed_is_not_eligible():
    assert not is_booking_recording_eligible(
        _booking(BookingStatus.CONFIRMED.value),
        _practice(PracticeStatus.SCHEDULED.value),
    )


# ---------------------------------------------------------------------------
# 2. HTTP-level -- requires a live database, collection-checked only
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await _do_cleanup(db_session)
    yield
    await _do_cleanup(db_session)


async def _do_cleanup(session: AsyncSession) -> None:
    await session.rollback()
    subq = select(User.id).where(User.telegram_id.between(_TID_MIN, _TID_MAX))
    await session.execute(
        text(
            "DELETE FROM zoom_meetings WHERE practice_id IN "
            "(SELECT id FROM practices WHERE master_id IN "
            f"(SELECT id FROM users WHERE telegram_id BETWEEN {_TID_MIN} AND {_TID_MAX}))"
        )
    )
    await session.execute(MasterProfile.__table__.delete().where(MasterProfile.user_id.in_(subq)))
    await session.execute(
        text(
            "DELETE FROM bookings WHERE user_id IN "
            f"(SELECT id FROM users WHERE telegram_id BETWEEN {_TID_MIN} AND {_TID_MAX})"
        )
    )
    await session.execute(
        text(
            "DELETE FROM practices WHERE master_id IN "
            f"(SELECT id FROM users WHERE telegram_id BETWEEN {_TID_MIN} AND {_TID_MAX})"
        )
    )
    from app.core.audit import AuditLog
    await session.execute(AuditLog.__table__.delete().where(AuditLog.actor_id.in_(subq)))
    await session.execute(
        User.__table__.delete().where(User.telegram_id.between(_TID_MIN, _TID_MAX))
    )
    await session.commit()


async def _make_master(client: AsyncClient, db_session: AsyncSession, telegram_id: int) -> UUID:
    auth = await login_user(client, telegram_id=telegram_id, first_name="RecMaster")
    user_id = auth["user"]["id"]
    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER
    await db_session.flush()
    db_session.add(
        MasterProfile(
            user_id=user_id,
            data={"account": {"status": "verified"}, "profile": {"display_name": "RecMaster"}},
        )
    )
    await db_session.flush()
    return user.id


async def _create_practice(
    db_session: AsyncSession, master_id: UUID, *,
    status: str = PracticeStatus.COMPLETED.value,
    scheduled_hours_ago: float = 2,
) -> Practice:
    practice = Practice(
        master_id=master_id,
        title="Watch Recording Test Practice",
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=status,
        scheduled_at=datetime.now(UTC) - timedelta(hours=scheduled_hours_ago),
        duration_minutes=60,
        timezone="UTC",
        max_participants=10,
        current_participants=0,
        is_free=True,
        price_cents=0,
        currency="eur",
        data={},
    )
    db_session.add(practice)
    await db_session.flush()
    return practice


async def _booking_for(
    client: AsyncClient, db_session: AsyncSession, practice: Practice,
    telegram_id: int, *, status: str = BookingStatus.CONFIRMED.value,
) -> tuple[Booking, dict]:
    auth = await login_user(client, telegram_id=telegram_id, first_name=f"U{telegram_id}")
    booking = Booking(
        practice_id=practice.id, user_id=auth["user"]["id"], status=status,
    )
    db_session.add(booking)
    await db_session.flush()
    return booking, auth


async def _active_zoom_meeting(db_session: AsyncSession, practice: Practice) -> ZoomMeeting:
    meeting = ZoomMeeting(
        practice_id=practice.id, zoom_meeting_id="rec-test-123", zoom_meeting_uuid="uuid-rec-1",
        status=ZoomMeetingStatus.ACTIVE.value,
    )
    db_session.add(meeting)
    await db_session.flush()
    return meeting


@pytest.mark.asyncio
async def test_confirmed_booking_available_stub_recording(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Happy path: confirmed booking, completed practice, ZoomMeeting with a
    real zoom_meeting_id -> stub mode's GET .../recordings returns a fixed
    share_url + recording_play_passcode -> the endpoint returns them
    combined as one link, passcode embedded via ?pwd=."""
    master_id = await _make_master(client, db_session, 99401)
    practice = await _create_practice(db_session, master_id)
    await _active_zoom_meeting(db_session, practice)
    booking, auth = await _booking_for(client, db_session, practice, 99421)
    await db_session.commit()

    resp = await client.get(
        f"{BOOKINGS_URL}/{booking.id}/recording",
        headers=auth_headers(auth["session_token"]),
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "available"
    assert body["url"] is not None
    assert "pwd=" in body["url"]


@pytest.mark.asyncio
async def test_no_show_booking_gets_same_access_over_http(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """HTTP-level counterpart of test_no_show_is_eligible_same_as_attended
    above -- proves the ruling end-to-end, not just at the predicate."""
    master_id = await _make_master(client, db_session, 99402)
    practice = await _create_practice(db_session, master_id)
    await _active_zoom_meeting(db_session, practice)
    booking, auth = await _booking_for(
        client, db_session, practice, 99422, status=BookingStatus.NO_SHOW.value,
    )
    await db_session.commit()

    resp = await client.get(
        f"{BOOKINGS_URL}/{booking.id}/recording",
        headers=auth_headers(auth["session_token"]),
    )

    assert resp.status_code == 200
    assert resp.json()["status"] == "available"


@pytest.mark.asyncio
async def test_other_users_booking_is_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """P-08: a booking that isn't the caller's own is 404, not 403 --
    doesn't reveal whether the booking exists."""
    master_id = await _make_master(client, db_session, 99403)
    practice = await _create_practice(db_session, master_id)
    await _active_zoom_meeting(db_session, practice)
    booking, _owner_auth = await _booking_for(client, db_session, practice, 99423)
    other_auth = await login_user(client, telegram_id=99424, first_name="Other")
    await db_session.commit()

    resp = await client.get(
        f"{BOOKINGS_URL}/{booking.id}/recording",
        headers=auth_headers(other_auth["session_token"]),
    )

    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_pending_booking_is_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master_id = await _make_master(client, db_session, 99404)
    practice = await _create_practice(db_session, master_id)
    await _active_zoom_meeting(db_session, practice)
    booking, auth = await _booking_for(
        client, db_session, practice, 99426, status=BookingStatus.PENDING.value,
    )
    await db_session.commit()

    resp = await client.get(
        f"{BOOKINGS_URL}/{booking.id}/recording",
        headers=auth_headers(auth["session_token"]),
    )

    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_upcoming_practice_is_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A confirmed booking on a practice that hasn't ended yet -- the button
    shouldn't show client-side either; the API backs that with a 404, not
    an 'unavailable' status (this is an entitlement gap, not a recording-
    state one)."""
    master_id = await _make_master(client, db_session, 99405)
    practice = await _create_practice(
        db_session, master_id, status=PracticeStatus.SCHEDULED.value,
        scheduled_hours_ago=-2,
    )
    await _active_zoom_meeting(db_session, practice)
    booking, auth = await _booking_for(client, db_session, practice, 99427)
    await db_session.commit()

    resp = await client.get(
        f"{BOOKINGS_URL}/{booking.id}/recording",
        headers=auth_headers(auth["session_token"]),
    )

    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_no_zoom_meeting_row_is_unavailable_not_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A qualifying booking on a practice that never got a ZoomMeeting row
    (pre-E21 data) is a 200 'unavailable', not a 404 -- the booking IS
    entitled, Zoom just has nothing."""
    master_id = await _make_master(client, db_session, 99406)
    practice = await _create_practice(db_session, master_id)
    booking, auth = await _booking_for(client, db_session, practice, 99428)
    await db_session.commit()

    resp = await client.get(
        f"{BOOKINGS_URL}/{booking.id}/recording",
        headers=auth_headers(auth["session_token"]),
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "unavailable"
    assert body["url"] is None


@pytest.mark.asyncio
async def test_zoom_404_is_unavailable(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Zoom's own 404 (never created / still processing / already deleted
    by the 7-day retention -- deliberately not distinguished) maps to
    'unavailable', mocked at the zoom_client boundary since stub mode
    itself always succeeds."""
    master_id = await _make_master(client, db_session, 99407)
    practice = await _create_practice(db_session, master_id)
    await _active_zoom_meeting(db_session, practice)
    booking, auth = await _booking_for(client, db_session, practice, 99429)
    await db_session.commit()

    with patch(
        "app.modules.zoom.service.get_meeting_recordings",
        side_effect=ZoomAPIError("not found", status_code=404, body="none"),
    ):
        resp = await client.get(
            f"{BOOKINGS_URL}/{booking.id}/recording",
            headers=auth_headers(auth["session_token"]),
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "unavailable"
    assert body["url"] is None


@pytest.mark.asyncio
async def test_zoom_error_is_error_not_unavailable(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A non-404 Zoom failure (network/auth/5xx) is 'error', NEVER collapsed
    into 'unavailable' -- conflating the two would tell a user "no
    recording" when we actually just failed to check."""
    master_id = await _make_master(client, db_session, 99408)
    practice = await _create_practice(db_session, master_id)
    await _active_zoom_meeting(db_session, practice)
    booking, auth = await _booking_for(client, db_session, practice, 99430)
    await db_session.commit()

    with patch(
        "app.modules.zoom.service.get_meeting_recordings",
        side_effect=ZoomAPIError("outage", status_code=500, body="down"),
    ):
        resp = await client.get(
            f"{BOOKINGS_URL}/{booking.id}/recording",
            headers=auth_headers(auth["session_token"]),
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "error"
    assert body["url"] is None
