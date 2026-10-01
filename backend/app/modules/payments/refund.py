# =============================================================================
# VELO Backend -- Refund Service (Phase 6.5, updated Phase 6.7 Batch 4)
# =============================================================================
#
# Refund and early-finalize logic for booking/practice cancellations.
#
# THREE SCENARIOS:
#
#   A) User cancels > 24h before practice (refund_booking):
#      - Reverse frozen master credit + refund user.
#      - No promo / Master promo:
#          master_ledger(-paid_cents, frozen) + user_ledger(+paid_cents)
#      - Company promo:
#          master_ledger(-amount_cents, frozen) + user_ledger(+paid_cents)
#          + company_ledger(+discount_cents, marketing reversal)
#      - Purchase -> REFUNDED.
#
#   B) User cancels <= 24h before practice (early_finalize_booking):
#      - Master keeps the money. Immediate unfreeze + commission.
#      - No promo / Master promo:
#          master_ledger(-paid_cents, frozen reversal)
#          master_ledger(+paid_cents, available)
#          master_ledger(-commission, available) + company_ledger(+commission)
#      - Company promo:
#          master_ledger(-amount_cents, frozen reversal)
#          master_ledger(+amount_cents, available)
#          master_ledger(-commission, available) + company_ledger(+commission)
#          (marketing debit stays -- practice was "consumed")
#      - Purchase -> COMPLETED.
#
#   C) Master cancels entire practice (refund_all_bookings_for_practice):
#      - 100% refund to every active booking (uses refund_booking).
#      - All waitlist entries -> left.
#      - Recalculate current_participants -> 0 (Frontend Backlog A-03).
#
# KEY PROMO INSIGHT:
#   "Master reversal amount" = what master originally received (frozen):
#   - No promo:      paid_cents (= price)
#   - Master promo:  paid_cents (master absorbed discount)
#   - Company promo: amount_cents (company covered gap, master got full price)
#
#   Helper _master_frozen_amount(purchase) encapsulates this logic.
#
# WHY REVERSAL, NOT UPDATE?
#   master_ledger entries don't carry booking_id, so we can't
#   target a specific frozen entry for UPDATE. Instead, we create
#   an offsetting negative frozen entry. When finalize_purchases
#   later runs bulk UPDATE (is_frozen=False), the original and
#   reversal cancel each other out -- cached balances stay correct.
#
# INVARIANTS:
#   - Every refund/early-finalize creates EVEN number of ledger entries
#   - SUM(all ledgers) = 0 after each operation
#   - Free practices (paid_cents=0) get zero-amount entries (proof of path)
#   - Purchase.status guards against double processing (idempotency)
#
# SESSION RULES:
#   No session.commit() (P-01). Caller manages transaction.
# =============================================================================

from datetime import datetime, timezone
from uuid import UUID

import structlog
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import record_audit
from app.core.config import settings
from app.core.exceptions import NotFoundError
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.payments.models import (
    CompanyLedgerType,
    LedgerStatus,
    MasterLedger,
    Purchase,
    PurchaseStatus,
)
from app.modules.payments.service import (
    record_company_ledger,
    record_master_ledger,
    record_user_ledger,
)
from app.modules.practices.models import Practice
from app.modules.promos.models import Promo, PromoType
from app.modules.waitlist.models import ACTIVE_STATUSES as WL_ACTIVE, WaitlistStatus, Waitlist

logger = structlog.get_logger()


async def _get_master_frozen_amount(
    purchase: Purchase,
    session: AsyncSession,
) -> int:
    """Determine what the master originally received (frozen).

    Loads the promo to determine type. Returns:
    - Company promo: amount_cents (master got full price).
    - Master promo / no promo: paid_cents.
    """
    if purchase.promo_id and purchase.discount_cents > 0:
        promo = await session.get(Promo, purchase.promo_id)
        if promo and promo.type == PromoType.COMPANY.value:
            return purchase.amount_cents

    return purchase.paid_cents


