# =============================================================================
# Tests: Purchase Flow (Phase 6.4)
# =============================================================================
#
# Tests for purchase creation and finalization with double-entry ledger.
#
# telegram_id range: 75xxx (purchase tests)
#
# Coverage:
#   - Free practice: purchase + booking + zero-amount ledger entries
#   - Paid practice: balance check + ledger entries + frozen
#   - Insufficient balance: 400
#   - Finalize: unfreeze + commission (double-entry)
#   - Finalize free: zero-amount commission entries
#   - Semaphore 1.1: COUNT(bookings) == COUNT(purchases)
#   - Semaphore 2.1: SUM(user + master + company ledger) == 0
#   - POST /api/v1/practices/{id}/purchase endpoint
#   - POST /api/v1/bookings (backward compat -- also creates purchase)
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.bookings.service import auto_finalize_practice
from app.modules.masters.models import MasterProfile
from app.modules.payments.models import (
    CompanyLedger,
    LedgerStatus,
    MasterLedger,
    Purchase,
    PurchaseStatus,
    UserLedger,
)
from app.modules.payments.purchase import (
    create_purchase_for_booking,
    finalize_purchases,
)
from app.modules.payments.service import record_user_ledger
from app.modules.practices.models import Practice, PracticeStatus
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, fresh_execute, full_cleanup_range, login_user


# ---------------------------------------------------------------------------
# Cleanup (dependency order: ledger -> purchases -> bookings -> practices)
# ---------------------------------------------------------------------------


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
    """Full ORM cleanup for telegram_id 75000-75999."""
    await full_cleanup_range(session, 75000, 75999, delete_users=False)
    await session.commit()



# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

PURCHASE_URL = "/api/v1/practices/{practice_id}/purchase"
BOOKINGS_URL = "/api/v1/bookings"
PRACTICES_URL = "/api/v1/practices"


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int = 75001,
) -> dict:
    """Create a verified master via login + direct DB update."""
    user_data = await login_user(
        client, telegram_id=telegram_id, first_name="Master",
    )
    user_id = user_data["user"]["id"]

    # Set role to master.
    stmt = select(User).where(User.id == user_id)
    result = await db_session.execute(stmt)
    user = result.scalar_one()
    user.role = UserRole.MASTER.value
    await db_session.flush()

    # Create MasterProfile.
    profile = MasterProfile(
        user_id=UUID(user_id),
        data={"account": {"status": "verified"}},
    )
    db_session.add(profile)
    await db_session.commit()

    return user_data


