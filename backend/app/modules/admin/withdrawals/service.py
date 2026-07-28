# =============================================================================
# VELO Backend -- Admin Withdrawals Service (Phase 6.6, Batch 3)
# =============================================================================
#
# APPROVE FLOW (Variant B -- balanced double-entry):
#   1. Lock Withdrawal FOR UPDATE, validate status == pending.
#   2. master_ledger: -amount_cents (frozen=True)  -> remove from frozen
#   3. company_ledger: +fee_cents (withdrawal_fee) -> platform keeps fee
#   4. Payment(OUT, confirmed, amount=amount-fee)  -> balancing record
#   5. Set status=approved, admin_id, approved_at.
#   SUM check: master(-5000) + company(+200) + payment_out(+4800) = 0
#
# REJECT FLOW (unfreeze):
#   1. Lock Withdrawal FOR UPDATE, validate status == pending.
#   2. master_ledger: -amount_cents (frozen=True)  -> remove from frozen
#   3. master_ledger: +amount_cents (frozen=False)  -> return to available
#   4. Set status=rejected, admin_id, rejected_at.
#   SUM = 0 (internal transfer)
#
# SESSION RULES:
#   No session.commit() (P-01). Router calls flush + refresh.
# =============================================================================

from datetime import UTC, datetime
from uuid import UUID

import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import record_audit
from app.core.config import settings
from app.core.exceptions import ConflictError, NotFoundError
from app.modules.admin.withdrawals.schemas import (
    AdminWithdrawalResponse,
    PaginatedAdminWithdrawalsResponse,
)
from app.modules.payments.models import (
    CompanyLedgerType,
    Payment,
    PaymentDirection,
    PaymentStatus,
)
from app.modules.payments.service import record_company_ledger, record_master_ledger
from app.modules.users.models import User
from app.modules.withdrawals.models import Withdrawal, WithdrawalStatus

logger = structlog.get_logger()


async def _load_pending_withdrawal(
    withdrawal_id: UUID,
    session: AsyncSession,
) -> Withdrawal:
    """Load withdrawal with FOR UPDATE and validate pending status."""
    withdrawal = await session.get(
        Withdrawal, withdrawal_id, with_for_update=True,
    )
    if not withdrawal:
        raise NotFoundError("Withdrawal not found")
    if withdrawal.status != WithdrawalStatus.PENDING.value:
        raise ConflictError("Withdrawal is not pending")
    return withdrawal


async def approve_withdrawal(
    withdrawal_id: UUID,
    admin: User,
    note: str | None,
    session: AsyncSession,
) -> Withdrawal:
    """Approve a pending withdrawal (Variant B -- balanced double-entry).

    Debits frozen balance, credits company fee, creates Payment(OUT)
    as balancing record for the payout amount.
    """
    withdrawal = await _load_pending_withdrawal(withdrawal_id, session)

    reason = f"withdrawal_approved:{withdrawal.id}"
    payout_amount = withdrawal.amount_cents - withdrawal.fee_cents

    # Step 1: Debit frozen balance (money leaves master account).
    await record_master_ledger(
        user_id=withdrawal.user_id,
        amount_cents=-withdrawal.amount_cents,
        reason=reason,
        is_frozen=True,
        session=session,
    )

    # Step 2: Company keeps the fee.
    await record_company_ledger(
        amount_cents=withdrawal.fee_cents,
        ledger_type=CompanyLedgerType.WITHDRAWAL_FEE.value,
        reason=reason,
        reference_id=withdrawal.id,
        session=session,
    )

    # Step 3: Payment(OUT) -- balancing record for payout.
    payment_out = Payment(
        user_id=withdrawal.user_id,
        direction=PaymentDirection.OUT.value,
        amount_cents=payout_amount,
        currency=withdrawal.currency,
        status=PaymentStatus.CONFIRMED.value,
        stripe_metadata={"withdrawal_id": str(withdrawal.id)},
    )
    session.add(payment_out)

    # Step 4: Update withdrawal status.
    now = datetime.now(UTC)
    withdrawal.status = WithdrawalStatus.APPROVED.value
    withdrawal.admin_id = admin.id
    withdrawal.admin_note = note
    withdrawal.approved_at = now

    # Comms (T1, dictionary §2): wallet.withdrawal_approved to the
    # master (velo context, ID-4), same transaction as the approval.
    from app.core.events.notify import emit_notification
    payout_text = f"{payout_amount / 100:.2f}"
    await emit_notification(
        session,
        type="wallet.withdrawal_approved",
        target_type="user",
        target_value=str(withdrawal.user_id),
        title="Вывод средств одобрен",
        body=f"Ваш запрос на вывод средств одобрен: €{payout_text}.",
        action_data={
            "action": "open_wallet",
            "params": {},
            "amount": payout_text,
        },
    )

    # Audit.
    await record_audit(
        event="withdrawal_approved",
        actor_id=admin.id,
        actor_type="admin",
        target_type="withdrawal",
        target_id=withdrawal.id,
        data={
            "amount_cents": withdrawal.amount_cents,
            "fee_cents": withdrawal.fee_cents,
            "payout_amount": payout_amount,
        },
        session=session,
    )

    logger.info(
        "withdrawal_approved",
        withdrawal_id=str(withdrawal.id),
        admin_id=str(admin.id),
        amount_cents=withdrawal.amount_cents,
        fee_cents=withdrawal.fee_cents,
        payout_amount=payout_amount,
    )

    return withdrawal