async def _is_company_promo(
    purchase: Purchase,
    session: AsyncSession,
) -> bool:
    """Check if purchase used a company promo."""
    if not purchase.promo_id or purchase.discount_cents == 0:
        return False
    promo = await session.get(Promo, purchase.promo_id)
    return promo is not None and promo.type == PromoType.COMPANY.value


async def refund_booking(
    *,
    booking: Booking,
    practice: Practice,
    session: AsyncSession,
    cancelled_by_master: bool = False,
) -> Purchase:
    """Refund a single booking: 100% return to user.

    No promo / Master promo:
        master_ledger: -paid_cents (frozen, reverses original credit)
        user_ledger:   +paid_cents (refund to user wallet)

    Company promo:
        master_ledger:  -amount_cents (frozen, reverses FULL price credit)
        user_ledger:    +paid_cents   (refund what user actually paid)
        company_ledger: +discount_cents (marketing reversal)

    Even for free practices (paid_cents=0), zero-amount entries
    are created to maintain the double-entry proof-of-path invariant.

    Args:
        booking: The cancelled booking (already status=cancelled).
        practice: The associated practice.
        session: Active async session (caller manages transaction).
        cancelled_by_master: True when master cancelled the practice.

    Returns:
        The updated Purchase (status=REFUNDED).

    Raises:
        NotFoundError: If no purchase exists for this booking (ERR-04).
    """
    # Load purchase with FOR UPDATE (P-12).
    stmt = (
        select(Purchase)
        .where(Purchase.booking_id == booking.id)
        .with_for_update()
    )
    result = await session.execute(stmt)
    # ERR-04: scalar_one_or_none + explicit guard instead of bare
    # scalar_one which raises unhandled NoResultFound -> 500.
    purchase = result.scalar_one_or_none()

    if not purchase:
        raise NotFoundError(
            f"Purchase not found for booking {booking.id}"
        )

    # Idempotency guard: skip if already processed.
    if purchase.status != PurchaseStatus.PENDING.value:
        logger.warning(
            "refund_skipped_not_pending",
            purchase_id=str(purchase.id),
            current_status=purchase.status,
        )
        return purchase

    trigger = "master_cancel" if cancelled_by_master else "user_cancel"
    reason_suffix = f"practice={practice.id}"

    # Determine master frozen amount (depends on promo type).
    master_frozen = await _get_master_frozen_amount(purchase, session)
    is_company = await _is_company_promo(purchase, session)

    # Step 1: Reverse master frozen credit.
    await record_master_ledger(
        user_id=practice.master_id,
        amount_cents=-master_frozen,
        reason=f"refund:{reason_suffix}",
        is_frozen=True,
        practice_id=practice.id,
        session=session,
        # E2: surface as a master-facing transaction -- the booking the master
        # saw as "+ Оплата за практику" was refunded; net for this practice = 0.
        title="Возврат",
        counterparty_id=booking.user_id,
    )

    # Step 2: Refund user (what they actually paid).
    await record_user_ledger(
        user_id=booking.user_id,
        amount_cents=purchase.paid_cents,
        reason=f"refund:{reason_suffix}",
        session=session,
    )

    # Step 3: Company promo marketing reversal.
    if is_company and purchase.discount_cents > 0:
        await record_company_ledger(
            amount_cents=purchase.discount_cents,
            ledger_type=CompanyLedgerType.MARKETING.value,
            reason=f"refund_promo:{reason_suffix}",
            reference_id=purchase.id,
            session=session,
        )

    # Update purchase status.
    purchase.status = PurchaseStatus.REFUNDED.value

    # Audit.
    await record_audit(
        event="purchase_refunded",
        actor_id=booking.user_id,
        actor_type="system" if cancelled_by_master else "user",
        target_type="purchase",
        target_id=purchase.id,
        data={
            "practice_id": str(practice.id),
            "booking_id": str(booking.id),
            "refunded_cents": purchase.paid_cents,
            "master_reversal_cents": master_frozen,
            "marketing_reversal_cents": purchase.discount_cents if is_company else 0,
            "trigger": trigger,
        },
        session=session,
    )

    logger.info(
        "booking_refunded",
        purchase_id=str(purchase.id),
        booking_id=str(booking.id),
        practice_id=str(practice.id),
        user_id=str(booking.user_id),
        refunded_cents=purchase.paid_cents,
        master_reversal_cents=master_frozen,
        trigger=trigger,
    )

    return purchase


