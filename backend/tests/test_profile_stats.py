# =============================================================================
# VELO Backend -- Profile Stats Tests (Screen A)
# =============================================================================
#
# Covers GET /api/v1/bookings/me/stats:
#   - empty case: no attended bookings -> (0, 0.0)
#   - happy path: only attended bookings count toward practices/hours
#   - isolation: another user's attended bookings don't leak in
#
# Mirrors the helper style of test_insights.py / test_attendance.py:
# attended bookings are inserted directly in the DB to bypass the API's
# time-window and finalize machinery (we are unit-testing the aggregate,
# not the attendance flow).
#
# telegram_id range reserved for this module: 87100-87199.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.bookings.models import Booking, BookingStatus
from app.modules.chats.models import ChatThread
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import (
    Practice,
    PracticeStatus,
    PracticeType,
)
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

STATS_URL = "/api/v1/bookings/me/stats"

# B52: comms is cut at the seam bookings.service imports it through, same
# convention as test_chats_t2.py's _SEAM.
_COMMS_SEAM = "app.modules.bookings.service.comms_request"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """Clean all test data before/after each test (TD-032: ORM, no raw SQL)."""
    await _do_cleanup(db_session)
    yield
    await _do_cleanup(db_session)


async def _do_cleanup(session: AsyncSession) -> None:
    """Full ORM cleanup for telegram_id 87100-87199."""
    await full_cleanup_range(session, 87100, 87199, delete_users=True)
    await session.commit()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
async def _make_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
) -> str:
    """Create a master user that can own practices. Returns user id.

    Practices reference master_profiles.user_id (FK practices_master_id_fkey),
    so a plain role change is not enough -- a MasterProfile row must exist for
    this user, otherwise inserting a practice violates the FK. We don't need a
    verified status here (the stats aggregate doesn't care), so a minimal
    profile with a verified-shaped data blob is sufficient and future-proof.
    """
    auth = await login_user(client, telegram_id=telegram_id, first_name="Master")
    user_id = auth["user"]["id"]

    await db_session.execute(
        update(User)
        .where(User.id == user_id)
        .values(role=UserRole.MASTER.value)
    )
    db_session.add(
        MasterProfile(
            user_id=user_id,
            data={"account": {"status": "verified"}},
        )
    )
    await db_session.commit()
    return user_id