async def _create_practice(
    client: AsyncClient,
    master_data: dict,
    is_free: bool = True,
    price_cents: int = 0,
    max_participants: int | None = None,
) -> str:
    """Create a scheduled practice, return practice_id."""
    body = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Test Practice",
        "scheduled_at": (
            datetime.now(timezone.utc) + timedelta(days=1)
        ).isoformat(),
        "duration_minutes": 60,
        "timezone": "UTC",
        "is_free": is_free,
        "price_cents": price_cents,
        "currency": "eur",
    }
    if max_participants is not None:
        body["max_participants"] = max_participants

    token = master_data["session_token"]

    # Create (draft).
    resp = await client.post(
        PRACTICES_URL,
        json=body,
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    practice_id = resp.json()["id"]

    # Publish (draft -> scheduled).
    resp = await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"status": "scheduled"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 200

    return practice_id


# ===================================================================
# SERVICE-LEVEL TESTS
# ===================================================================


@pytest.mark.asyncio
async def test_purchase_free_practice_creates_zero_ledger(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Free practice: purchase created with paid_cents=0, ledger entries=0."""
    master_data = await _make_verified_master(
        client, db_session, telegram_id=75010,
    )
    practice_id = await _create_practice(
        client, master_data, is_free=True,
    )

    user_data = await login_user(
        client, telegram_id=75011, first_name="Buyer",
    )
    token = user_data["session_token"]

    # Book (creates purchase internally).
    resp = await client.post(
        BOOKINGS_URL,
        json={"practice_id": practice_id},
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    booking_id = resp.json()["id"]

    # Verify Purchase exists with paid_cents=0.
    stmt = select(Purchase).where(Purchase.booking_id == booking_id)
    result = await fresh_execute(stmt)
    purchase = result.scalar_one()
    assert purchase.paid_cents == 0
    assert purchase.status == PurchaseStatus.PENDING.value

    # Verify user_ledger entry with amount=0.
    stmt = (
        select(UserLedger)
        .where(
            UserLedger.user_id == user_data["user"]["id"],
            UserLedger.reason == f"purchase:practice={practice_id}",
        )
    )
    result = await db_session.execute(stmt)
    ul_entry = result.scalar_one()
    assert ul_entry.amount_cents == 0

    # Verify master_ledger entry with amount=0.
    stmt = (
        select(MasterLedger)
        .where(
            MasterLedger.practice_id == practice_id,
            MasterLedger.reason == f"sale:practice={practice_id}",
        )
    )
    result = await db_session.execute(stmt)
    ml_entry = result.scalar_one()
    assert ml_entry.amount_cents == 0
    assert ml_entry.is_frozen is True


@pytest.mark.asyncio
async def test_purchase_paid_practice_deducts_balance(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Paid practice: user balance decreases, master frozen increases."""
    master_data = await _make_verified_master(
        client, db_session, telegram_id=75020,
    )
    practice_id = await _create_practice(
        client, master_data, is_free=False, price_cents=5000,
    )

    # Create user with balance.
    user_data = await login_user(
        client, telegram_id=75021, first_name="Buyer",
    )
    user_id = user_data["user"]["id"]

    # Top up user balance (directly via ledger).
    from app.core.database import get_session_factory
    factory = get_session_factory()
    async with factory() as topup_session:
        await record_user_ledger(
            user_id=UUID(user_id),
            amount_cents=10000,
            reason="test:topup",
            session=topup_session,
        )
        await topup_session.commit()

    # Purchase.
    resp = await client.post(
        PURCHASE_URL.format(practice_id=practice_id),
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["paid_cents"] == 5000
    assert data["status"] == "pending"

    # Verify user balance decreased.
    db_session.expire_all()
    stmt = select(User).where(User.id == user_id)
    result = await fresh_execute(stmt)
    user = result.scalar_one()
    assert user.balance_cents == 5000  # 10000 - 5000

    # Verify master frozen increased.
    master_id = master_data["user"]["id"]
    stmt = select(MasterProfile).where(
        MasterProfile.user_id == master_id,
    )
    result = await db_session.execute(stmt)
    profile = result.scalar_one()
    assert profile.frozen_cents >= 5000


@pytest.mark.asyncio
async def test_purchase_insufficient_balance(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Paid practice with insufficient balance: 400."""
    master_data = await _make_verified_master(
        client, db_session, telegram_id=75030,
    )
    practice_id = await _create_practice(
        client, master_data, is_free=False, price_cents=5000,
    )

    user_data = await login_user(
        client, telegram_id=75031, first_name="Broke",
    )

    resp = await client.post(
        PURCHASE_URL.format(practice_id=practice_id),
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 400
    assert "Insufficient balance" in resp.json()["message"]


@pytest.mark.asyncio
async def test_purchase_own_practice_blocked(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Master cannot purchase own practice: 400."""
    master_data = await _make_verified_master(
        client, db_session, telegram_id=75040,
    )
    practice_id = await _create_practice(
        client, master_data, is_free=True,
    )

    resp = await client.post(
        PURCHASE_URL.format(practice_id=practice_id),
        headers=auth_headers(master_data["session_token"]),
    )
    assert resp.status_code == 400


# ===================================================================
# FINALIZE TESTS
# ===================================================================


@pytest.mark.asyncio
async def test_finalize_paid_practice_commission(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Finalize: unfreeze + commission deducted from master."""
    master_data = await _make_verified_master(
        client, db_session, telegram_id=75050,
    )
    practice_id = await _create_practice(
        client, master_data, is_free=False, price_cents=10000,
    )

    user_data = await login_user(
        client, telegram_id=75051, first_name="Buyer",
    )
    user_id = user_data["user"]["id"]

    # Top up.
    from app.core.database import get_session_factory
    factory = get_session_factory()
    async with factory() as topup_session:
        await record_user_ledger(
            user_id=UUID(user_id),
            amount_cents=10000,
            reason="test:topup",
            session=topup_session,
        )
        await topup_session.commit()

    # Book.
    resp = await client.post(
        BOOKINGS_URL,
        json={"practice_id": practice_id},
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 201
    booking_id = resp.json()["id"]

    # Join practice (so finalize marks as attended).
    await client.post(
        f"{BOOKINGS_URL}/{booking_id}/join",
        headers=auth_headers(user_data["session_token"]),
    )

    # Finalize.
    # Finalize via the system auto-close path (the manual endpoint was removed).
    await auto_finalize_practice(UUID(practice_id), db_session)
    await db_session.commit()

    # Verify purchase completed with commission.
    db_session.expire_all()
    stmt = select(Purchase).where(Purchase.booking_id == booking_id)
    result = await fresh_execute(stmt)
    purchase = result.scalar_one()
    assert purchase.status == PurchaseStatus.COMPLETED.value

    expected_commission = int(10000 * settings.commission_percent / 100)
    assert purchase.commission_cents == expected_commission
    assert purchase.completed_at is not None

    # Verify master balance: frozen=0, available = 10000 - commission.
    master_id = master_data["user"]["id"]
    stmt = select(MasterProfile).where(
        MasterProfile.user_id == master_id,
    )
    result = await db_session.execute(stmt)
    profile = result.scalar_one()
    assert profile.frozen_cents == 0
    assert profile.available_cents == 10000 - expected_commission

    # Verify company_ledger got commission.
    stmt = (
        select(CompanyLedger)
        .where(CompanyLedger.reference_id == purchase.id)
    )
    result = await db_session.execute(stmt)
    cl_entry = result.scalar_one()
    assert cl_entry.amount_cents == expected_commission


@pytest.mark.asyncio
async def test_finalize_free_practice_zero_commission(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Finalize free practice: zero-amount commission entries created."""
    master_data = await _make_verified_master(
        client, db_session, telegram_id=75060,
    )
    practice_id = await _create_practice(
        client, master_data, is_free=True,
    )

    user_data = await login_user(
        client, telegram_id=75061, first_name="Buyer",
    )

    # Book.
    resp = await client.post(
        BOOKINGS_URL,
        json={"practice_id": practice_id},
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 201
    booking_id = resp.json()["id"]

    # Join + finalize.
    await client.post(
        f"{BOOKINGS_URL}/{booking_id}/join",
        headers=auth_headers(user_data["session_token"]),
    )
    await auto_finalize_practice(UUID(practice_id), db_session)
    await db_session.commit()

    # Verify zero-amount commission entries.
    db_session.expire_all()
    stmt = select(Purchase).where(Purchase.booking_id == booking_id)
    result = await fresh_execute(stmt)
    purchase = result.scalar_one()
    assert purchase.commission_cents == 0
    assert purchase.status == PurchaseStatus.COMPLETED.value

    # Company ledger entry exists with 0.
    stmt = (
        select(CompanyLedger)
        .where(CompanyLedger.reference_id == purchase.id)
    )
    result = await db_session.execute(stmt)
    cl_entry = result.scalar_one()
    assert cl_entry.amount_cents == 0


# ===================================================================
# SEMAPHORE TESTS
# ===================================================================


@pytest.mark.asyncio
async def test_semaphore_bookings_equal_purchases(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Semaphore 1.1: COUNT(active bookings) == COUNT(active purchases).

    Scoped to telegram_id 75000-75999 to avoid cross-contamination with
    other test files (e.g. test_cancellation.py range 76xxx) that leave
    cancelled bookings whose purchases are 'refunded' or 'completed',
    which breaks the global count invariant.
    """
    # Active bookings for 75xxx users only.
    stmt_bookings = (
        select(func.count(Booking.id))
        .join(User, User.id == Booking.user_id)
        .where(
            Booking.status != BookingStatus.CANCELLED.value,
            User.telegram_id.between(75000, 75999),
        )
    )

    # Active purchases for 75xxx users only.
    # Scoped via booking -> user join.
    stmt_purchases = (
        select(func.count(Purchase.id))
        .join(Booking, Booking.id == Purchase.booking_id)
        .join(User, User.id == Booking.user_id)
        .where(
            Purchase.status != PurchaseStatus.CANCELLED.value,
            User.telegram_id.between(75000, 75999),
        )
    )

    b_result = await db_session.execute(stmt_bookings)
    p_result = await db_session.execute(stmt_purchases)

    bookings_count = b_result.scalar_one()
    purchases_count = p_result.scalar_one()
    assert bookings_count == purchases_count


@pytest.mark.asyncio
async def test_semaphore_double_entry_sum_zero_after_finalize(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Semaphore 2.1: SUM(all ledgers) == 0 for a finalized practice."""
    master_data = await _make_verified_master(
        client, db_session, telegram_id=75070,
    )
    practice_id = await _create_practice(
        client, master_data, is_free=False, price_cents=2000,
    )

    user_data = await login_user(
        client, telegram_id=75071, first_name="Buyer",
    )

    # Top up.
    from app.core.database import get_session_factory
    factory = get_session_factory()
    async with factory() as topup_session:
        await record_user_ledger(
            user_id=UUID(user_data["user"]["id"]),
            amount_cents=2000,
            reason="test:topup",
            session=topup_session,
        )
        await topup_session.commit()

    # Book + join + finalize.
    resp = await client.post(
        BOOKINGS_URL,
        json={"practice_id": practice_id},
        headers=auth_headers(user_data["session_token"]),
    )
    booking_id = resp.json()["id"]
    await client.post(
        f"{BOOKINGS_URL}/{booking_id}/join",
        headers=auth_headers(user_data["session_token"]),
    )
    await auto_finalize_practice(UUID(practice_id), db_session)
    await db_session.commit()

    # Check per-practice double-entry.
    # user_ledger (purchase debit) + master_ledger (sale + commission)
    # + company_ledger (commission) = 0.
    db_session.expire_all()

    pid = practice_id

    # User ledger for this practice.
    stmt = (
        select(func.coalesce(func.sum(UserLedger.amount_cents), 0))
        .where(
            UserLedger.reason == f"purchase:practice={pid}",
            UserLedger.status == LedgerStatus.DONE.value,
        )
    )
    user_sum = (await fresh_execute(stmt)).scalar_one()

    # Master ledger for this practice.
    stmt = (
        select(func.coalesce(func.sum(MasterLedger.amount_cents), 0))
        .where(
            MasterLedger.practice_id == pid,
            MasterLedger.status == LedgerStatus.DONE.value,
        )
    )
    master_sum = (await db_session.execute(stmt)).scalar_one()

    # Company ledger for this practice (via purchase reference_id).
    stmt = select(Purchase.id).where(Purchase.practice_id == pid)
    purchase_ids = (await db_session.execute(stmt)).scalars().all()

    stmt = (
        select(func.coalesce(func.sum(CompanyLedger.amount_cents), 0))
        .where(
            CompanyLedger.reference_id.in_(purchase_ids),
            CompanyLedger.status == LedgerStatus.DONE.value,
        )
    )
    company_sum = (await db_session.execute(stmt)).scalar_one()

    # Double-entry: user(-2000) + master(+2000 - commission) + company(+commission) = 0.
    total = user_sum + master_sum + company_sum
    assert total == 0, f"Double-entry violation: {user_sum} + {master_sum} + {company_sum} = {total}"


# ===================================================================
# ENDPOINT TESTS
# ===================================================================


@pytest.mark.asyncio
async def test_purchase_endpoint_returns_purchase_response(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """POST /practices/{id}/purchase returns PurchaseResponse."""
    master_data = await _make_verified_master(
        client, db_session, telegram_id=75080,
    )
    practice_id = await _create_practice(
        client, master_data, is_free=True,
    )

    user_data = await login_user(
        client, telegram_id=75081, first_name="Buyer",
    )

    resp = await client.post(
        PURCHASE_URL.format(practice_id=practice_id),
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert "id" in data
    assert "booking_id" in data
    assert data["paid_cents"] == 0
    assert data["status"] == "pending"
    assert data["practice_id"] == practice_id


@pytest.mark.asyncio
async def test_purchase_endpoint_unauthenticated(
    client: AsyncClient,
) -> None:
    """Purchase without auth: 401."""
    resp = await client.post(
        PURCHASE_URL.format(practice_id="00000000-0000-0000-0000-000000000000"),
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_booking_endpoint_also_creates_purchase(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """POST /bookings also creates Purchase (backward compatibility)."""
    master_data = await _make_verified_master(
        client, db_session, telegram_id=75090,
    )
    practice_id = await _create_practice(
        client, master_data, is_free=True,
    )

    user_data = await login_user(
        client, telegram_id=75091, first_name="Buyer",
    )

    resp = await client.post(
        BOOKINGS_URL,
        json={"practice_id": practice_id},
        headers=auth_headers(user_data["session_token"]),
    )
    assert resp.status_code == 201
    booking_id = resp.json()["id"]

    # Verify purchase was created.
    stmt = select(Purchase).where(Purchase.booking_id == booking_id)
    result = await fresh_execute(stmt)
    purchase = result.scalar_one()
    assert purchase is not None
    assert purchase.paid_cents == 0


@pytest.mark.asyncio
async def test_configurable_commission_percent(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Commission percent is configurable via settings."""
    master_data = await _make_verified_master(
        client, db_session, telegram_id=75100,
    )
    practice_id = await _create_practice(
        client, master_data, is_free=False, price_cents=10000,
    )

    user_data = await login_user(
        client, telegram_id=75101, first_name="Buyer",
    )

    # Top up.
    from app.core.database import get_session_factory
    factory = get_session_factory()
    async with factory() as topup_session:
        await record_user_ledger(
            user_id=UUID(user_data["user"]["id"]),
            amount_cents=10000,
            reason="test:topup",
            session=topup_session,
        )
        await topup_session.commit()

    # Book + join.
    resp = await client.post(
        BOOKINGS_URL,
        json={"practice_id": practice_id},
        headers=auth_headers(user_data["session_token"]),
    )
    booking_id = resp.json()["id"]
    await client.post(
        f"{BOOKINGS_URL}/{booking_id}/join",
        headers=auth_headers(user_data["session_token"]),
    )

    # Finalize with custom commission (20%) via the system auto-close path.
    with patch.object(settings, "commission_percent", 20):
        await auto_finalize_practice(UUID(practice_id), db_session)
        await db_session.commit()

    db_session.expire_all()
    stmt = select(Purchase).where(Purchase.booking_id == booking_id)
    result = await fresh_execute(stmt)
    purchase = result.scalar_one()
    assert purchase.commission_cents == 2000  # 20% of 10000