async def early_finalize_booking(
    *,
    booking: Booking,
    practice: Practice,
    session: AsyncSession,
) -> Purchase:
    """Early-finalize a single booking: master keeps the money.

    Used when a user cancels within the deadline window (< 24h).
    The master receives the funds immediately (minus commission),
    rather than waiting for practice finalization.

    No promo / Master promo:
        master_ledger: -paid_cents (frozen, reverses original credit)
        master_ledger: +paid_cents (available, adds to spendable balance)
        master_ledger: -commission  (available, platform fee)
        company_ledger: +commission (platform revenue)

    Company promo:
        master_ledger: -amount_cents (frozen, reverses FULL price)
        master_ledger: +amount_cents (available, FULL price)
        master_ledger: -commission   (available, on paid_cents only)
        company_ledger: +commission  (on paid_cents only)
        (marketing debit stays -- practice was "consumed")

    Even for free practices (paid_cents=0), zero-amount entries
    are created to maintain the double-entry proof-of-path invariant.

    Args:
        booking: The cancelled booking (already status=cancelled).
        practice: The associated practice.
        session: Active async session (caller manages transaction).

    Returns:
        The updated Purchase (status=COMPLETED).

    Raises:
        NotFoundError: If no purchase exists for this booking (ERR-04).
    """
    # Load purchase with FOR UPDATE (P-12).
    stmt = (
        select(Purchase)
        .where(Purchase.booking_id == booking.id)
        .with_for_update()
    )
    result = await session.execute(stmt)
    # ERR-04: scalar_one_or_none + explicit guard instead of bare
    # scalar_one which raises unhandled NoResultFound -> 500.
    purchase = result.scalar_one_or_none()

    if not purchase:
        raise NotFoundError(
            f"Purchase not found for booking {booking.id}"
        )

    # Idempotency guard: skip if already processed.
    if purchase.status != PurchaseStatus.PENDING.value:
        logger.warning(
            "early_finalize_skipped_not_pending",
            purchase_id=str(purchase.id),
            current_status=purchase.status,
        )
        return purchase

    reason_suffix = f"practice={practice.id}"
    # L-07 fix: pure integer math -- no float intermediate.
    # Commission on live money only (paid_cents).
    commission = purchase.paid_cents * settings.commission_percent // 100

    # Determine master frozen amount (depends on promo type).
    master_frozen = await _get_master_frozen_amount(purchase, session)

    # Step 1: Reverse the original frozen credit.
    await record_master_ledger(
        user_id=practice.master_id,
        amount_cents=-master_frozen,
        reason=f"late_cancel_reversal:{reason_suffix}",
        is_frozen=True,
        practice_id=practice.id,
        session=session,
    )

    # Step 2: Add to available balance (unfrozen).
    await record_master_ledger(
        user_id=practice.master_id,
        amount_cents=master_frozen,
        reason=f"late_cancel_earnings:{reason_suffix}",
        is_frozen=False,
        practice_id=practice.id,
        session=session,
    )

    # Step 3: Deduct commission (double-entry with company).
    # Steps 1 & 2 above (frozen reversal + available credit) are internal
    # plumbing -- they net to the sale already shown at booking time, so they
    # stay untitled and out of the feed. Only the commission is a new
    # master-facing transaction.
    await record_master_ledger(
        user_id=practice.master_id,
        amount_cents=-commission,
        reason=f"commission:{reason_suffix}",
        is_frozen=False,
        practice_id=practice.id,
        session=session,
        title="Комиссия",
    )
    await record_company_ledger(
        amount_cents=commission,
        ledger_type=CompanyLedgerType.COMMISSION.value,
        reason=f"commission:{reason_suffix}",
        reference_id=purchase.id,
        session=session,
    )

    # Update purchase.
    now = datetime.now(timezone.utc)
    purchase.status = PurchaseStatus.COMPLETED.value
    purchase.commission_cents = commission
    purchase.completed_at = now

    # Audit.
    await record_audit(
        event="purchase_completed",
        actor_id=booking.user_id,
        actor_type="user",
        target_type="purchase",
        target_id=purchase.id,
        data={
            "practice_id": str(practice.id),
            "booking_id": str(booking.id),
            "paid_cents": purchase.paid_cents,
            "master_amount": master_frozen,
            "commission_cents": commission,
            "trigger": "late_cancel",
        },
        session=session,
    )

    logger.info(
        "booking_early_finalized",
        purchase_id=str(purchase.id),
        booking_id=str(booking.id),
        practice_id=str(practice.id),
        user_id=str(booking.user_id),
        paid_cents=purchase.paid_cents,
        master_amount=master_frozen,
        commission_cents=commission,
    )

    return purchase


