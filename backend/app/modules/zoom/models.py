# =============================================================================
# VELO Backend -- Zoom Integration Models (E21 step A)
# =============================================================================
#
# Three tables, one purpose: turn "booked" into "actually present, for how
# long" via Zoom, without trusting Zoom to tell us who the host is.
#
# ZoomMeeting      -- 1:1 with Practice. Zoom's own meeting identity + our
#                     view of whether creation/sync last succeeded.
# ZoomRegistrant   -- 1 row per booking (role=student) PLUS one row per
#                     practice for the master (role=host, booking_id=NULL).
#                     We register the master through the SAME Zoom flow as
#                     students specifically so host-exclusion is OUR OWN
#                     explicit fact, not something we infer from any
#                     Zoom-provided field (there isn't one -- E21 research).
# ZoomAttendanceSegment -- append-only, RAW report rows. Zoom returns
#                     MULTIPLE rows per person on rejoin and does not sum
#                     them; we do, in the attendance-decision step that
#                     lands after this one. No updated_at (immutable
#                     journal, same shape as UserLedger/MasterLedger in
#                     payments/models.py).
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
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.core.mixins import JSONBMixin, TimestampMixin, UUIDMixin


class ZoomMeetingStatus(enum.StrEnum):
    """Lifecycle of our view of a practice's Zoom meeting.

    active            -- created successfully, zoom_meeting_id is usable.
    pending_creation   -- ПРОМТ №559: creation deliberately DEFERRED, never
                          attempted yet -- a series child beyond the nearest
                          occurrence (see series_service.py). Distinct from
                          create_failed on purpose: nothing has failed here,
                          so nothing must read as an error to a master
                          looking at a fresh series (requirement A). Picked
                          up by the same retry poller that handles
                          create_failed (retry_poller.py claims both).
    create_failed     -- creation (or a retry) failed; retry_count / last_sync_error
                          record why. The retry poller keeps trying until the cap.
    deleted           -- we deleted the Zoom-side meeting (practice cancelled
                          before it happened).
    """

    ACTIVE = "active"
    PENDING_CREATION = "pending_creation"
    CREATE_FAILED = "create_failed"
    DELETED = "deleted"


class ZoomRegistrantRole(enum.StrEnum):
    """Who this registrant row represents."""

    STUDENT = "student"
    HOST = "host"


class ZoomRegistrantStatus(enum.StrEnum):
    """Our own registrant status -- mirrors Zoom's registrant states, but is
    OURS: correctness of the attendance decision never depends on Zoom
    actually honoring a cancel (E21 plan sec 3 -- Zoom has no DELETE for
    registrants, only a status action, and whether a cancelled registrant's
    link stops working is unconfirmed).
    """

    PENDING = "pending"
    REGISTERED = "registered"
    CREATE_FAILED = "create_failed"
    CANCELLED = "cancelled"


class ZoomMeeting(UUIDMixin, TimestampMixin, Base):
    """One Zoom meeting per practice (1:1)."""

    __tablename__ = "zoom_meetings"

    practice_id: Mapped[UUID] = mapped_column(
        ForeignKey("practices.id", ondelete="CASCADE"),
        unique=True,
        index=True,
    )

    # Zoom's own identifiers. Nullable until creation succeeds.
    zoom_meeting_id: Mapped[str | None] = mapped_column(
        String(64), default=None,
    )
    # Zoom assigns a fresh UUID per run instance (relevant to report lookups
    # on restart) -- informational, not yet consumed by this step.
    zoom_meeting_uuid: Mapped[str | None] = mapped_column(
        String(64), default=None,
    )
    # Snapshot of host_id from the creation response. Secondary defense for
    # host exclusion -- the primary mechanism is ZoomRegistrant.role='host'
    # (see that model's docstring); Zoom exposes no reliable host flag on
    # either the webhook or report surface (E21 research, round 2).
    host_zoom_user_id: Mapped[str | None] = mapped_column(
        String(64), default=None,
    )

    status: Mapped[str] = mapped_column(
        String(20),
        default=ZoomMeetingStatus.CREATE_FAILED.value,
        server_default=ZoomMeetingStatus.CREATE_FAILED.value,
    )
    # Attempts made by the retry poller. Capped at
    # settings.zoom_meeting_create_max_retries -- past the cap the row STAYS
    # status=create_failed (visibly failed), the poller just stops touching
    # it. Never silently retried forever, never silently given up on.
    retry_count: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0",
    )
    last_sync_error: Mapped[str | None] = mapped_column(Text, default=None)

    # E21 step F: set the moment the report poller successfully pulls this
    # meeting's report, regardless of whether any rows came back -- a
    # genuinely-empty result IS success. NULL means "not tried yet" or
    # "tried and Zoom errored", both retryable; distinguishes those from
    # "tried and got a real (possibly empty) answer", which is not
    # retried again. The undecided-bound fallback in the report poller
    # checks this stays NULL past a deadline before giving up on Zoom for
    # that meeting.
    report_ingested_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None,
    )

    def __repr__(self) -> str:
        return (
            f"<ZoomMeeting id={self.id} practice={self.practice_id} "
            f"status={self.status} zoom_id={self.zoom_meeting_id}>"
        )


