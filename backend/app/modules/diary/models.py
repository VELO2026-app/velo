# =============================================================================
# VELO Backend -- Diary Models (Phase 8.1-8.3, + Diary redesign iteration)
# =============================================================================
#
# Checkin:    user's mood before a practice session.
# Feedback:   user's rating after a completed practice.
# DiaryEntry: personal journal entry, optionally linked to a practice.
# DiaryEvent: append-only timeline journal -- the unified feed backbone.
#
# CHECKIN LIFECYCLE:
#   Window opens: scheduled_at - checkin_window_hours (config).
#   Window closes: scheduled_at.
#   Condition: booking.status == confirmed.
#   Insert-once: one checkin per booking, immutable. Resubmission rejected.
#
# FEEDBACK LIFECYCLE:
#   Window opens: practice.status == completed.
#   Window closes: scheduled_at + duration_minutes + feedback_window_hours.
#   Condition: booking.status == attended.
#   Insert-once: one feedback per (practice, user), immutable. Resubmission
#   rejected.
#
# DIARY ENTRY:
#   No time window. User can create/edit/delete anytime.
#   Optional link to practice (validated: practice exists + user has booking).
#   entry_type: note (free-form) or dream ("Сонник"). dream input is wired
#     on the backend now; the UI composer creates note only for this
#     iteration (front sub-flow #3 will enable dream input later).
#   practice_phase: before/after -- temporal marker relative to the linked
#     practice (the "Перед практикой:" / "После практики:" caption). Only
#     meaningful when practice_id is set.
#   SOFT DELETE: DELETE sets is_deleted=True (hide), not a physical delete.
#     Personal data stays recoverable and future relations can still point
#     at the matching DiaryEvent (which is hidden in parallel, never dropped).
#
# DIARY EVENT (Diary redesign iteration):
#   A denormalized, append-only timeline record. Every user-visible activity
#   projects exactly one row here at creation time. Source tables (Booking,
#   Practice, Checkin, Feedback, DiaryEntry) remain the source of truth; this
#   table is a read-optimized index that powers GET /diary/feed in a single
#   query (order by occurred_at, filter by kind/date, ilike on text_search).
#
#   APPEND-ONLY vs UPSERT (decided with product):
#     - Per-fact kinds (booking_confirmed, booking_cancelled_by_user,
#       practice_rescheduled, practice_cancelled_by_master, practice_outcome)
#       are immutable facts: each occurrence is its own row. A booking that is
#       made then cancelled leaves TWO rows -- honest chronology.
#     - Per-object kinds map 1:1 to a source object:
#       * checkin / feedback are append-once -- the source is immutable
#         (resubmission rejected), so the event is created once and never
#         refreshed.
#       * note / dream map to an editable source. On edit we UPDATE the
#         existing event (refresh snapshot + text_search) instead of
#         appending -- the feed card shows the current state.
#       On soft-delete (note/dream) we set is_deleted=True.
#
#   snapshot (JSONB): a point-in-time copy of the fields needed to render the
#     feed card WITHOUT joins (practice title, master name, scheduled_at as it
#     was at the time, mood/rating, content preview). Mutate ONLY via
#     set_jsonb("snapshot", deepcopy(...)) -- JSONBMixin contract.
#   source_type / source_id: pointer back to the originating row so the card
#     can deep-link ("провалиться" into the practice / future replay archive).
#   text_search: denormalized lowercase text for ilike search (ORM only, no
#     pg_trgm/tsvector -- alpha data volumes do not need them).
#
#   RELATIONS SOCKET (future, NOT created this iteration):
#     DiaryRelation / DiaryRelationItem will reference DiaryEvent.id via a
#     plain FK -- a single id-space, zero polymorphism. The append-only
#     journal is the substrate the future LLM relation finder reads from.
#
# CHECK CONSTRAINTS (WARNING-9 fix + 11.3 fix + redesign):
#   DB-level validation for mood, rating, check_type, entry_type,
#   practice_phase, and event kind columns.
#   Defense-in-depth: Pydantic validates at API level, CheckConstraint
#   validates at DB level for non-API write paths (seed.py, tests).
#
# SESSION RULES:
#   No session.commit() in service (P-01). Router manages transaction.
# =============================================================================