async def refund_all_bookings_for_practice(
    *,
    practice: Practice,
    session: AsyncSession,
) -> int:
    """Refund all active bookings when master cancels a practice.

    For each confirmed/pending booking:
    1. Set booking status -> cancelled
    2. Call refund_booking (double-entry reversal)
    3. Cancel its Zoom registrant (cancel_registrant_for_booking: our row
       cancelled, the Zoom-side cancel queued for the retry poller -- BE-100)

    Also clears the waitlist: all active entries -> left.
    Recalculates current_participants -> 0 (Frontend Backlog A-03).

    Args:
        practice: The practice being cancelled (already locked FOR UPDATE).
        session: Active async session (caller manages transaction).

    Returns:
        Number of bookings refunded.
    """
    # Load all active bookings with FOR UPDATE (P-12).
    from app.modules.zoom.service import cancel_registrant_for_booking

    stmt = (
        select(Booking)
        .where(
            Booking.practice_id == practice.id,
            Booking.status.in_({
                BookingStatus.PENDING.value,
                BookingStatus.CONFIRMED.value,
            }),
        )
        .with_for_update()
    )
    result = await session.execute(stmt)
    bookings = list(result.scalars().all())

    now = datetime.now(timezone.utc)
    refunded_count = 0

    for booking in bookings:
        booking.status = BookingStatus.CANCELLED.value
        booking.cancelled_at = now
        booking.cancellation_reason = "Practice cancelled by master"

        await refund_booking(
            booking=booking,
            practice=practice,
            session=session,
            cancelled_by_master=True,
        )
        # BE-100: the booking's Zoom registrant is cancelled the way
        # cancel_booking and block_student cancel it -- our row goes
        # cancelled here and the Zoom-side cancel is queued for the retry
        # poller (no Zoom HTTP from this call; see
        # cancel_registrant_for_booking and its KNOWN CEILING for the one
        # race in which this transaction still waits on someone else's).
        # Until BE-100 this path set CANCELLED past the registrant: the row
        # stayed live, and our own pages kept handing its link out. The
        # import above is lazy, the same shape as the other two callers.
        await cancel_registrant_for_booking(booking, session)
        refunded_count += 1

    # Clear waitlist: all active entries -> left.
    wl_stmt = (
        update(Waitlist)
        .where(
            Waitlist.practice_id == practice.id,
            Waitlist.status.in_(WL_ACTIVE),
        )
        .values(status=WaitlistStatus.LEFT.value)
    )
    wl_result = await session.execute(wl_stmt)
    waitlist_cleared = wl_result.rowcount  # type: ignore[union-attr]

    # Update cached participant count (Frontend Backlog A-03).
    # Lazy import to avoid circular dependency:
    # bookings.service -> payments.refund -> bookings.service.
    from app.modules.bookings.service import recalculate_participants
    await recalculate_participants(practice.id, session)

    logger.info(
        "practice_bookings_refunded",
        practice_id=str(practice.id),
        master_id=str(practice.master_id),
        refunded_count=refunded_count,
        waitlist_cleared=waitlist_cleared,
    )

    return refunded_count
