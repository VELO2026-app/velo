# =============================================================================
# VELO Backend -- Booking Model (Phase 5.1, updated B-04)
# =============================================================================
#
# A booking ties a user to a practice session.
#
# STATE MACHINE (enforced in service.py):
#   confirmed -> attended, no_show, cancelled
#   attended  -> (terminal)
#   no_show   -> (terminal)
#   cancelled -> (terminal)
#
# CAPACITY:
#   Checked via COUNT of active bookings (not current_participants).
#   See TD-034.
#
# PURCHASE:
#   purchase_id FK -> purchases.id (added Phase 6.4).
#
# ATTENDANCE:
#   joined_at / left_at included for Phase 5.4 (attendance tracking).
#
# UNIQUE INDEX (H-02):
#   Partial unique index on (practice_id, user_id) WHERE status != 'cancelled'.
#   This allows re-booking after cancellation while preventing duplicate
#   active bookings. Old absolute UniqueConstraint blocked re-booking.
#
# UNIQUE INDEX (B-04):
#   Partial unique index on purchase_id WHERE purchase_id IS NOT NULL.
#   Enforces 1:1 Booking <-> Purchase at the DB level from the Booking side.
#   Purchase.booking_id already has unique=True (the other side of the 1:1).
#   Partial (NOT NULL filter) because purchase_id is nullable -- NULL rows
#   are excluded from uniqueness checks in PostgreSQL by default, but we
#   make the intent explicit via the WHERE clause for clarity.
#   Migration: 2026_03_11_f3a4b5c6d7e8_unique_booking_purchase_id.
#   Replaces the plain B-tree index ix_bookings_purchase_id (dropped in
#   that migration) -- the unique index already covers lookup performance.
#
# INDEXES (R-07):
#   practice_id and user_id have individual B-tree indexes for:
#   - COUNT(bookings) WHERE practice_id=X (capacity check, every booking)
#   - SELECT bookings WHERE user_id=X (GET /bookings/me)
#   The partial unique index does NOT cover single-column lookups.
# =============================================================================

import enum
from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.core.mixins import TimestampMixin, UUIDMixin


class BookingStatus(enum.StrEnum):
    """Booking lifecycle statuses."""

    PENDING = "pending"
    CONFIRMED = "confirmed"
    ATTENDED = "attended"
    NO_SHOW = "no_show"
    CANCELLED = "cancelled"


class Booking(UUIDMixin, TimestampMixin, Base):
    """A user's booking for a practice session."""

    __tablename__ = "bookings"

    # -- References --
    # R-07: index=True for capacity check (COUNT WHERE practice_id=X).
    practice_id: Mapped[UUID] = mapped_column(
        ForeignKey("practices.id", ondelete="CASCADE"),
        index=True,
    )
    # R-07: index=True for user's booking list (GET /bookings/me).
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )

    # -- Status --
    status: Mapped[str] = mapped_column(
        String(20),
        default=BookingStatus.PENDING.value,
        server_default=BookingStatus.PENDING.value,
    )

    # -- Purchase --
    # B-04: index moved to __table_args__ as a partial unique index.
    # Do NOT add index=True here -- that would create a duplicate plain
    # B-tree index alongside the unique index defined below.
    purchase_id: Mapped[UUID | None] = mapped_column(
        default=None,
    )

    # -- Cancellation --
    cancelled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None,
    )
    cancellation_reason: Mapped[str | None] = mapped_column(
        Text, default=None,
    )

    # -- Attendance (Phase 5.4) --
    joined_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None,
    )
    left_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None,
    )

    # -- PRE check-in skip (B2) --
    # The user persistently chose to skip their PRE check-in for this booking.
    # Was client-only before; persisting it keeps the dashboard banner / check-in
    # prompt hidden across sessions and devices. NOT NULL, defaults false.
    checkin_skipped: Mapped[bool] = mapped_column(
        default=False,
        server_default=text("false"),
    )

    # -- Zoom attendance (E21) --
    # Nullable: populated only once the Zoom report has been ingested for
    # this booking. NULL means "not decided via Zoom yet" -- the finalize
    # choke point (bookings/service.py) falls back to the legacy join_at/
    # checkin_skipped proxy above when this stays NULL, so a Zoom outage
    # never leaves a booking undecided forever. Summed across every matched
    # ZoomAttendanceSegment row (Zoom returns multiple rows per person on
    # rejoin and does not sum them itself).
    zoom_minutes_present: Mapped[int | None] = mapped_column(
        Integer, default=None,
    )
    # 'zoom_report' | 'legacy_proxy' -- which mechanism actually decided
    # attended/no_show for this booking. Not an enum type (matches this
    # model's own `status` column convention -- plain string, validated in
    # the service layer).
    attendance_decided_via: Mapped[str | None] = mapped_column(
        String(20), default=None,
    )

    __table_args__ = (
        # H-02: prevents duplicate active bookings, allows re-booking
        # after cancellation.
        Index(
            "uq_booking_practice_user_active",
            "practice_id",
            "user_id",
            unique=True,
            postgresql_where=text("status != 'cancelled'"),
        ),
        # B-04: enforces 1:1 Booking <-> Purchase from the Booking side.
        # WHERE purchase_id IS NOT NULL: NULL rows are allowed (booking
        # exists before purchase is created), but once set, must be unique.
        Index(
            "uq_booking_purchase_id",
            "purchase_id",
            unique=True,
            postgresql_where=text("purchase_id IS NOT NULL"),
        ),
    )

    def __repr__(self) -> str:
        return (
            f"<Booking id={self.id} practice={self.practice_id} "
            f"user={self.user_id} status={self.status}>"
        )
