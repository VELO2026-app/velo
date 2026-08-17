# =============================================================================
# VELO Backend -- Payment Models (Phase 6.1, updated Phase 6.4, Phase 6.7)
# =============================================================================
#
# Double-entry bookkeeping: every cent is tracked across three journals.
# Golden rule: SUM(user_ledger + master_ledger + company_ledger) = 0
#
# THREE LEDGERS:
#   UserLedger    -- all movements on a user's wallet (topup, purchase, refund)
#   MasterLedger  -- all movements on a master's earnings (sale, commission, withdrawal)
#   CompanyLedger -- platform revenue (commissions, marketing spend, refunds, fees)
#
# PAYMENT (Phase 6.3):
#   Payment -- external money movements (Stripe topups, withdrawals).
#   Tracks Stripe session/intent IDs for reconciliation.
#   Linked to UserLedger via reason="payment:{payment.id}".
#
# PURCHASE (Phase 6.4, updated Phase 6.7):
#   Purchase -- double-entry record linking a booking to financial flow.
#   Created for EVERY booking (free and paid). Semaphore 1.1 requires
#   COUNT(bookings) == COUNT(purchases) for active records.
#   Phase 6.7: added amount_cents, discount_cents, promo_id for promo support.
#
# AMOUNT CONVENTION (TD-033):
#   All amounts in EUR cents (integer). 1500 = EUR 15.00.
#   Positive = credit, negative = debit.
#   Matches Practice.price_cents already in use since Phase 4.3.
#
# IMMUTABILITY:
#   Ledger rows are append-only. No updated_at, no UPDATEs.
#   Status transitions (pending -> done/cancelled) are the ONLY mutation,
#   handled via UPDATE on the status column only.
#   UUIDMixin used for id. No TimestampMixin (no updated_at needed).
#   Exception: Purchase uses TimestampMixin (status + commission updated on finalize).
#
# BALANCE CACHE:
#   User.balance_cents           = SUM(user_ledger.amount_cents) WHERE status='done'
#   MasterProfile.frozen_cents   = SUM(master_ledger.amount_cents) WHERE status='done' AND is_frozen=true
#   MasterProfile.available_cents= SUM(master_ledger.amount_cents) WHERE status='done' AND is_frozen=false
#   Updated by listeners (Phase 6.2), NOT by direct writes.
#
# FK POLICY (CRITICAL-02):
#   Financial tables use ondelete="RESTRICT" on user_id, practice_id,
#   booking_id FKs. Deleting a user/practice/booking that has financial
#   records MUST fail -- audit trail is preserved for 5-year retention.
#   Only promo_id and MasterLedger.practice_id use SET NULL (soft refs).
#
# SESSION RULES:
#   No session.commit() in service functions (P-01).
# =============================================================================

import enum
from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.core.mixins import TimestampMixin, UUIDMixin


# -- Enums (P-09: StrEnum) --------------------------------------------------


class LedgerStatus(enum.StrEnum):
    """Transaction lifecycle status.

    PENDING: awaiting external confirmation (e.g. Stripe webhook).
    DONE:    confirmed and included in balance calculations.
    """

    PENDING = "pending"
    DONE = "done"


class CompanyLedgerType(enum.StrEnum):
    """Types of company ledger entries.

    COMMISSION:     platform fee from completed practices (15%).
    MARKETING:      company-funded promo spending.
    REFUND:         money returned to users from company funds.
    WITHDRAWAL_FEE: fixed fee charged on master withdrawals.
    """

    COMMISSION = "commission"
    MARKETING = "marketing"
    REFUND = "refund"
    WITHDRAWAL_FEE = "withdrawal_fee"
    TOPUP = "topup"


class PaymentDirection(enum.StrEnum):
    """Direction of external money movement.

    IN:  money enters the system (Stripe topup).
    OUT: money leaves the system (withdrawal to bank).
    """

    IN = "in"
    OUT = "out"


class PaymentStatus(enum.StrEnum):
    """External payment lifecycle status.

    PENDING:   Stripe session created, awaiting user action.
    CONFIRMED: Stripe webhook confirmed payment success.
    FAILED:    Payment failed or session expired.
    REFUNDED:  Payment refunded via Stripe.
    """

    PENDING = "pending"
    CONFIRMED = "confirmed"
    FAILED = "failed"
    REFUNDED = "refunded"