async def reject_withdrawal(
    withdrawal_id: UUID,
    admin: User,
    note: str,
    session: AsyncSession,
) -> Withdrawal:
    """Reject a pending withdrawal -- unfreeze funds back to available."""
    withdrawal = await _load_pending_withdrawal(withdrawal_id, session)

    # BUG-09: Distinct reasons for each ledger entry to aid debugging.
    # Both share prefix "withdrawal_rejected:" for grepability.
    unfreeze_reason = f"withdrawal_rejected:unfreeze:{withdrawal.id}"
    restore_reason = f"withdrawal_rejected:restore:{withdrawal.id}"

    # Step 1: Remove from frozen.
    await record_master_ledger(
        user_id=withdrawal.user_id,
        amount_cents=-withdrawal.amount_cents,
        reason=unfreeze_reason,
        is_frozen=True,
        session=session,
    )

    # Step 2: Return to available.
    await record_master_ledger(
        user_id=withdrawal.user_id,
        amount_cents=withdrawal.amount_cents,
        reason=restore_reason,
        is_frozen=False,
        session=session,
    )

    # Step 3: Update withdrawal status.
    now = datetime.now(UTC)
    withdrawal.status = WithdrawalStatus.REJECTED.value
    withdrawal.admin_id = admin.id
    withdrawal.admin_note = note
    withdrawal.rejected_at = now

    # Comms (T1, dictionary §2): wallet.withdrawal_rejected to the
    # master; the admin note travels as a pre-rendered scalar.
    from app.core.events.notify import emit_notification
    amount_text = f"{withdrawal.amount_cents / 100:.2f}"
    await emit_notification(
        session,
        type="wallet.withdrawal_rejected",
        target_type="user",
        target_value=str(withdrawal.user_id),
        title="Вывод средств отклонён",
        body=(
            f"Ваш запрос на вывод €{amount_text} не был одобрен."
            + (f" Причина: {note}" if note else "")
        ),
        action_data={
            "action": "open_wallet",
            "params": {},
            "amount": amount_text,
            "reason": note or "",
        },
    )

    # Audit.
    await record_audit(
        event="withdrawal_rejected",
        actor_id=admin.id,
        actor_type="admin",
        target_type="withdrawal",
        target_id=withdrawal.id,
        data={
            "amount_cents": withdrawal.amount_cents,
            "note": note,
        },
        session=session,
    )

    logger.info(
        "withdrawal_rejected",
        withdrawal_id=str(withdrawal.id),
        admin_id=str(admin.id),
        amount_cents=withdrawal.amount_cents,
    )

    return withdrawal


async def list_withdrawals_admin(
    session: AsyncSession,
    *,
    status_filter: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> PaginatedAdminWithdrawalsResponse:
    """List all withdrawals for admin (paginated, optional status filter)."""
    base = select(Withdrawal)
    count_base = select(func.count(Withdrawal.id))

    if status_filter:
        base = base.where(Withdrawal.status == status_filter)
        count_base = count_base.where(Withdrawal.status == status_filter)

    total = (await session.execute(count_base)).scalar_one()

    items_stmt = (
        base
        .order_by(Withdrawal.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    result = await session.execute(items_stmt)
    rows = result.scalars().all()

    return PaginatedAdminWithdrawalsResponse(
        items=[
            AdminWithdrawalResponse.model_validate(w, from_attributes=True)
            for w in rows
        ],
        total=total,
        limit=limit,
        offset=offset,
    )
