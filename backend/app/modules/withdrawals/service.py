# =============================================================================
# VELO Backend -- Withdrawal Service (Phase 6.6)
# =============================================================================
#
# Business logic for master withdrawal requests.
#
# CREATE FLOW:
#   1. Validate payout details exist in MasterProfile.data.payout.
#   2. Validate amount >= min_withdrawal_cents.
#   3. Lock MasterProfile with FOR UPDATE (P-07).
#   4. Validate available_cents >= amount_cents.
#   5. Create Withdrawal record with payout_details snapshot.
#   6. Transfer available -> frozen via double-entry master_ledger.
#   7. Audit log.
#
# DOUBLE-ENTRY (create):
#   master_ledger: -amount_cents (frozen=False)  -> available decreases
#   master_ledger: +amount_cents (frozen=True)   -> frozen increases
#   SUM = 0
#
# SESSION RULES:
#   No session.commit() (P-01). Router handles flush + refresh.
# =============================================================================

from uuid import UUID

import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import record_audit
from app.core.config import settings
from app.core.exceptions import BadRequestError
from app.modules.masters.models import MasterProfile
from app.modules.payments.service import record_master_ledger
from app.modules.users.models import User
from app.modules.withdrawals.models import Withdrawal, WithdrawalStatus
from app.modules.withdrawals.schemas import (
    PaginatedWithdrawalsResponse,
    WithdrawalResponse,
)

logger = structlog.get_logger()


async def create_withdrawal(
    user: User,
    profile: MasterProfile,
    amount_cents: int,
    session: AsyncSession,
) -> Withdrawal:
    """Create a withdrawal request and freeze the amount.

    Args:
        user: The master user.
        profile: MasterProfile (from get_current_master, not locked).
        amount_cents: Total withdrawal amount in EUR cents (fee deducted from this).
        session: Active async session (caller manages transaction).

    Returns:
        Created Withdrawal record.

    Raises:
        BadRequestError: If payout details missing, amount too low,
            or insufficient available balance.
    """
    # 1. Validate payout details.
    payout = profile.data.get("payout")
    if not payout or not payout.get("method"):
        raise BadRequestError(
            "Payout details not configured. "
            "Update them via PATCH /masters/me/payout first."
        )

    # 2. Validate minimum amount.
    if amount_cents < settings.min_withdrawal_cents:
        raise BadRequestError(
            f"Minimum withdrawal amount is "
            f"{settings.min_withdrawal_cents} cents"
        )

    # 3. Validate fee does not exceed amount.
    fee_cents = settings.withdrawal_fee_cents
    if fee_cents >= amount_cents:
        raise BadRequestError(
            "Withdrawal amount must exceed the platform fee "
            f"({fee_cents} cents)"
        )

    # 4. Lock MasterProfile and check available balance (P-07).
    locked_profile = await session.get(
        MasterProfile, user.id, with_for_update=True,
    )
    if not locked_profile:
        raise BadRequestError("Master profile not found")
    if locked_profile.available_cents < amount_cents:
        raise BadRequestError(
            "Insufficient available balance"
        )

    # 5. Create Withdrawal with payout snapshot.
    withdrawal = Withdrawal(
        user_id=user.id,
        amount_cents=amount_cents,
        fee_cents=fee_cents,
        currency=settings.default_currency,
        payout_details=dict(payout),
    )
    session.add(withdrawal)
    await session.flush()

    # 6. Double-entry: transfer available -> frozen.
    reason = f"withdrawal_hold:{withdrawal.id}"

    await record_master_ledger(
        user_id=user.id,
        amount_cents=-amount_cents,
        reason=reason,
        is_frozen=False,
        session=session,
    )
    await record_master_ledger(
        user_id=user.id,
        amount_cents=amount_cents,
        reason=reason,
        is_frozen=True,
        session=session,
    )

    # 7. Audit.
    await record_audit(
        event="withdrawal_created",
        actor_id=user.id,
        actor_type="user",
        target_type="withdrawal",
        target_id=withdrawal.id,
        data={
            "amount_cents": amount_cents,
            "fee_cents": fee_cents,
            "currency": settings.default_currency,
        },
        session=session,
    )

    logger.info(
        "withdrawal_created",
        withdrawal_id=str(withdrawal.id),
        user_id=str(user.id),
        amount_cents=amount_cents,
        fee_cents=fee_cents,
    )

    return withdrawal


async def list_my_withdrawals(
    user_id: UUID,
    session: AsyncSession,
    *,
    limit: int = 20,
    offset: int = 0,
) -> PaginatedWithdrawalsResponse:
    """List withdrawals for the current master (paginated)."""
    base = select(Withdrawal).where(Withdrawal.user_id == user_id)

    # Total count.
    count_stmt = select(func.count(Withdrawal.id)).where(
        Withdrawal.user_id == user_id,
    )
    total = (await session.execute(count_stmt)).scalar_one()

    # Paginated items (newest first).
    items_stmt = (
        base
        .order_by(Withdrawal.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    result = await session.execute(items_stmt)
    rows = result.scalars().all()

    return PaginatedWithdrawalsResponse(
        items=[
            WithdrawalResponse.model_validate(w, from_attributes=True)
            for w in rows
        ],
        total=total,
        limit=limit,
        offset=offset,
    )