class PurchaseStatus(enum.StrEnum):
    """Purchase lifecycle status.

    PENDING:   Practice not yet completed. Master funds frozen.
    COMPLETED: Practice finalized. Commission deducted, funds unfrozen.
    REFUNDED:  User refund (cancellation or master cancellation).
    CANCELLED: Booking cancelled without refund.
    """

    PENDING = "pending"
    COMPLETED = "completed"
    REFUNDED = "refunded"
    CANCELLED = "cancelled"


# -- Ledger Models -----------------------------------------------------------


class UserLedger(UUIDMixin, Base):
    """User wallet journal -- every movement on a user's balance.

    Positive amount_cents = credit (topup, refund).
    Negative amount_cents = debit (purchase, transfer to master balance).
    """

    __tablename__ = "user_ledger"

    # -- Owner --
    # CRITICAL-02: RESTRICT prevents deleting a user who has financial records.
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"),
        index=True,
    )

    # -- Amount in EUR cents --
    amount_cents: Mapped[int] = mapped_column(Integer)

    # -- Status --
    status: Mapped[str] = mapped_column(
        String(20),
        default=LedgerStatus.DONE.value,
        server_default=LedgerStatus.DONE.value,
    )

    # -- Context --
    reason: Mapped[str] = mapped_column(String(200))
    notes: Mapped[str | None] = mapped_column(Text, default=None)

    # -- Timestamp (immutable, no updated_at) --
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        index=True,
    )

    def __repr__(self) -> str:
        return (
            f"<UserLedger id={self.id} user={self.user_id} "
            f"amount={self.amount_cents} status={self.status}>"
        )


class MasterLedger(UUIDMixin, Base):
    """Master earnings journal -- sales, commissions, withdrawals.

    Positive amount_cents = credit (sale).
    Negative amount_cents = debit (commission, withdrawal).
    """

    __tablename__ = "master_ledger"

    # -- Owner --
    # CRITICAL-02: RESTRICT prevents deleting a user who has financial records.
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"),
        index=True,
    )

    # -- Amount in EUR cents --
    amount_cents: Mapped[int] = mapped_column(Integer)

    # -- Frozen flag --
    # True = funds locked until practice completes.
    # False = funds available for withdrawal.
    is_frozen: Mapped[bool] = mapped_column(
        Boolean,
        default=True,
        server_default="true",
    )

    # -- Status --
    status: Mapped[str] = mapped_column(
        String(20),
        default=LedgerStatus.DONE.value,
        server_default=LedgerStatus.DONE.value,
    )

    # -- Context --
    reason: Mapped[str] = mapped_column(String(200))
    practice_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("practices.id", ondelete="SET NULL"),
        index=True,
        default=None,
    )
    notes: Mapped[str | None] = mapped_column(Text, default=None)

    # -- Master-facing transaction projection (E2) --
    # title is the human-readable label shown in the master's transaction
    # feed. ONLY rows the master should see as a "transaction" carry a title;
    # internal plumbing (frozen<->available reversals, withdrawal holds) leaves
    # it NULL and is filtered out of both the feed and the income sum.
    # counterparty_id is the other party to the movement (the paying student
    # for a sale/refund); NULL for platform-side rows such as commission.
    # SET NULL: the audit amount stays even if the counterparty user is gone.
    title: Mapped[str | None] = mapped_column(String(200), default=None)
    counterparty_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        index=True,
        default=None,
    )

    # -- Timestamp (immutable, no updated_at) --
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        index=True,
    )

    def __repr__(self) -> str:
        return (
            f"<MasterLedger id={self.id} user={self.user_id} "
            f"amount={self.amount_cents} frozen={self.is_frozen} "
            f"status={self.status}>"
        )


class CompanyLedger(UUIDMixin, Base):
    """Platform revenue journal -- commissions, marketing, refunds, fees.

    No user_id -- this is the platform's own account.
    reference_id links back to the purchase/withdrawal that triggered
    this entry for audit trail purposes.
    """

    __tablename__ = "company_ledger"

    # -- Amount in EUR cents --
    amount_cents: Mapped[int] = mapped_column(Integer)

    # -- Type --
    type: Mapped[str] = mapped_column(String(20))

    # -- Status --
    status: Mapped[str] = mapped_column(
        String(20),
        default=LedgerStatus.DONE.value,
        server_default=LedgerStatus.DONE.value,
    )

    # -- Context --
    reason: Mapped[str] = mapped_column(String(200))
    reference_id: Mapped[UUID | None] = mapped_column(
        default=None,
        index=True,
    )

    # -- Timestamp (immutable, no updated_at) --
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        index=True,
    )

    def __repr__(self) -> str:
        return (
            f"<CompanyLedger id={self.id} type={self.type} "
            f"amount={self.amount_cents} status={self.status}>"
        )


