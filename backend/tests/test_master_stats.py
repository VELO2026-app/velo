# =============================================================================
# VELO Backend -- Tests: Master Stats (E7, period-scoped dashboard grid)
# =============================================================================
#
# telegram_id ranges:
#   93001-93099 -- master users (practice owners)
#   93100-93199 -- regular users (participants)
#   93200-93299 -- a plain user for the 403 check
#
# Coverage:
#   GET /masters/me/stats
#     - empty state (zeros + null deltas)
#     - practices_count: countable practices scheduled in the current period
#     - excludes draft / deleted / cancelled
#     - excludes practices scheduled outside the period
#     - participants_count: DISTINCT attended users across the master's
#       practices in the period
#     - practices_delta_pct vs previous period
#     - income surfaces through the E2 finance projection
#     - month period
#     - auth: no auth (401), non-master (403), invalid period (422)
# =============================================================================

import itertools
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.bookings.models import Booking, BookingStatus
from app.modules.masters.models import MasterProfile
from app.modules.payments.service import record_master_ledger
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, login_user, full_cleanup_range

STATS_URL = "/api/v1/masters/me/stats"

_TID_MIN = 93000
_TID_MAX = 93999


# ===================================================================
# Cleanup
# ===================================================================


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """Clean all test data before/after each test (ORM, no raw SQL)."""
    await _do_cleanup(db_session)
    yield
    await _do_cleanup(db_session)


async def _do_cleanup(session: AsyncSession) -> None:
    """Full ORM cleanup for telegram_id 93000-93999."""
    await full_cleanup_range(session, _TID_MIN, _TID_MAX, delete_users=False)
    await session.commit()


# ===================================================================
# Helpers
# ===================================================================


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int = 93001,
) -> dict:
    """Create a verified master via login + direct DB setup."""
    data = await login_user(
        client, telegram_id=telegram_id, first_name="Master",
    )
    user_id = data["user"]["id"]

    user = (
        await db_session.execute(select(User).where(User.id == user_id))
    ).scalar_one()
    user.role = UserRole.MASTER.value
    await db_session.flush()

    profile = MasterProfile(
        user_id=UUID(user_id),
        data={"account": {"status": "verified"}},
    )
    db_session.add(profile)
    await db_session.commit()
    return data


_practice_counter = itertools.count()


async def _create_practice(
    db_session: AsyncSession,
    master_id: str,
    *,
    scheduled_at: datetime,
    status: str = PracticeStatus.COMPLETED.value,
) -> Practice:
    """Create a practice owned by the master with the given schedule/status.

    MIG1 (uq_practice_master_title_scheduled_recurrence, ПРОМТ №583): several
    tests in this file deliberately create multiple practices for the SAME
    master at the SAME scheduled_at (to exercise period-window counting) --
    a shared hardcoded title would collide with the new partial unique index
    the moment two such rows are both non-deleted. The counter suffix keeps
    every row unique on the index key without touching scheduled_at (which
    the period-window assertions depend on). No test asserts an exact title.
    """
    practice = Practice(
        master_id=UUID(master_id),
        practice_type=PracticeType.LIVE.value,
        status=status,
        title=f"Stats Practice {next(_practice_counter)}",
        scheduled_at=scheduled_at,
        duration_minutes=60,
        timezone="UTC",
    )
    db_session.add(practice)
    await db_session.flush()
    await db_session.commit()
    return practice


async def _attend(
    db_session: AsyncSession,
    practice_id: UUID,
    user_id: str,
) -> None:
    """Add an ATTENDED booking for the participant on the practice."""
    booking = Booking(
        practice_id=practice_id,
        user_id=UUID(user_id),
        status=BookingStatus.ATTENDED.value,
    )
    db_session.add(booking)
    await db_session.commit()


# ===================================================================
# Auth
# ===================================================================


async def test_stats_no_auth(client: AsyncClient) -> None:
    """No Authorization header -> 401."""
    resp = await client.get(STATS_URL)
    assert resp.status_code == 401


async def test_stats_requires_verified_master(
    client: AsyncClient,
) -> None:
    """A plain (non-master) user -> 403."""
    data = await login_user(
        client, telegram_id=93200, first_name="Plain",
    )
    resp = await client.get(
        STATS_URL, headers=auth_headers(data["session_token"]),
    )
    assert resp.status_code == 403