import enum

from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.core.mixins import JSONBMixin, TimestampMixin, UUIDMixin


class CheckType(enum.StrEnum):
    """Check-in timing relative to practice.

    PRE:  before practice (MVP).
    POST: after practice (future rose socket).
    """

    PRE = "pre"
    POST = "post"


class DiaryEntryType(enum.StrEnum):
    """Type of a personal diary entry.

    NOTE:  free-form journal note (Дневник). The ONLY type the ledger
           composer creates this iteration.
    DREAM: dream journal entry (Сонник). Wired on the backend now (model,
           constraint, schema, event kind, filter chip) but not creatable
           from the UI composer yet -- front sub-flow #3 enables the input.
    """

    NOTE = "note"
    DREAM = "dream"


class PracticePhase(enum.StrEnum):
    """Temporal phase of a diary entry relative to its linked practice.

    BEFORE: written before the practice ("Перед практикой: ...").
    AFTER:  written after the practice ("После практики: ...").
    Only meaningful when DiaryEntry.practice_id is set; NULL otherwise.
    """

    BEFORE = "before"
    AFTER = "after"


class DiaryEventKind(enum.StrEnum):
    """Kind of a timeline event in the unified diary feed.

    Per-fact (append-only, one row per occurrence):
      BOOKING_CONFIRMED          -- user booked a practice.
      BOOKING_CANCELLED_BY_USER  -- user cancelled their own booking.
      PRACTICE_RESCHEDULED       -- master moved the practice time.
      PRACTICE_CANCELLED_BY_MASTER -- master cancelled the practice.
      PRACTICE_OUTCOME           -- practice finalized (attended / no_show).

    Per-object, one row per source object:
      CHECKIN   -- mood check-in. Append-once: the source is immutable
                   (resubmission rejected), so this event is never refreshed.
      FEEDBACK  -- post-practice feedback. Append-once, same as CHECKIN.
      NOTE      -- free-form diary entry. Refreshed on edit (source editable).
      DREAM     -- dream diary entry. Refreshed on edit (source editable).
      THREAD_STARTED -- a conversation with a master began. Per-object
                   (one row per thread), written by the chat proxy from the
                   `created` flag comms returns on create-or-get. Never
                   refreshed: a conversation starts once.
    """

    BOOKING_CONFIRMED = "booking_confirmed"
    BOOKING_CANCELLED_BY_USER = "booking_cancelled_by_user"
    PRACTICE_RESCHEDULED = "practice_rescheduled"
    PRACTICE_CANCELLED_BY_MASTER = "practice_cancelled_by_master"
    PRACTICE_OUTCOME = "practice_outcome"
    CHECKIN = "checkin"
    FEEDBACK = "feedback"
    NOTE = "note"
    DREAM = "dream"
    THREAD_STARTED = "thread_started"


class DiaryEventSourceType(enum.StrEnum):
    """Originating table for a DiaryEvent's source_id pointer."""

    BOOKING = "booking"
    PRACTICE = "practice"
    CHECKIN = "checkin"
    FEEDBACK = "feedback"
    DIARY_ENTRY = "diary_entry"
    # The source row lives in comms, not here: source_id is the comms
    # thread id. velo keeps its own pointer to it (chats.ChatThread) --
    # this column stays the diary's uniform "what produced me" axis.
    THREAD = "thread"


# ===================================================================
# Checkin (Phase 8.1)
# ===================================================================