# -- Payment Model (Phase 6.3) ----------------------------------------------


class Payment(UUIDMixin, Base):
    """External money movement -- Stripe topups and bank withdrawals.

    Tracks the lifecycle of external transactions. Linked to ledger
    entries via reason="payment:{payment.id}".

    STATUS TRANSITIONS:
      pending -> confirmed  (Stripe webhook: checkout.session.completed)
      pending -> failed     (Stripe webhook: session expired / payment failed)
      confirmed -> refunded (manual Stripe refund, future phase)

    IDEMPOTENCY:
      stripe_session_id is unique -- duplicate webhooks are safe.
    """

    __tablename__ = "payments"

    # -- Owner --
    # CRITICAL-02: RESTRICT prevents deleting a user who has payment records.
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"),
        index=True,
    )

    # -- Direction --
    direction: Mapped[str] = mapped_column(String(5))

    # -- Amount in cents --
    amount_cents: Mapped[int] = mapped_column(Integer)

    # -- Currency (configurable, default "eur") --
    currency: Mapped[str] = mapped_column(
        String(3),
        default="eur",
        server_default="eur",
    )

    # -- Status --
    status: Mapped[str] = mapped_column(
        String(20),
        default=PaymentStatus.PENDING.value,
        server_default=PaymentStatus.PENDING.value,
    )

    # -- Stripe identifiers --
    stripe_session_id: Mapped[str | None] = mapped_column(
        String(200),
        unique=True,
        index=True,
        default=None,
    )
    stripe_payment_intent_id: Mapped[str | None] = mapped_column(
        String(200),
        default=None,
    )

    # -- Metadata (freeform JSONB for Stripe event data) --
    stripe_metadata: Mapped[dict | None] = mapped_column(
        "stripe_metadata",
        JSONB,
        default=None,
    )

    # -- Timestamps --
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        index=True,
    )
    confirmed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        default=None,
    )

    def __repr__(self) -> str:
        return (
            f"<Payment id={self.id} user={self.user_id} "
            f"direction={self.direction} amount={self.amount_cents} "
            f"status={self.status}>"
        )


# -- Purchase Model (Phase 6.4, updated Phase 6.7) --------------------------


class Purchase(UUIDMixin, TimestampMixin, Base):
    """Purchase -- double-entry record linking a booking to financial flow.

    Created for EVERY booking (free and paid). Semaphore 1.1 requires
    COUNT(bookings) == COUNT(purchases) for active records.

    Double-entry on creation:
        user_ledger:   -paid_cents (debit from user wallet)
        master_ledger: +paid_cents (credit to master, frozen)
        company_ledger: -discount_cents (marketing, company promo only)

    Double-entry on finalization:
        master_ledger: unfreeze (UPDATE is_frozen=False)
        master_ledger: -commission_cents (debit from master available)
        company_ledger: +commission_cents (credit to company)

    Phase 6.7 additions:
        amount_cents:   full practice price before discount.
        discount_cents: promo discount amount (0 if no promo).
        promo_id:       FK to promos table (nullable).
        Invariant: paid_cents = amount_cents - discount_cents.
    """

    __tablename__ = "purchases"

    # -- References --
    # CRITICAL-02: RESTRICT on all three -- audit trail must be preserved.
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"),
        index=True,
    )
    practice_id: Mapped[UUID] = mapped_column(
        ForeignKey("practices.id", ondelete="RESTRICT"),
        index=True,
    )
    booking_id: Mapped[UUID] = mapped_column(
        ForeignKey("bookings.id", ondelete="RESTRICT"),
        unique=True,
    )

    # -- Promo (Phase 6.7) --
    promo_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("promos.id", ondelete="SET NULL"),
        index=True,
        default=None,
    )

    # -- Financial --
    amount_cents: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0",
    )
    discount_cents: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0",
    )
    paid_cents: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0",
    )
    currency: Mapped[str] = mapped_column(
        String(3), default="eur", server_default="eur",
    )
    commission_cents: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0",
    )

    # -- Status --
    status: Mapped[str] = mapped_column(
        String(20),
        default=PurchaseStatus.PENDING.value,
        server_default=PurchaseStatus.PENDING.value,
    )

    # -- Completion --
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None,
    )

    def __repr__(self) -> str:
        return (
            f"<Purchase id={self.id} user={self.user_id} "
            f"practice={self.practice_id} amount={self.amount_cents} "
            f"discount={self.discount_cents} paid={self.paid_cents} "
            f"status={self.status}>"
        )
