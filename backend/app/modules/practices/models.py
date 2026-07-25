# =============================================================================
# VELO Backend -- Practice Model (Phase 4.1, updated DS-sprint + Calendar)
# =============================================================================
#
# A wellness practice session created by a verified master.
#
# JSONB DATA SANDBOX (Calendar iteration):
#   `data` is a JSONB schema-on-read sandbox, mirroring User.credentials and
#   MasterProfile.data. New, not-yet-stabilized fields live here first; once
#   the DB design settles they migrate to typed columns / external tables.
#
#   data.taxonomy -- catalog facets used by the Calendar filter:
#     {
#       "direction":  "meditation" | "yoga" | "breathwork",  # PracticeDirection
#       "style":      str | null,                            # free-form, e.g. "Кундалини йога"
#       "difficulty": "beginner" | "medium" | "high"         # PracticeDifficulty
#     }
#
#   JSONB SAFETY: inherits JSONBMixin -- mutate ONLY via set_jsonb("data", ...)
#   after a deepcopy. NEVER assign self.data = ... directly (SQLAlchemy will
#   not detect in-place dict mutation -> silent lost update). See core/mixins.py.
# =============================================================================

import enum
from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.core.mixins import JSONBMixin, TimestampMixin, UUIDMixin


class PracticeType(enum.StrEnum):
    """Format of a practice session.

    NOTE: this is the *format*, not the content direction. The content
    direction (meditation / yoga / breathwork) lives in data.taxonomy.
    """

    LIVE = "live"
    SERIES = "series"
    ONE_ON_ONE = "one_on_one"
    REPLAY = "replay"


class PracticeStatus(enum.StrEnum):
    """Practice lifecycle statuses."""

    DRAFT = "draft"
    SCHEDULED = "scheduled"
    LIVE = "live"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    DELETED = "deleted"  # Phase 4.2: soft delete for drafts


class PracticeDirection(enum.StrEnum):
    """Content direction of a practice -- the Calendar "Направление" facet.

    Stored inside data.taxonomy.direction (JSONB schema-on-read sandbox)
    — NOT a column. Extending this enum does not change the DB schema.
    Distinct from PracticeType, which is the session *format*.

    Keep in sync with settings.practice_allowed_directions and the
    frontend PracticeDirection literal union (api/types.ts).
    """

    MEDITATION = "meditation"
    YOGA = "yoga"
    BREATHWORK = "breathwork"
    SOMATIC = "somatic"
    TANTRA = "tantra"
    CIRCLES = "circles"
    SOUND_HEALING = "sound_healing"
    ART = "art"
    NARRATIVE = "narrative"
    MOVEMENT = "movement"


class PracticeDifficulty(enum.StrEnum):
    """Difficulty level of a practice -- the Calendar "Сложность" facet.

    Stored inside data.taxonomy.difficulty (JSONB schema-on-read sandbox).
    Rendered as filled dots in the UI: beginner ●○○ / medium ●●○ / high ●●●.
    """

    BEGINNER = "beginner"
    MEDIUM = "medium"
    HIGH = "high"


class AudienceKind(enum.StrEnum):
    """Who can see/book a practice (Master GROUPS P5, ПРОМТ №594).

    PUBLIC:   everyone (default -- matches every practice's behavior before
              this column existed, see the migration's backfill).
    STUDENTS: anyone with >= 1 non-cancelled booking on this master's
              practices (the same "derived «Ученики»" rule groups_service.py
              already uses).
    GROUPS:   members of at least one of the practice's target CUSTOM groups
              (practice_audience_group). A blocked student is EXCLUDED from
              all three -- see practices/audience_service.py, the single
              shared predicate every enforcement point below reuses.
    """

    PUBLIC = "public"
    STUDENTS = "students"
    GROUPS = "groups"