async def test_stats_invalid_period(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Invalid period query value -> 422 (Literal validation, P-11)."""
    master = await _make_verified_master(client, db_session)
    resp = await client.get(
        f"{STATS_URL}?period=year",
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 422


# ===================================================================
# Empty state
# ===================================================================


async def test_stats_empty_state(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A master with no activity -> zeros and null deltas."""
    master = await _make_verified_master(client, db_session)
    resp = await client.get(
        STATS_URL, headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["practices_count"] == 0
    assert body["practices_delta_pct"] is None
    assert body["participants_count"] == 0
    assert body["participants_delta_pct"] is None
    assert body["income_cents"] == 0
    assert body["income_delta_pct"] is None


# ===================================================================
# practices_count
# ===================================================================


async def test_practices_count_current_period(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Counts the master's practices scheduled in the current period."""
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    now = datetime.now(UTC)

    await _create_practice(db_session, master_id, scheduled_at=now)
    await _create_practice(db_session, master_id, scheduled_at=now)

    resp = await client.get(
        STATS_URL, headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 200
    assert resp.json()["practices_count"] == 2


async def test_practices_excludes_non_counted_statuses(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Draft / deleted / cancelled practices are not counted."""
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    now = datetime.now(UTC)

    await _create_practice(
        db_session, master_id, scheduled_at=now,
        status=PracticeStatus.COMPLETED.value,
    )
    for status in (
        PracticeStatus.DRAFT.value,
        PracticeStatus.DELETED.value,
        PracticeStatus.CANCELLED.value,
    ):
        await _create_practice(
            db_session, master_id, scheduled_at=now, status=status,
        )

    resp = await client.get(
        STATS_URL, headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 200
    assert resp.json()["practices_count"] == 1


async def test_practices_excludes_other_period(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Practices scheduled well outside the current period are not counted."""
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    now = datetime.now(UTC)

    await _create_practice(db_session, master_id, scheduled_at=now)
    # ~3 weeks ago: outside both the current and the previous week/month.
    await _create_practice(
        db_session, master_id, scheduled_at=now - timedelta(days=20),
    )

    resp = await client.get(
        f"{STATS_URL}?period=week",
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 200
    assert resp.json()["practices_count"] == 1


# ===================================================================
# participants_count
# ===================================================================


async def test_participants_distinct_attended(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """DISTINCT attendees across the master's practices in the period."""
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    now = datetime.now(UTC)

    p1 = await _create_practice(db_session, master_id, scheduled_at=now)
    p2 = await _create_practice(db_session, master_id, scheduled_at=now)

    u1 = await login_user(client, telegram_id=93101, first_name="P1")
    u2 = await login_user(client, telegram_id=93102, first_name="P2")

    # u1 attends both practices (counts once), u2 attends one.
    await _attend(db_session, p1.id, u1["user"]["id"])
    await _attend(db_session, p2.id, u1["user"]["id"])
    await _attend(db_session, p1.id, u2["user"]["id"])

    resp = await client.get(
        STATS_URL, headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 200
    assert resp.json()["participants_count"] == 2


# ===================================================================
# Deltas
# ===================================================================


async def test_practices_delta_pct(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """practices_delta_pct compares the current week against the previous one."""
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    now = datetime.now(UTC)

    # Current week: 2 practices. Previous week: 1 practice. -> +100%.
    await _create_practice(db_session, master_id, scheduled_at=now)
    await _create_practice(db_session, master_id, scheduled_at=now)
    await _create_practice(
        db_session, master_id, scheduled_at=now - timedelta(days=7),
    )

    resp = await client.get(
        f"{STATS_URL}?period=week",
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["practices_count"] == 2
    assert body["practices_delta_pct"] == 100


# ===================================================================
# Income (reused E2 projection)
# ===================================================================


async def test_income_surfaces(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A title-tagged ledger movement surfaces as income in the period."""
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]

    await record_master_ledger(
        user_id=UUID(master_id),
        amount_cents=5000,
        reason="sale:test",
        session=db_session,
        is_frozen=False,
        title="Оплата практики",
    )
    await db_session.commit()

    resp = await client.get(
        STATS_URL, headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["income_cents"] == 5000
    # No previous-period income -> null delta (S-1).
    assert body["income_delta_pct"] is None


# ===================================================================
# Month period
# ===================================================================


async def test_month_period(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The month period counts a practice scheduled in the current month."""
    master = await _make_verified_master(client, db_session)
    master_id = master["user"]["id"]
    now = datetime.now(UTC)

    await _create_practice(db_session, master_id, scheduled_at=now)

    resp = await client.get(
        f"{STATS_URL}?period=month",
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 200
    assert resp.json()["practices_count"] >= 1