class Checkin(UUIDMixin, TimestampMixin, Base):
    """User's mood check-in linked to a booking.

    One pre-check-in per booking. Immutable once submitted: created only
    within the window (scheduled_at - checkin_window_hours .. scheduled_at).
    A resubmission is rejected (409) -- the recorded data point never changes.
    """

    __tablename__ = "checkins"

    # -- References --
    practice_id: Mapped[UUID] = mapped_column(
        ForeignKey("practices.id", ondelete="CASCADE"),
        index=True,
    )
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )
    booking_id: Mapped[UUID] = mapped_column(
        ForeignKey("bookings.id", ondelete="CASCADE"),
        index=True,
    )

    # -- Check-in data --
    # mood is a 1..10 score (slider). The icon/label shown in the UI is
    # derived from the range: 1-3 / 4-7 / 8-10. Range enforced by
    # ck_checkin_mood below.
    mood: Mapped[int] = mapped_column(
        Integer, nullable=False,
    )
    comment: Mapped[str | None] = mapped_column(
        Text, default=None,
    )

    # -- Type (pre/post rose socket) --
    check_type: Mapped[str] = mapped_column(
        String(10),
        default=CheckType.PRE.value,
        server_default=CheckType.PRE.value,
    )

    __table_args__ = (
        UniqueConstraint(
            "booking_id",
            "check_type",
            name="uq_checkin_booking_type",
        ),
        CheckConstraint(
            "mood BETWEEN 1 AND 10",
            name="ck_checkin_mood",
        ),
        # 11.3 fix: check_type had no DB-level constraint. Non-API write
        # paths could insert arbitrary strings without detection.
        CheckConstraint(
            "check_type IN ('pre', 'post')",
            name="ck_checkin_check_type",
        ),
    )

    def __repr__(self) -> str:
        return (
            f"<Checkin id={self.id} booking={self.booking_id} "
            f"mood={self.mood} type={self.check_type}>"
        )


# ===================================================================
# Feedback (Phase 8.2)
# ===================================================================


class Feedback(UUIDMixin, TimestampMixin, Base):
    """User's feedback after a completed practice.

    One feedback per user per practice. Immutable once submitted: created
    only within the window (practice end .. practice end +
    feedback_window_hours). A resubmission is rejected (409).
    """

    __tablename__ = "feedbacks"

    # -- References --
    practice_id: Mapped[UUID] = mapped_column(
        ForeignKey("practices.id", ondelete="CASCADE"),
        index=True,
    )
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )
    booking_id: Mapped[UUID] = mapped_column(
        ForeignKey("bookings.id", ondelete="CASCADE"),
        index=True,
    )

    # -- Feedback data --
    # rating is a 1..10 score (slider). The icon/label shown in the UI is
    # derived from the range: 1-3 / 4-7 / 8-10. Range enforced by
    # ck_feedback_rating below.
    rating: Mapped[int] = mapped_column(
        Integer, nullable=False,
    )
    comment: Mapped[str | None] = mapped_column(
        Text, default=None,
    )

    __table_args__ = (
        UniqueConstraint(
            "practice_id",
            "user_id",
            name="uq_feedback_practice_user",
        ),
        CheckConstraint(
            "rating BETWEEN 1 AND 10",
            name="ck_feedback_rating",
        ),
    )

    def __repr__(self) -> str:
        return (
            f"<Feedback id={self.id} practice={self.practice_id} "
            f"user={self.user_id} rating={self.rating}>"
        )


# ===================================================================
# DiaryEntry (Phase 8.3, + redesign: entry_type / practice_phase / soft delete)
# ===================================================================


class DiaryEntry(UUIDMixin, TimestampMixin, Base):
    """Personal journal entry, optionally linked to a practice.

    No time window restrictions. User can create, edit, and (soft) delete
    entries at any time. Soft delete (is_deleted=True) hides the entry and
    its matching DiaryEvent from the feed without dropping rows.
    """

    __tablename__ = "diary_entries"

    # -- Owner --
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )

    # -- Optional practice link --
    practice_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("practices.id", ondelete="SET NULL"),
        index=True,
        default=None,
    )

    # -- Type (note / dream) --
    # Redesign: note is the default and only composer-created type for now;
    # dream is wired on the backend ahead of the UI input (sub-flow #3).
    entry_type: Mapped[str] = mapped_column(
        String(10),
        default=DiaryEntryType.NOTE.value,
        server_default=DiaryEntryType.NOTE.value,
    )

    # -- Temporal phase relative to the linked practice --
    # NULL unless the entry is tied to a practice and we know before/after.
    practice_phase: Mapped[str | None] = mapped_column(
        String(10), default=None,
    )

    # -- Content --
    title: Mapped[str | None] = mapped_column(
        String(200), default=None,
    )
    content: Mapped[str] = mapped_column(
        Text, nullable=False,
    )
    # mood is an optional 1..10 score (same scale as Checkin/Feedback).
    # Not yet entered from the composer UI; range enforced when present.
    mood: Mapped[int | None] = mapped_column(
        Integer, default=None,
    )

    # -- Soft delete (redesign) --
    # DELETE hides the entry instead of removing it. The parallel DiaryEvent
    # is hidden too (never dropped) so future relations keep a stable target.
    is_deleted: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        server_default="false",
        index=True,
    )

    __table_args__ = (
        CheckConstraint(
            "mood IS NULL OR mood BETWEEN 1 AND 10",
            name="ck_diary_entry_mood",
        ),
        CheckConstraint(
            "entry_type IN ('note', 'dream')",
            name="ck_diary_entry_type",
        ),
        CheckConstraint(
            "practice_phase IS NULL OR practice_phase IN ('before', 'after')",
            name="ck_diary_entry_phase",
        ),
    )

    def __repr__(self) -> str:
        return (
            f"<DiaryEntry id={self.id} user={self.user_id} "
            f"type={self.entry_type} title={self.title!r} "
            f"deleted={self.is_deleted}>"
        )


