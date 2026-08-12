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

# One unique id block per test PROCESS, so this file cannot collide with
# what an earlier run left in the database.
#
# WHY NOT FIXED IDS + CLEANUP, which is the idiom elsewhere in this suite.
# This file used to pin 70001-70003 and never commit, relying on
# db_session's teardown rollback (conftest.py:126-142). That holds on a
# clean database and fails permanently after any run that dies between the
# flush and the rollback -- measured on the test server 2026-08-12, all
# three ids present, every ledger test failing on ix_users_telegram_id
# before a single assertion ran.
#
# Cleanup was tried first and abandoned after it failed TWICE on the
# server, each time one foreign key deeper: first master_ledger, then --
# once the money tables were cleared -- practices, because deleting the
# User cascades into the practices it owns and a stranger's purchase still
# references those. The chain does not terminate anywhere useful, and it
# should not: every money FK to users.id is ondelete=RESTRICT on purpose
# (payments/models.py:160, :204, :333, :426, each with a CRITICAL-02
# comment saying the audit trail must outlive the user). Deleting a user
# who has financial history is exactly what the schema is built to refuse.
# Fighting that to satisfy a test is the wrong side of the argument.
#
# Unique ids sidestep it entirely: nothing to clean, nothing to collide
# with, and the schema's guarantee is left intact. The rows do accumulate,
# which is acceptable here and nowhere near the cost of the alternative --
# this is the disposable test contour ("free to wipe / seed / break"), the
# rows are three per run, and a wipe is a routine operation on it.
#
# The 11-digit block cannot overlap the 5-digit bands the other suites pin
# (test_chats_t2 89720-89759, test_chats_t3_students 89760-89799,
# test_comms_* 89400-89599) -- verified, not assumed.
_RUN_BLOCK = 70_000_000_000 + (uuid4().int % 100_000_000) * 10


def _tg(slot: int) -> int:
    """Telegram id for this run's slot (1-9). Unique per test process.

    The slot keeps failures readable -- slot 1 is still "the plain user
    balance test", exactly as 70001 was -- while the block makes the id
    unique.
    """
    return _RUN_BLOCK + slot


async def _create_user(session: AsyncSession, telegram_id: int) -> User:
    """Create a bare User row for ledger tests."""
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
    user = await _create_user(db_session, telegram_id=_tg(1))
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
    user = await _create_user(db_session, telegram_id=_tg(2))

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
    user, profile = await _create_master(db_session, telegram_id=_tg(3))

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
