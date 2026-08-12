# =============================================================================
# Tests: Ledger recording + balance recalculation (Phase 6.2, CRITICAL-3)
# =============================================================================

from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import BadRequestError
from app.modules.masters.models import MasterProfile
from app.modules.payments.models import (
    CompanyLedgerType,
    LedgerStatus,
    UserLedger,
)
from app.modules.payments.service import (
    record_company_ledger,
    record_master_ledger,
    record_user_ledger,
)
from app.modules.users.models import User, UserRole
from tests.helpers import login_user


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _purge(session: AsyncSession, telegram_id: int) -> None:
    """Drop any row this file left behind on an earlier run.

    These tests pin FIXED telegram ids (70001-70003) and never commit --
    the db_session fixture rolls back at teardown, so on a clean database
    they leave nothing. That guarantee does NOT survive a run that dies
    between the flush and the rollback: the row is already visible to the
    connection, and if anything in the same session commits afterwards it
    becomes permanent. Measured on the test server 2026-08-12 -- all three
    ids were already present and every ledger test failed on
    ix_users_telegram_id before a single assertion ran.

    Deleting first makes the file idempotent instead of first-run-only.
    Deliberately NOT switched to random ids: the fixed ones are readable
    in a failure message and this file is their only user (verified --
    `grep -rl '7000[0-9]' backend/tests/` returns this file alone). The
    cascade takes MasterProfile and any ledger rows with the user.
    """
    existing = await session.scalar(
        select(User).where(User.telegram_id == telegram_id)
    )
    if existing is not None:
        await session.delete(existing)
        await session.flush()


async def _create_user(session: AsyncSession, telegram_id: int) -> User:
    """Create a bare User row for ledger tests."""
    await _purge(session, telegram_id)
    user = User(
        telegram_id=telegram_id,
        first_name="LedgerTest",
        role=UserRole.USER,
    )
    session.add(user)
    await session.flush()
    return user


async def _create_master(session: AsyncSession, telegram_id: int) -> tuple[User, MasterProfile]:
    """Create a User + MasterProfile pair for ledger tests."""
    await _purge(session, telegram_id)
    user = User(
        telegram_id=telegram_id,
        first_name="MasterTest",
        role=UserRole.MASTER,
    )
    session.add(user)
    await session.flush()

    profile = MasterProfile(
        user_id=user.id,
        data={"account": {"status": "verified"}},
    )
    session.add(profile)
    await session.flush()
    return user, profile


# ---------------------------------------------------------------------------
# User ledger → balance_cents
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_user_ledger_updates_balance(
    db_session: AsyncSession,
) -> None:
    """Recording done entries updates User.balance_cents."""
    user = await _create_user(db_session, telegram_id=70001)
    assert user.balance_cents == 0

    # +1000 cents (topup).
    await record_user_ledger(
        user_id=user.id,
        amount_cents=1000,
        reason="payment:test",
        session=db_session,
    )
    await db_session.refresh(user)
    assert user.balance_cents == 1000

    # -300 cents (purchase).
    await record_user_ledger(
        user_id=user.id,
        amount_cents=-300,
        reason="purchase:practice=test",
        session=db_session,
    )
    await db_session.refresh(user)
    assert user.balance_cents == 700


@pytest.mark.asyncio
async def test_user_ledger_pending_excluded(
    db_session: AsyncSession,
) -> None:
    """Pending entries are excluded from balance calculation."""
    user = await _create_user(db_session, telegram_id=70002)

    # Done entry: +500.
    await record_user_ledger(
        user_id=user.id,
        amount_cents=500,
        reason="payment:done",
        session=db_session,
    )

    # Pending entry: +2000 (should NOT count).
    await record_user_ledger(
        user_id=user.id,
        amount_cents=2000,
        reason="payment:pending",
        status=LedgerStatus.PENDING.value,
        session=db_session,
    )

    await db_session.refresh(user)
    assert user.balance_cents == 500


# ---------------------------------------------------------------------------
# Master ledger → frozen_cents / available_cents
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_master_ledger_frozen_and_available(
    db_session: AsyncSession,
) -> None:
    """Frozen and available balances are tracked separately."""
    user, profile = await _create_master(db_session, telegram_id=70003)

    # Frozen entry: +5000 (sale, awaiting practice).
    await record_master_ledger(
        user_id=user.id,
        amount_cents=5000,
        reason="sale:practice=a",
        is_frozen=True,
        session=db_session,
    )
    await db_session.refresh(profile)
    assert profile.frozen_cents == 5000
    assert profile.available_cents == 0

    # Available entry: +3000 (already unfrozen from another practice).
    await record_master_ledger(
        user_id=user.id,
        amount_cents=3000,
        reason="sale:practice=b",
        is_frozen=False,
        session=db_session,
    )
    await db_session.refresh(profile)
    assert profile.frozen_cents == 5000
    assert profile.available_cents == 3000

    # Commission deducted from available: -750.
    await record_master_ledger(
        user_id=user.id,
        amount_cents=-750,
        reason="commission:practice=b",
        is_frozen=False,
        session=db_session,
    )
    await db_session.refresh(profile)
    assert profile.frozen_cents == 5000
    assert profile.available_cents == 2250


@pytest.mark.asyncio
async def test_master_ledger_missing_profile_raises(
    db_session: AsyncSession,
) -> None:
    """record_master_ledger raises BadRequestError if MasterProfile is missing.

    CRITICAL-3 fix: a missing MasterProfile means the cached balance cannot
    be updated. The function must raise immediately so the caller's transaction
    rolls back entirely — no orphan ledger entry is persisted.
    """
    # Create a User without a MasterProfile.
    user = User(
        telegram_id=70099,
        first_name="NoProfile",
        role=UserRole.MASTER,
    )
    db_session.add(user)
    await db_session.flush()

    # Attempt to record a ledger entry — must raise, not silently continue.
    with pytest.raises(BadRequestError):
        await record_master_ledger(
            user_id=user.id,
            amount_cents=1000,
            reason="sale:practice=test",
            is_frozen=True,
            session=db_session,
        )


# ---------------------------------------------------------------------------
# Company ledger
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_company_ledger_basic(
    db_session: AsyncSession,
) -> None:
    """Company ledger entry is created with reference_id."""
    ref_id = uuid4()

    entry = await record_company_ledger(
        amount_cents=750,
        ledger_type=CompanyLedgerType.COMMISSION.value,
        reason="commission:practice=test",
        reference_id=ref_id,
        session=db_session,
    )

    assert entry.id is not None
    assert entry.amount_cents == 750
    assert entry.type == "commission"
    assert entry.reference_id == ref_id
    assert entry.status == "done"