async def _make_completed_practice(
    db_session: AsyncSession,
    master_id: str,
    *,
    duration_minutes: int,
) -> Practice:
    """Insert a completed practice with a given duration."""
    practice = Practice(
        master_id=master_id,
        title="Stats Practice",
        description="For profile-stats testing",
        practice_type=PracticeType.LIVE.value,
        status=PracticeStatus.COMPLETED.value,
        scheduled_at=datetime.now(timezone.utc) - timedelta(hours=3),
        duration_minutes=duration_minutes,
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


async def _add_booking(
    db_session: AsyncSession,
    user_id: str,
    practice: Practice,
    status: str,
) -> None:
    """Insert a booking with the given status for the user/practice."""
    booking = Booking(
        practice_id=practice.id,
        user_id=user_id,
        status=status,
        joined_at=datetime.now(timezone.utc) - timedelta(hours=2),
    )
    db_session.add(booking)
    await db_session.flush()


# ---------------------------------------------------------------------------
# Empty case
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_stats_empty_returns_zero(client: AsyncClient) -> None:
    """A user with no attended bookings gets (0, 0.0)."""
    auth = await login_user(client, telegram_id=87101, first_name="Empty")

    resp = await client.get(STATS_URL, headers=auth_headers(auth["session_token"]))

    assert resp.status_code == 200
    body = resp.json()
    assert body["practices_attended"] == 0
    assert body["hours_attended"] == 0.0


# ---------------------------------------------------------------------------
# Happy path: only attended counts
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_stats_counts_only_attended(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Attended bookings sum to count + hours; other statuses are excluded.

    Two attended practices: 45 + 60 = 105 min -> 1.75h -> 1.8 (one decimal).
    A no_show and a cancelled booking must NOT contribute.
    """
    master_id = await _make_master(client, db_session, 87110)
    auth = await login_user(client, telegram_id=87111, first_name="User")
    user_id = auth["user"]["id"]

    p45 = await _make_completed_practice(db_session, master_id, duration_minutes=45)
    p60 = await _make_completed_practice(db_session, master_id, duration_minutes=60)
    p30 = await _make_completed_practice(db_session, master_id, duration_minutes=30)
    p90 = await _make_completed_practice(db_session, master_id, duration_minutes=90)

    await _add_booking(db_session, user_id, p45, BookingStatus.ATTENDED.value)
    await _add_booking(db_session, user_id, p60, BookingStatus.ATTENDED.value)
    await _add_booking(db_session, user_id, p30, BookingStatus.NO_SHOW.value)
    await _add_booking(db_session, user_id, p90, BookingStatus.CANCELLED.value)
    await db_session.commit()

    resp = await client.get(STATS_URL, headers=auth_headers(auth["session_token"]))

    assert resp.status_code == 200
    body = resp.json()
    assert body["practices_attended"] == 2
    assert body["hours_attended"] == 1.8


# ---------------------------------------------------------------------------
# Isolation: another user's attended bookings don't leak in
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_stats_isolated_per_user(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """One user's attended booking must not appear in another's stats."""
    master_id = await _make_master(client, db_session, 87120)
    other = await login_user(client, telegram_id=87121, first_name="Other")
    me = await login_user(client, telegram_id=87122, first_name="Me")

    practice = await _make_completed_practice(
        db_session, master_id, duration_minutes=60,
    )
    await _add_booking(
        db_session, other["user"]["id"], practice, BookingStatus.ATTENDED.value,
    )
    await db_session.commit()

    resp = await client.get(STATS_URL, headers=auth_headers(me["session_token"]))

    assert resp.status_code == 200
    body = resp.json()
    assert body["practices_attended"] == 0
    assert body["hours_attended"] == 0.0


# ---------------------------------------------------------------------------
# B52: has_unread_messages -- the profile "Сообщения" row's colour dot
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_stats_no_threads_means_no_unread_and_no_comms_call(
    client: AsyncClient,
) -> None:
    """A user with no chat threads never calls comms at all -- the N in the
    per-thread fan-out is genuinely zero, not a call that happens to
    return zero."""
    auth = await login_user(client, telegram_id=87130, first_name="NoChats")
    fake = AsyncMock()

    with patch(_COMMS_SEAM, fake):
        resp = await client.get(
            STATS_URL, headers=auth_headers(auth["session_token"]),
        )

    assert resp.status_code == 200
    assert resp.json()["has_unread_messages"] is False
    fake.assert_not_called()


@pytest.mark.asyncio
async def test_stats_flags_unread_from_any_thread(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """One thread with unread > 0 is enough to flip the flag True -- it is
    a colour, not a count, so which thread or how many never surfaces."""
    auth = await login_user(client, telegram_id=87131, first_name="HasUnread")
    master_id = await _make_master(client, db_session, 87132)
    thread_id = uuid4()
    db_session.add(
        ChatThread(
            comms_thread_id=thread_id,
            client_user_id=auth["user"]["id"],
            operator_user_id=master_id,
        )
    )
    await db_session.commit()

    fake = AsyncMock(return_value={"unread": 3})
    with patch(_COMMS_SEAM, fake):
        resp = await client.get(
            STATS_URL, headers=auth_headers(auth["session_token"]),
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["has_unread_messages"] is True
    # The count itself never reaches the wire -- only the flag.
    assert "unread" not in body
    assert "unread_count" not in body


@pytest.mark.asyncio
async def test_stats_unread_flag_degrades_to_false_on_a_comms_failure(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A comms outage must not break the stat cards that have nothing to do
    with chat -- practices_attended/hours_attended are pure local
    aggregates and must still return 200."""
    auth = await login_user(client, telegram_id=87133, first_name="CommsDown")
    master_id = await _make_master(client, db_session, 87134)
    db_session.add(
        ChatThread(
            comms_thread_id=uuid4(),
            client_user_id=auth["user"]["id"],
            operator_user_id=master_id,
        )
    )
    await db_session.commit()

    fake = AsyncMock(side_effect=RuntimeError("comms unreachable"))
    with patch(_COMMS_SEAM, fake):
        resp = await client.get(
            STATS_URL, headers=auth_headers(auth["session_token"]),
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["has_unread_messages"] is False
    assert body["practices_attended"] == 0
    assert body["hours_attended"] == 0.0
