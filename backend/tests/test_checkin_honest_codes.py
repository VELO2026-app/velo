# =============================================================================
# VELO -- Tests: check-in answers with honest codes (BE-92)
# =============================================================================
#
# upsert_checkin's grid, one code per cause:
#
#   no live booking (none, only cancelled, unknown id) -> 404 no_active_booking
#   live booking, viewer blocked by the master         -> 403 blocked_by_master
#   live booking (any status), practice started        -> 400 checkin_window_closed
#   live booking not CONFIRMED, window not closed      -> 404 no_active_booking
#   CONFIRMED, too early                               -> 400 checkin_window_not_open
#   CONFIRMED, window open                             -> 200; again -> 409
#
# ATTENDED / NO_SHOW are only ever written after the start (autofinalize at
# scheduled end, the Zoom report on COMPLETED practices), so they are built
# here on started practices only -- the reachable form.
#
# telegram_id band: 89100-89139.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.bookings.models import Booking, BookingStatus
from app.modules.masters.groups_models import MasterStudent
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

BAND_MIN, BAND_MAX = 89100, 89139

CHECKIN_URL = "/api/v1/practices/{practice_id}/checkin"
MASTER_TG = BAND_MIN + 39
STUDENT_TG = BAND_MIN + 1


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, BAND_MIN, BAND_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, BAND_MIN, BAND_MAX, delete_users=True)
    await db_session.commit()


async def _master(client: AsyncClient, db_session: AsyncSession) -> UUID:
    auth = await login_user(client, telegram_id=MASTER_TG, first_name="Master")
    user_id = UUID(auth["user"]["id"])
    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER
    db_session.add(
        MasterProfile(
            user_id=user_id,
            data={"account": {"status": "verified"}, "profile": {"bio": "m"}},
        )
    )
    await db_session.flush()
    return user_id


async def _student(client: AsyncClient) -> tuple[UUID, dict[str, str]]:
    auth = await login_user(client, telegram_id=STUDENT_TG, first_name="Student")
    return UUID(auth["user"]["id"]), auth_headers(auth["session_token"])


async def _practice(
    db_session: AsyncSession, master_id: UUID, starts_in: timedelta
) -> Practice:
    practice = Practice(
        master_id=master_id,
        title="BE-92 practice",
        description="d",
        practice_type=PracticeType.LIVE.value,
        status=PracticeStatus.SCHEDULED.value,
        scheduled_at=datetime.now(UTC) + starts_in,
        duration_minutes=60,
        timezone="UTC",
        max_participants=20,
        current_participants=0,
        is_free=True,
        price_cents=0,
        currency="eur",
    )
    db_session.add(practice)
    await db_session.flush()
    return practice


def _book(
    db_session: AsyncSession, practice: Practice, user_id: UUID, status: str
) -> None:
    db_session.add(Booking(practice_id=practice.id, user_id=user_id, status=status))


async def _post(client: AsyncClient, practice_id: UUID, headers: dict[str, str]):
    return await client.post(
        CHECKIN_URL.format(practice_id=practice_id), json={"mood": 6}, headers=headers
    )


# Inside the default window (opens checkin_window_hours before the start).
OPEN = timedelta(hours=1)
TOO_EARLY = timedelta(hours=48)
STARTED = timedelta(hours=-1)


@pytest.mark.parametrize(
    ("status", "starts_in", "http", "code"),
    [
        (BookingStatus.CONFIRMED.value, STARTED, 400, "checkin_window_closed"),
        (BookingStatus.ATTENDED.value, STARTED, 400, "checkin_window_closed"),
        (BookingStatus.NO_SHOW.value, STARTED, 400, "checkin_window_closed"),
        (BookingStatus.PENDING.value, STARTED, 400, "checkin_window_closed"),
        (BookingStatus.PENDING.value, OPEN, 404, "no_active_booking"),
        (BookingStatus.PENDING.value, TOO_EARLY, 404, "no_active_booking"),
        (BookingStatus.CONFIRMED.value, TOO_EARLY, 400, "checkin_window_not_open"),
    ],
)
async def test_a_live_booking_gets_the_code_of_its_cell(
    client: AsyncClient,
    db_session: AsyncSession,
    status: str,
    starts_in: timedelta,
    http: int,
    code: str,
) -> None:
    """THE CARD's case is ATTENDED / NO_SHOW after the start: it used to be a
    bare 404 ("not found"), it is now the honest window-closed 400."""
    master_id = await _master(client, db_session)
    user_id, headers = await _student(client)
    practice = await _practice(db_session, master_id, starts_in)
    _book(db_session, practice, user_id, status)
    await db_session.commit()

    resp = await _post(client, practice.id, headers)

    assert resp.status_code == http
    assert resp.json()["error"] == code


async def test_a_confirmed_booking_in_the_window_checks_in_once(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """REPEAT: the happy cell stays 200, the second submit stays 409."""
    master_id = await _master(client, db_session)
    user_id, headers = await _student(client)
    practice = await _practice(db_session, master_id, OPEN)
    _book(db_session, practice, user_id, BookingStatus.CONFIRMED.value)
    await db_session.commit()

    first = await _post(client, practice.id, headers)
    second = await _post(client, practice.id, headers)

    assert first.status_code == 200
    assert second.status_code == 409
    assert second.json()["error"] == "conflict"


async def test_a_stranger_cannot_tell_a_real_practice_from_none(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """EMPTINESS / no oracle: no booking on a real (started) practice and
    any booking on a practice id that does not exist give the SAME answer,
    byte for byte. Pair: the code is the specific no_active_booking."""
    master_id = await _master(client, db_session)
    _, headers = await _student(client)
    practice = await _practice(db_session, master_id, STARTED)
    await db_session.commit()

    real = await _post(client, practice.id, headers)
    missing = await _post(client, uuid4(), headers)

    assert real.status_code == missing.status_code == 404
    assert real.json()["error"] == "no_active_booking"
    assert real.json() == missing.json()


async def test_only_cancelled_bookings_are_no_booking_not_a_500(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """SHORTAGE of a live row: two cancelled bookings on the pair (the
    partial unique index allows any number) -> 404 no_active_booking, after
    the start too -- cancelled is "no booking", never "window closed".
    Without the status filter this lookup sees two rows and raises."""
    master_id = await _master(client, db_session)
    user_id, headers = await _student(client)
    practice = await _practice(db_session, master_id, STARTED)
    _book(db_session, practice, user_id, BookingStatus.CANCELLED.value)
    _book(db_session, practice, user_id, BookingStatus.CANCELLED.value)
    await db_session.commit()

    resp = await _post(client, practice.id, headers)

    assert resp.status_code == 404
    assert resp.json()["error"] == "no_active_booking"


async def test_a_blocked_viewer_with_a_past_booking_hears_the_block(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """404 before 403, 403 before the window: a blocked viewer holding an
    ATTENDED booking on a started practice gets blocked_by_master."""
    master_id = await _master(client, db_session)
    user_id, headers = await _student(client)
    practice = await _practice(db_session, master_id, STARTED)
    _book(db_session, practice, user_id, BookingStatus.ATTENDED.value)
    db_session.add(
        MasterStudent(
            master_id=master_id, student_user_id=user_id, blocked_at=datetime.now(UTC)
        )
    )
    await db_session.commit()

    resp = await _post(client, practice.id, headers)

    assert resp.status_code == 403
    assert resp.json()["error"] == "blocked_by_master"