class ZoomRegistrant(UUIDMixin, TimestampMixin, Base):
    """One registrant on a Zoom meeting -- a student's booking, or the
    practice's own master (role=host, booking_id NULL).

    registration_email is the email WE SENT to Zoom at registration time,
    frozen -- deliberately NOT re-derived from the user's current profile
    later, so the matching ladder (registrant_id -> email -> unmatched, next
    step) always compares against what Zoom actually has on file, even if
    the VELO user changes their email afterward.
    """

    __tablename__ = "zoom_registrants"

    zoom_meeting_id: Mapped[UUID] = mapped_column(
        ForeignKey("zoom_meetings.id", ondelete="CASCADE"),
        index=True,
    )
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )
    # NULL for the master's own host row -- the master isn't booking anything.
    booking_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("bookings.id", ondelete="SET NULL"),
        default=None,
    )

    role: Mapped[str] = mapped_column(
        String(10),
        default=ZoomRegistrantRole.STUDENT.value,
        server_default=ZoomRegistrantRole.STUDENT.value,
    )

    zoom_registrant_id: Mapped[str | None] = mapped_column(
        String(64), default=None,
    )
    registration_email: Mapped[str] = mapped_column(String(255))
    # Zoom sometimes omits the tokenized join_url from the create response
    # (E21 research); may be filled in later via a GET, or on reschedule
    # re-fetch (step D).
    join_url: Mapped[str | None] = mapped_column(Text, default=None)

    status: Mapped[str] = mapped_column(
        String(20),
        default=ZoomRegistrantStatus.PENDING.value,
        server_default=ZoomRegistrantStatus.PENDING.value,
    )

    # Retry bookkeeping (E21 step E, ПРОМТ №520) -- same shape and cap
    # convention as ZoomMeeting.retry_count / last_sync_error. Only the
    # retry poller increments retry_count; the initial attempt at booking
    # time does not.
    retry_count: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0",
    )
    last_sync_error: Mapped[str | None] = mapped_column(Text, default=None)

    __table_args__ = (
        # One ACTIVE registrant per (meeting, user) -- same partial-unique
        # shape as uq_booking_practice_user_active in bookings/models.py.
        # Historical/cancelled duplicates are allowed (e.g. re-registering
        # after a cancel-and-rebook).
        Index(
            "uq_zoom_registrant_meeting_user_active",
            "zoom_meeting_id",
            "user_id",
            unique=True,
            postgresql_where=text("status != 'cancelled'"),
        ),
    )

    def __repr__(self) -> str:
        return (
            f"<ZoomRegistrant id={self.id} meeting={self.zoom_meeting_id} "
            f"user={self.user_id} role={self.role} status={self.status}>"
        )


class ZoomAttendanceSegment(JSONBMixin, UUIDMixin, Base):
    """One raw report row for one person's session, as Zoom returned it.

    Append-only / immutable -- no updated_at, same shape as UserLedger /
    MasterLedger (payments/models.py). A person who rejoins produces
    MULTIPLE rows here; Zoom does not sum them and neither does this table
    -- summing happens in the attendance-decision step that lands after
    this one, by reading every segment matched to a given registrant.

    matched_registrant_row_id is NULL for an unmatched participant -- that
    IS the unmatched bucket (E21 plan sec 6), not a separate table.
    """

    __tablename__ = "zoom_attendance_segments"

    zoom_meeting_id: Mapped[UUID] = mapped_column(
        ForeignKey("zoom_meetings.id", ondelete="CASCADE"),
        index=True,
    )
    matched_registrant_row_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("zoom_registrants.id", ondelete="SET NULL"),
        index=True,
        default=None,
    )
    match_method: Mapped[str | None] = mapped_column(
        String(20), default=None,
    )

    # Zoom's own registrant_id AS RETURNED on this row -- kept even blank,
    # for audit (the whole reason this project needed a live probe: whether
    # this field is populated for an unauthenticated joiner was contested).
    zoom_registrant_id_raw: Mapped[str | None] = mapped_column(
        String(64), default=None,
    )

    join_time: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None,
    )
    leave_time: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None,
    )
    duration_seconds: Mapped[int | None] = mapped_column(
        Integer, default=None,
    )

    # Full raw report row, for audit/debugging beyond the extracted columns
    # above. Mutate ONLY via set_jsonb (JSONBMixin) -- not touched after
    # insert in practice, since these rows are append-only.
    raw_row: Mapped[dict] = mapped_column(
        JSONB, default=dict, server_default="{}",
    )

    # Forward-compat slot: only "report" is written by this step's poller.
    source: Mapped[str] = mapped_column(
        String(20), default="report", server_default="report",
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        index=True,
    )

    def __repr__(self) -> str:
        return (
            f"<ZoomAttendanceSegment id={self.id} "
            f"meeting={self.zoom_meeting_id} "
            f"matched={self.matched_registrant_row_id}>"
        )