class Practice(JSONBMixin, UUIDMixin, TimestampMixin, Base):
    """A wellness practice session created by a verified master.

    One master can have many practices. Users book practices in Phase 5.
    """

    __tablename__ = "practices"

    # A4 V7: excludes the practice-creation TOCTOU race (two concurrent
    # POST /practices for the same master both passing the in-app dedup
    # SELECT before either commits, see practices/service.py's
    # create_practice) at the DB level, mirroring
    # uq_zoom_registrant_meeting_user_active / uq_booking_practice_user_
    # active. COALESCE(...) is required: a one-off practice has no
    # data.recurrence key at all, and SQL NULL <> NULL would silently
    # exempt every non-recurring practice from this guard otherwise.
    __table_args__ = (
        Index(
            "uq_practice_master_title_scheduled_recurrence",
            "master_id",
            "title",
            "scheduled_at",
            text("(COALESCE(data -> 'recurrence', 'null'::jsonb))"),
            unique=True,
            postgresql_where=text("status != 'deleted'"),
        ),
    )

    # -- Owner --
    # R-07: index=True synced with existing ix_practices_master_id in DB.
    master_id: Mapped[UUID] = mapped_column(
        ForeignKey("master_profiles.user_id", ondelete="CASCADE"),
        index=True,
    )

    # -- Core fields --
    practice_type: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(
        String(20),
        default=PracticeStatus.DRAFT.value,
        server_default=PracticeStatus.DRAFT.value,
    )

    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(
        Text, default=None,
    )
    what_to_prepare: Mapped[str | None] = mapped_column(
        Text, default=None,
    )
    contraindications: Mapped[str | None] = mapped_column(
        Text, default=None,
    )

    # -- Scheduling --
    scheduled_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
    )
    duration_minutes: Mapped[int] = mapped_column(Integer)
    timezone: Mapped[str] = mapped_column(String(50))

    # -- Capacity --
    max_participants: Mapped[int | None] = mapped_column(
        Integer, default=None,
    )
    # Cached counter -- updated by recalculate_participants() after
    # booking status changes. Capacity checks use COUNT(bookings);
    # this field is for display in PracticeResponse (TD-034).
    current_participants: Mapped[int] = mapped_column(
        Integer,
        default=0,
        server_default="0",
    )

    # -- Pricing (Phase 4.3/4.4) --
    is_free: Mapped[bool] = mapped_column(
        Boolean,
        default=True,
        server_default="true",
    )
    price_cents: Mapped[int] = mapped_column(
        Integer,
        default=0,
        server_default="0",
    )
    # NEW-7: lowercase "eur" consistent with Payment, Purchase, Withdrawal.
    currency: Mapped[str] = mapped_column(
        String(3),
        default="eur",
        server_default="eur",
    )

    # -- Audience (Master GROUPS P5, ПРОМТ №594) --
    audience_kind: Mapped[str] = mapped_column(
        String(20),
        default=AudienceKind.PUBLIC.value,
        server_default=AudienceKind.PUBLIC.value,
    )

    # -- Zoom (manual for MVP) --
    zoom_link: Mapped[str | None] = mapped_column(
        String(500), default=None,
    )

    # -- Series support (self-referential FK) --
    parent_practice_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("practices.id", ondelete="SET NULL"),
        default=None,
    )

    # -- JSONB sandbox (Calendar iteration) --
    # Schema-on-read facets (data.taxonomy: direction / style / difficulty).
    # Mutate ONLY via set_jsonb("data", deepcopy(...)). See class docstring.
    data: Mapped[dict] = mapped_column(
        JSONB,
        default=dict,
        server_default="{}",
    )

    # -- JSONB-derived read-only properties (B-1, 2026-05-28) --
    # Expose data.taxonomy.direction as a plain Python attribute so that
    # Pydantic schemas with from_attributes=True (PracticeSummary etc.) can
    # pick it up without a separate hand-written extractor in each router.
    # practice_to_response() still overrides these for PracticeResponse to
    # keep the legacy single source of truth in service.py.
    @property
    def direction(self) -> str | None:
        return (self.data or {}).get("taxonomy", {}).get("direction")

    def __repr__(self) -> str:
        return (
            f"<Practice id={self.id} type={self.practice_type} "
            f"status={self.status} title={self.title!r} "
            f"is_free={self.is_free} price_cents={self.price_cents}>"
        )


class PracticeAudienceGroup(UUIDMixin, Base):
    """One of a practice's target CUSTOM groups (audience_kind='groups' only).

    UNIQUE (practice_id, group_id) -- a group is listed at most once per
    practice; POST/PATCH practice's group_ids write is idempotent-safe
    against this constraint. ondelete=CASCADE both ways: deleting the
    practice OR the group drops the row, nothing else to reconcile (mirrors
    master_group_membership's identical CASCADE-both-ways shape).

    group_id references masters/groups_models.py's MasterGroup by table name
    only (no Python import -- same cross-module FK-by-string-name pattern
    MasterGroupMembership already uses for its own FKs) to avoid a
    practices <-> masters import cycle.
    """

    __tablename__ = "practice_audience_group"
    __table_args__ = (
        UniqueConstraint(
            "practice_id", "group_id",
            name="uq_practice_audience_group_practice_group",
        ),
    )

    practice_id: Mapped[UUID] = mapped_column(
        ForeignKey("practices.id", ondelete="CASCADE"),
        nullable=False,
    )
    group_id: Mapped[UUID] = mapped_column(
        ForeignKey("master_group.id", ondelete="CASCADE"),
        nullable=False,
    )

    def __repr__(self) -> str:
        return (
            f"<PracticeAudienceGroup practice_id={self.practice_id} "
            f"group_id={self.group_id}>"
        )