# ===================================================================
# DiaryEvent (Diary redesign iteration -- unified feed journal)
# ===================================================================


class DiaryEvent(JSONBMixin, UUIDMixin, TimestampMixin, Base):
    """Append-only timeline record powering the unified diary feed.

    One row per user-visible activity. Written by projection functions
    (diary/projections.py) in the SAME transaction as the source mutation
    (P-01: no commit here). See module docstring for append-only vs upsert
    semantics per kind.

    JSONB SAFETY: inherits JSONBMixin -- mutate `snapshot` ONLY via
    set_jsonb("snapshot", deepcopy(...)). NEVER assign self.snapshot = ...
    directly (SQLAlchemy will not detect in-place dict mutation).
    """

    __tablename__ = "diary_events"

    # -- Owner --
    # Every event belongs to exactly one user's diary. A single master action
    # (cancel / reschedule / finalize) fans out into one row per booked user.
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )

    # -- Kind --
    kind: Mapped[str] = mapped_column(String(40), nullable=False)

    # -- Timeline axis --
    # The instant the event represents (NOT created_at, which is the write
    # time). For booking_confirmed it is the booking time; for
    # practice_outcome it is the practice finalization time; etc.
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )

    # -- Source pointer (deep-link / future relations) --
    source_type: Mapped[str] = mapped_column(String(20), nullable=False)
    source_id: Mapped[UUID] = mapped_column(nullable=False)

    # -- Render snapshot (no-join card rendering) --
    snapshot: Mapped[dict] = mapped_column(
        JSONB,
        default=dict,
        server_default="{}",
    )

    # -- Search (denormalized, ilike) --
    text_search: Mapped[str | None] = mapped_column(
        Text, default=None,
    )

    # -- Soft hide --
    # Mirrors DiaryEntry.is_deleted so a hidden note/dream drops out of the
    # feed while its row (and future relation targets) survive.
    is_hidden: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        server_default="false",
    )

    __table_args__ = (
        CheckConstraint(
            "kind IN ("
            "'booking_confirmed', 'booking_cancelled_by_user', "
            "'practice_rescheduled', 'practice_cancelled_by_master', "
            "'practice_outcome', 'checkin', 'feedback', 'note', 'dream', "
            "'thread_started')",
            name="ck_diary_event_kind",
        ),
        CheckConstraint(
            "source_type IN ("
            "'booking', 'practice', 'checkin', 'feedback', 'diary_entry', "
            "'thread')",
            name="ck_diary_event_source_type",
        ),
        # Primary feed query: WHERE user_id=? [AND ...] ORDER BY occurred_at
        # DESC. Composite index serves both the filter and the sort.
        Index(
            "ix_diary_events_user_occurred",
            "user_id",
            "occurred_at",
        ),
        # Per-object upsert/lookup: find the event for a given source object
        # (refresh the note/dream event on edit; checkin/feedback are looked
        # up once at creation -- they are immutable, never refreshed).
        Index(
            "ix_diary_events_source",
            "source_type",
            "source_id",
        ),
    )

    def __repr__(self) -> str:
        return (
            f"<DiaryEvent id={self.id} user={self.user_id} "
            f"kind={self.kind} occurred_at={self.occurred_at} "
            f"hidden={self.is_hidden}>"
        )
