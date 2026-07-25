# =============================================================================
# VELO Backend -- Practice Schemas (Phase 4.2 + 4.3/4.4 + Frontend Backlog,
#                                   NO-LITERALS, + Calendar taxonomy)
# =============================================================================
#
# VALIDATION:
#   - scheduled_at must be in the future
#   - timezone must be a valid IANA timezone
#   - duration_minutes must be within config bounds
#   - practice_type validated via @field_validator against settings.practice_allowed_types
#   - difficulty validated via @field_validator against settings.practice_allowed_difficulties
#   - direction / style membership is validated in the SERVICE layer, NOT here
#     (T2, 2026-07-15): Pydantic validators are sync and cannot query the async
#     taxonomy catalog (practice_directions / practice_styles). See
#     practices/service.py: _validate_taxonomy() / _validate_style_choice() --
#     union of settings.practice_allowed_* (config) and the active DB catalog.
#
# PRICING VALIDATION (Phase 4.3/4.4):
#   - is_free=True  -> price_cents forced to 0 in service
#   - is_free=False -> price_cents must be > 0 (validated in service)
#   - currency validated via @field_validator against settings.practice_allowed_currencies
#   - NO-LITERALS: no Literal[...] anywhere -- all allowed values in config.py
#
# CALENDAR TAXONOMY (Calendar iteration):
#   direction / style / difficulty are catalog facets stored in the
#   Practice.data JSONB sandbox under data.taxonomy. They are NOT columns.
#   - CreatePracticeRequest: direction + difficulty are REQUIRED, style optional.
#   - UpdatePracticeRequest: all three optional (partial PATCH); validated if sent.
#   - PracticeResponse: surfaced as top-level fields; the service extracts them
#     from data.taxonomy in practice_to_response().
#   Allowed values + the style length cap live in config.py. direction / style
#   are validated (in the service, see VALIDATION above) against the UNION of
#   config and the active DB catalog (T2, 2026-07-15); difficulty has no
#   catalog table and stays config-only:
#     settings.practice_allowed_directions           (direction, config half)
#     settings.practice_allowed_difficulties         (difficulty, config-only)
#     settings.practice_allowed_styles_by_direction  (style, config half; taxonomy v2, 2026-05-28)
#     settings.practice_style_max_length
#
# NO-LITERALS policy:
#   All magic strings and magic numbers are sourced from settings:
#     settings.practice_allowed_types        -- practice_type values
#     settings.practice_allowed_currencies   -- currency values
#     settings.practice_allowed_directions    -- direction values
#     settings.practice_allowed_difficulties  -- difficulty values
#     settings.practice_style_max_length      -- style Field limit
#     settings.practice_title_max_length      -- title Field limit
#     settings.practice_description_max_length
#     settings.practice_zoom_link_max_length
#     settings.practice_timezone_max_length
#     settings.practice_max_participants_limit
#   Change any of these in config.py -- schemas update automatically.
#
# PRACTICE SUMMARY (Frontend Backlog A-03):
#   Lightweight practice representation for embedding in booking /
#   waitlist / purchase responses. Contains only the fields needed
#   for list-view cards (title, type, time, duration, timezone, master).
#
# MASTER_NAME (Frontend F3 prep):
#   master_name added to PracticeResponse and PracticeSummary.
#   Populated via JOIN with users table in service layer.
#   Default None for backward compatibility with model_validate()
#   on raw Practice ORM objects (e.g. in booking/waitlist schemas).
#
# P-02 NOTE:
#   NOT NULL fields are typed as `X | None` in UpdatePracticeRequest
#   so that "not sent" works with exclude_unset. The service layer
#   guards against explicit null.
# =============================================================================

from datetime import date, datetime, timezone
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field, field_validator, model_validator

from app.core.config import settings
from app.modules.practices.models import (
    AudienceKind,
    Practice,
    PracticeStatus,
    PracticeType,
)


# -- Zoom link validation (manual field; no Zoom integration / auto-gen) --
# zoom_link is optional and hand-entered by the master. A non-empty value MUST
# be an https:// URL: mirrors the frontend guard (CreatePracticeView) and the
# live-view usability check (AUDIT-0520-02), enforced on the backend -- the
# source of truth -- so a direct API call cannot store a non-https /
# javascript: link. Empty / None means "no link". "https://" is a fixed
# protocol requirement, not a business value, so it is not sourced from config.
_ZOOM_LINK_REQUIRED_PREFIX = "https://"


def _validate_zoom_link(v: str | None) -> str | None:
    """Reject a non-empty zoom_link that is not an https:// URL."""
    if v and not v.startswith(_ZOOM_LINK_REQUIRED_PREFIX):
        raise ValueError(
            f"zoom_link must start with '{_ZOOM_LINK_REQUIRED_PREFIX}'"
        )
    return v


# -- Recurrence spec (E3, series only) --
# Lives on the series ROOT in Practice.data.recurrence (schema-on-read, the
# same JSONB sandbox as taxonomy) and drives child-occurrence generation when
# the series is published (draft -> scheduled). Closed vocabularies (period /
# end) stay as Literal -- by-design, not config-driven, matching the feed's
# duration_bucket / time_of_day. The occurrence ceiling IS config-driven
# (settings.practice_series_max_occurrences).


class RecurrenceSpec(BaseModel):
    """Recurrence rule for a series practice.

    Fields:
      period     -- daily: every calendar day after the root; weekly: on `days`,
                    every week; biweekly: on `days`, every other week.
      days       -- ISO weekday ints (1=Mon .. 7=Sun) the series recurs on.
                    REQUIRED and non-empty for weekly/biweekly; ignored for
                    daily (generation does not read it).
      end        -- never: generate up to the cap; until_date: occurrences
                    through `until_date` (inclusive, local date); after_count:
                    exactly `count` occurrences.
      count      -- TOTAL occurrences INCLUDING the root (so count=40 yields the
                    root + 39 children). Required for after_count; 1..cap. An
                    explicit count above the cap is a 422 (the user named the
                    number -- we do not silently truncate it; until_date / never
                    are truncated silently instead).
      until_date -- local calendar date of the last allowed occurrence; required
                    for until_date.
    """

    period: Literal["daily", "weekly", "biweekly"]
    days: list[int] = Field(default_factory=list)
    end: Literal["never", "until_date", "after_count"]
    count: int | None = Field(default=None, ge=1)
    until_date: date | None = None

    @field_validator("days")
    @classmethod
    def _days_in_iso_range(cls, v: list[int]) -> list[int]:
        """Each weekday must be an ISO int 1..7; de-duplicate and sort."""
        bad = [d for d in v if d < 1 or d > 7]
        if bad:
            raise ValueError(
                f"recurrence days must be ISO weekday ints 1..7, got {bad}"
            )
        return sorted(set(v))

    @model_validator(mode="after")
    def _check_consistency(self) -> "RecurrenceSpec":
        """Cross-field rules: weekday requirement + end-condition payloads.

        The cap comes from config; an explicit after_count above it is rejected
        here (-> 422). daily ignores `days`, so no weekday requirement applies.
        """
        cap = settings.practice_series_max_occurrences
        if self.period in ("weekly", "biweekly") and not self.days:
            raise ValueError(
                f"recurrence days are required for period '{self.period}'"
            )
        if self.end == "after_count":
            if self.count is None:
                raise ValueError("count is required when end='after_count'")
            if self.count > cap:
                raise ValueError(
                    f"count must be <= {cap} (series occurrence cap), "
                    f"got {self.count}"
                )
        elif self.end == "until_date" and self.until_date is None:
            raise ValueError("until_date is required when end='until_date'")
        return self


class CreatePracticeRequest(BaseModel):
    """POST /api/v1/practices -- request body."""

    practice_type: str
    title: str = Field(
        min_length=1, max_length=settings.practice_title_max_length,
    )
    description: str | None = Field(
        default=None, max_length=settings.practice_description_max_length,
    )
    what_to_prepare: str | None = Field(
        default=None, max_length=settings.practice_description_max_length,
    )
    contraindications: str | None = Field(
        default=None, max_length=settings.practice_description_max_length,
    )
    scheduled_at: datetime
    duration_minutes: int
    timezone: str = Field(max_length=settings.practice_timezone_max_length)
    max_participants: int | None = Field(
        default=None, ge=1, le=settings.practice_max_participants_limit,
    )
    zoom_link: str | None = Field(
        default=None, max_length=settings.practice_zoom_link_max_length,
    )
    parent_practice_id: UUID | None = None

    # -- Pricing (Phase 4.3/4.4) --
    is_free: bool = True
    price_cents: int = Field(default=0, ge=0)
    # Default to first allowed currency (settings.practice_allowed_currencies[0]).
    # Validated via @field_validator against the full allowed list.
    currency: str = Field(default="eur")

    # -- Calendar taxonomy (stored in data.taxonomy JSONB) --
    # direction + difficulty are required on create; style is optional.
    direction: str
    difficulty: str
    style: str | None = Field(
        default=None, max_length=settings.practice_style_max_length,
    )

    # -- Recurrence (E3, series only) --
    # Optional. When present, practice_type MUST be "series" (enforced below)
    # and the practice is materialized into child occurrences on publication
    # (draft -> scheduled). A series practice WITHOUT a spec is allowed -- it
    # stays a single tagged practice (e.g. the seed's demo series); generation
    # simply no-ops. Persisted into data.recurrence by the service layer.
    recurrence: RecurrenceSpec | None = None

    # -- Audience (Master GROUPS P5, ПРОМТ №594) --
    # Default 'public' -- matches every practice's behavior before this
    # feature existed (see the migration's backfill note). group_ids is
    # required (non-empty) only when audience_kind='groups'; the service
    # verifies each id is one of THIS master's own CUSTOM groups (rejects
    # another master's group / a system slug with a 400).
    audience_kind: AudienceKind = AudienceKind.PUBLIC
    group_ids: list[UUID] = Field(default_factory=list)

    @field_validator("audience_kind")
    @classmethod
    def audience_kind_must_be_valid(cls, v: str) -> str:
        """Validate audience_kind against the fixed AudienceKind enum."""
        allowed = {k.value for k in AudienceKind}
        if v not in allowed:
            raise ValueError(
                f"audience_kind must be one of {sorted(allowed)}, got '{v}'"
            )
        return v

    @model_validator(mode="after")
    def _check_group_ids_match_audience_kind(self) -> "CreatePracticeRequest":
        """group_ids only makes sense (and is required) when audience_kind
        ='groups' -- reject a contradiction (group_ids sent with a
        different kind, or 'groups' with an empty list) at the schema
        level, same posture as _check_recurrence_requires_series above."""
        if self.audience_kind == AudienceKind.GROUPS.value:
            if not self.group_ids:
                raise ValueError(
                    "group_ids must be non-empty when audience_kind='groups'"
                )
        elif self.group_ids:
            raise ValueError(
                "group_ids is only allowed when audience_kind='groups'"
            )
        return self

    @field_validator("practice_type")
    @classmethod
    def practice_type_must_be_valid(cls, v: str) -> str:
        """Validate practice_type against allowed values from config."""
        allowed = settings.practice_allowed_types
        if v not in allowed:
            raise ValueError(
                f"practice_type must be one of {allowed}, got '{v}'"
            )
        return v

    @field_validator("zoom_link")
    @classmethod
    def zoom_link_must_be_https(cls, v: str | None) -> str | None:
        """Manually-entered zoom_link must be an https:// URL (or empty)."""
        return _validate_zoom_link(v)

    @field_validator("difficulty")
    @classmethod
    def difficulty_must_be_valid(cls, v: str) -> str:
        """Validate difficulty against allowed values from config."""
        allowed = settings.practice_allowed_difficulties
        if v not in allowed:
            raise ValueError(
                f"difficulty must be one of {allowed}, got '{v}'"
            )
        return v

    # direction / style membership + pairing (taxonomy v2, 2026-05-28) is
    # validated in the SERVICE layer as of T2 (2026-07-15), not here -- see
    # VALIDATION at the top of this file for why.

    @model_validator(mode="after")
    def _check_recurrence_requires_series(self) -> "CreatePracticeRequest":
        """A recurrence spec is only meaningful on a series practice.

        Reject recurrence sent with a non-series type (a contradiction -> 422).
        The reverse is allowed: a series practice may omit recurrence and stay a
        single tagged practice. Generation is gated on the spec's presence, not
        on the type alone.
        """
        if (
            self.recurrence is not None
            and self.practice_type != PracticeType.SERIES.value
        ):
            raise ValueError(
                "recurrence is only allowed when practice_type='series'"
            )
        return self

    @field_validator("currency")
    @classmethod
    def currency_must_be_valid(cls, v: str) -> str:
        """Validate currency against allowed values from config."""
        allowed = settings.practice_allowed_currencies
        if v not in allowed:
            raise ValueError(
                f"currency must be one of {allowed}, got '{v}'"
            )
        return v

    @field_validator("scheduled_at")
    @classmethod
    def scheduled_at_must_be_future(
        cls, v: datetime,
    ) -> datetime:
        """Reject practices scheduled in the past."""
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        if v <= datetime.now(timezone.utc):
            raise ValueError("scheduled_at must be in the future")
        return v

    @field_validator("timezone")
    @classmethod
    def timezone_must_be_iana(cls, v: str) -> str:
        """Validate timezone is a real IANA timezone."""
        try:
            ZoneInfo(v)
        except (ZoneInfoNotFoundError, KeyError):
            raise ValueError(
                f"Invalid IANA timezone: {v}"
            ) from None
        return v

    @field_validator("duration_minutes")
    @classmethod
    def duration_in_range(cls, v: int) -> int:
        """Validate duration is within configured bounds."""
        mn = settings.practice_min_duration_minutes
        mx = settings.practice_max_duration_minutes
        if v < mn or v > mx:
            raise ValueError(
                f"duration_minutes must be between {mn} and {mx}"
            )
        return v


class UpdatePracticeRequest(BaseModel):
    """PATCH /api/v1/practices/{id} -- request body.

    All fields optional. Only provided fields are updated.
    P-02: NOT NULL fields typed as X | None so that "not sent" works
    with exclude_unset. Service layer guards against explicit null.

    Calendar taxonomy (direction / difficulty / style) is optional here:
    "not sent" leaves the stored value untouched; if sent, it is validated
    and written into data.taxonomy by the service layer.
    """

    practice_type: str | None = None
    title: str | None = Field(
        default=None,
        min_length=1,
        max_length=settings.practice_title_max_length,
    )
    description: str | None = Field(
        default=None, max_length=settings.practice_description_max_length,
    )
    what_to_prepare: str | None = Field(
        default=None, max_length=settings.practice_description_max_length,
    )
    contraindications: str | None = Field(
        default=None, max_length=settings.practice_description_max_length,
    )
    scheduled_at: datetime | None = None
    duration_minutes: int | None = None
    timezone: str | None = Field(
        default=None, max_length=settings.practice_timezone_max_length,
    )
    max_participants: int | None = Field(
        default=None, ge=1, le=settings.practice_max_participants_limit,
    )
    zoom_link: str | None = Field(
        default=None, max_length=settings.practice_zoom_link_max_length,
    )
    parent_practice_id: UUID | None = None
    status: str | None = None

    # -- Pricing (Phase 4.3/4.4) --
    is_free: bool | None = None
    price_cents: int | None = Field(default=None, ge=0)
    currency: str | None = None

    # -- Calendar taxonomy (stored in data.taxonomy JSONB) --
    # Optional on update -- only provided fields are written by the service.
    direction: str | None = None
    difficulty: str | None = None
    style: str | None = Field(
        default=None, max_length=settings.practice_style_max_length,
    )

    # -- Audience (Master GROUPS P5, ПРОМТ №594) --
    # Both optional (PATCH semantics): omitted = unchanged. group_ids, when
    # SENT, REPLACES the practice's full target-group set (an empty list
    # clears it). Cross-field consistency (audience_kind vs group_ids) is
    # only checked here when BOTH are sent in the SAME request -- when only
    # one is sent, the service validates it against the practice's current
    # STORED audience_kind (same "sent value vs stored value" posture as
    # style's own W-1 note below).
    audience_kind: AudienceKind | None = None
    group_ids: list[UUID] | None = None

    @field_validator("audience_kind")
    @classmethod
    def audience_kind_must_be_valid(
        cls, v: str | None,
    ) -> str | None:
        """Validate audience_kind against the fixed AudienceKind enum."""
        if v is None:
            return v
        allowed = {k.value for k in AudienceKind}
        if v not in allowed:
            raise ValueError(
                f"audience_kind must be one of {sorted(allowed)}, got '{v}'"
            )
        return v

    @model_validator(mode="after")
    def _check_group_ids_match_audience_kind(self) -> "UpdatePracticeRequest":
        """Only rejects an outright CONTRADICTION sent in this same request
        -- audience_kind explicitly changed away from 'groups' while
        group_ids is also (non-emptily) sent, or explicitly set TO 'groups'
        with an empty group_ids. See the fields' own docstring for why a
        one-sided send (only audience_kind, or only group_ids) is left to
        the service instead."""
        if self.audience_kind is not None and self.group_ids is not None:
            if self.audience_kind == AudienceKind.GROUPS.value and not self.group_ids:
                raise ValueError(
                    "group_ids must be non-empty when audience_kind='groups'"
                )
            if self.audience_kind != AudienceKind.GROUPS.value and self.group_ids:
                raise ValueError(
                    "group_ids is only allowed when audience_kind='groups'"
                )
        return self

    @field_validator("practice_type")
    @classmethod
    def practice_type_must_be_valid(
        cls, v: str | None,
    ) -> str | None:
        """Validate practice_type against allowed values from config."""
        if v is None:
            return v
        allowed = settings.practice_allowed_types
        if v not in allowed:
            raise ValueError(
                f"practice_type must be one of {allowed}, got '{v}'"
            )
        return v

    @field_validator("zoom_link")
    @classmethod
    def zoom_link_must_be_https(cls, v: str | None) -> str | None:
        """Manually-entered zoom_link must be an https:// URL (or empty)."""
        return _validate_zoom_link(v)

    @field_validator("difficulty")
    @classmethod
    def difficulty_must_be_valid(
        cls, v: str | None,
    ) -> str | None:
        """Validate difficulty against allowed values from config."""
        if v is None:
            return v
        allowed = settings.practice_allowed_difficulties
        if v not in allowed:
            raise ValueError(
                f"difficulty must be one of {allowed}, got '{v}'"
            )
        return v

    # direction / style membership + pairing (taxonomy v2, 2026-05-28) is
    # validated in the SERVICE layer as of T2 (2026-07-15), not here -- see
    # VALIDATION at the top of this file for why. On UPDATE the service
    # validates style against whichever direction applies: the incoming one
    # if this request also changes direction, else the practice's STORED
    # direction (W-1).

    @field_validator("currency")
    @classmethod
    def currency_must_be_valid(
        cls, v: str | None,
    ) -> str | None:
        """Validate currency against allowed values from config."""
        if v is None:
            return v
        allowed = settings.practice_allowed_currencies
        if v not in allowed:
            raise ValueError(
                f"currency must be one of {allowed}, got '{v}'"
            )
        return v

    @field_validator("status")
    @classmethod
    def status_must_be_patchable(
        cls, v: str | None,
    ) -> str | None:
        """Validate status against patch-allowed values from config.

        I-04: 'cancelled' is excluded from practice_patch_allowed_statuses
        (the only path to cancelled is POST /practices/{id}/cancel, which
        handles refunds). Batch 1: 'live' and 'completed' are excluded too --
        they are driven by the clock by the lifecycle worker, never by PATCH.
        Pydantic raises ValueError here -> FastAPI returns 422, signalling
        schema-level rejection before the service layer.
        """
        if v is None:
            return v
        allowed = settings.practice_patch_allowed_statuses
        if v not in allowed:
            raise ValueError(
                f"status must be one of {allowed}, got '{v}'"
            )
        return v

    @field_validator("scheduled_at")
    @classmethod
    def scheduled_at_must_be_future(
        cls, v: datetime | None,
    ) -> datetime | None:
        """Reject practices scheduled in the past."""
        if v is None:
            return v
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        if v <= datetime.now(timezone.utc):
            raise ValueError("scheduled_at must be in the future")
        return v

    @field_validator("timezone")
    @classmethod
    def timezone_must_be_iana(
        cls, v: str | None,
    ) -> str | None:
        """Validate timezone is a real IANA timezone."""
        if v is None:
            return v
        try:
            ZoneInfo(v)
        except (ZoneInfoNotFoundError, KeyError):
            raise ValueError(
                f"Invalid IANA timezone: {v}"
            ) from None
        return v

    @field_validator("duration_minutes")
    @classmethod
    def duration_in_range(
        cls, v: int | None,
    ) -> int | None:
        """Validate duration is within configured bounds."""
        if v is None:
            return v
        mn = settings.practice_min_duration_minutes
        mx = settings.practice_max_duration_minutes
        if v < mn or v > mx:
            raise ValueError(
                f"duration_minutes must be between {mn} and {mx}"
            )
        return v


class CancelPracticeRequest(BaseModel):
    """POST /api/v1/practices/{id}/cancel -- optional request body.

    `scope` selects how far a cancellation reaches for a SERIES practice:
      "this"            -- cancel only this occurrence (the default, and the
                           behavior when no body is sent -- preserving the
                           pre-series contract for existing callers).
      "this_and_future" -- cancel this occurrence and every later occurrence of
                           the same series. A non-series practice has no
                           siblings, so it behaves like "this".

    Closed, by-design vocabulary -> Literal (no config indirection), matching
    the feed's duration_bucket / time_of_day.
    """

    scope: Literal["this", "this_and_future"] = "this"


class PracticeResponse(BaseModel):
    """Practice representation returned by all endpoints.

    Calendar taxonomy (direction / style / difficulty) is surfaced here as
    top-level optional fields. The service extracts them from the
    data.taxonomy JSONB sandbox in practice_to_response(). They are optional
    because practices created before the Calendar iteration have an empty
    data sandbox (-> None), and model_validate() on a raw ORM object would
    not populate them otherwise.
    """

    id: UUID
    master_id: UUID
    master_name: str | None = None
    # Master avatar (User.avatar_url, synced from Telegram photo_url on login).
    # Populated only by the detail endpoint via get_practice(); list endpoints
    # leave it None (avatars are not shown on feed cards).
    master_avatar_url: str | None = None
    master_methods: list[str] = []
    practice_type: PracticeType
    status: PracticeStatus
    title: str
    description: str | None
    what_to_prepare: str | None = None
    contraindications: str | None = None
    scheduled_at: datetime
    duration_minutes: int
    timezone: str
    max_participants: int | None
    current_participants: int
    zoom_link: str | None
    parent_practice_id: UUID | None

    # -- Pricing --
    is_free: bool
    price_cents: int
    currency: str

    # -- Calendar taxonomy (extracted from data.taxonomy by the service) --
    direction: str | None = None
    style: str | None = None
    difficulty: str | None = None

    # -- Audience (Master GROUPS P5, ПРОМТ №594) --
    # audience_kind: model_validate() auto-populates this from the ORM
    # column (default 'public', same as every practice before this feature).
    # audience_group_names: NOT auto-populated (no ORM relationship) -- the
    # service fills it from practice_audience_group only when audience_kind
    # ='groups'; empty otherwise. Static per-practice data (which groups
    # this practice targets), not a per-viewer flag -- the frontend uses it
    # to compose the "Вы не состоите в группе «...»" check-in error message
    # without a second round-trip.
    audience_kind: AudienceKind = AudienceKind.PUBLIC
    audience_group_names: list[str] = []

    # -- Series meta (E3 batch 2; computed by the service for series roots) --
    # Populated only for a `series` practice whose ROOT carries a recurrence
    # spec; None otherwise (a non-series practice, or a series tag without a
    # spec). The values describe the SERIES (root + children), so every
    # occurrence of one series reports the same trio. recurrence_days are ISO
    # weekday ints (1=Mon..7=Sun); daily is surfaced as the full week [1..7].
    # total_sessions counts the series' occurrences excluding cancelled;
    # completed_sessions is those with status=completed. The master list +
    # detail endpoints fill these; the public feed leaves them None.
    recurrence_days: list[int] | None = None
    total_sessions: int | None = None
    completed_sessions: int | None = None

    # -- Attendance / check-in counts (E12 + aggregate; computed by the
    # service, OWNER-ONLY) --
    # checkin_count is the number of DISTINCT participants who left a PRE
    # check-in for the practice -- the numerator of the card's check-in badge
    # ("N of M"). POST check-ins are a future socket and are not counted.
    # attended / no_show are the booking counts in the ATTENDED / NO_SHOW
    # statuses. All three are filled only where the requester owns the
    # practice: the master's own list (list_master_practices) and the OWNER's
    # detail. The public feed and a non-owner's detail leave them None --
    # no_show is sensitive and is never exposed to a non-owner (the one
    # deviation from the series-meta trio above, which is shown to everyone).
    checkin_count: int | None = None
    attended: int | None = None
    no_show: int | None = None

    # -- Per-user state (computed by the service for the requesting user) --
    # Ephemeral, NOT stored in data JSONB. Default False so model_validate()
    # on a raw ORM object is safe; the service overrides them in feed/detail
    # responses. On master-facing list endpoints they stay False (the master
    # is not a booker of their own practices).
    is_booked: bool = False
    is_paid: bool = False

    created_at: datetime
    updated_at: datetime | None

    # T21-1: the practice OWNER's own Zoom host-registrant join_url (role=
    # 'host' on ZoomRegistrant) -- never a student's. Populated by the
    # service only on owner-facing responses (create/update/delete/cancel,
    # the owner's own detail view, the master's own list); every other
    # caller leaves it at the default None, same posture as checkin_count/
    # attended/no_show above.
    zoom_host_join_url: str | None = None

    # A4 V2 (ПРОМТ №572): this practice's ZoomMeeting.status verbatim
    # ('active' | 'pending_creation' | 'create_failed' | 'deleted'), or None
    # if no ZoomMeeting row exists at all. UNLIKE zoom_host_join_url above,
    # this is NOT owner-gated -- the value carries no secret material (same
    # zero-masking posture as the admin zoom-attendance endpoint's identical
    # field). Lets the frontend Zoom-link ladder (utils/zoomLink.ts) tell a
    # meeting that is still being created apart from one that permanently
    # failed, for BOTH the master and a booked participant -- previously
    # both rendered the identical "готовится" spinner in both cases.
    zoom_meeting_status: str | None = None

    # A4 V6 (ПРОМТ №572): True when create_practice returned an EXISTING
    # practice instead of creating a new one -- either the window-scoped
    # duplicate-submit check (_find_recent_duplicate_practice, ПРОМТ №559)
    # or the TOCTOU race-lost path (uq_practice_master_title_scheduled_
    # recurrence, A4 V7). Before this field existed, both paths returned a
    # bare PracticeResponse indistinguishable from a freshly created one --
    # the master had no signal that their second submission (a timeout
    # retry, or the losing side of a genuine concurrent double-tap) did NOT
    # create anything new. Only ever True on the create endpoint's
    # response; every other builder call site (update/delete/cancel/list/
    # detail) leaves the schema default.
    deduplicated: bool = False

    # zoom_link (M-3 access gate) is handled at the response-building layer,
    # NOT with a model_validator: FastAPI re-validates the returned model
    # against response_model, which would re-run an "after" validator and wipe
    # any value the service set. practice_to_response() therefore assigns
    # zoom_link explicitly -- the real link only on the authorized path, None
    # everywhere else. Direct model_validate(practice) callers (booking detail,
    # finalize) null it themselves.
    model_config = {"from_attributes": True}


class PaginatedPracticesResponse(BaseModel):
    """GET /api/v1/practices -- paginated public list."""

    items: list[PracticeResponse]
    total: int
    limit: int
    offset: int


# -- Frontend Backlog A-03: Lightweight practice summary -------------------


class PracticeSummary(BaseModel):
    """Compact practice representation for embedding in related responses.

    Used inside BookingWithPracticeResponse, WaitlistWithPracticeResponse,
    and PurchaseWithPracticeResponse to give the frontend enough data
    for list-view cards without a separate GET /practices/{id} call.

    CR-01: timezone added -- Practice ORM has timezone as NOT NULL,
    model_validate() picks it up automatically via from_attributes.
    Without this field, frontend fell back to Europe/Berlin for all
    practices regardless of actual timezone.

    status added -- lets list views (my bookings, dashboard nearest card)
    tell a live practice from a scheduled one without a separate
    GET /practices/{id} call. Picked up automatically via from_attributes
    (Practice ORM status is NOT NULL with a default).
    """

    id: UUID
    title: str
    practice_type: PracticeType
    status: PracticeStatus
    scheduled_at: datetime
    duration_minutes: int
    timezone: str
    master_id: UUID
    master_name: str | None = None
    # B-1 (2026-05-28): direction surfaced so list-view consumers (booking /
    # waitlist / purchase responses) can render the practice icon without a
    # separate GET /practices/{id}. Lives in JSONB data.taxonomy → picked up
    # via from_attributes through the Practice ORM property.
    direction: str | None = None
    # Free/paid signal for list-view cards (dashboard "nearest", my bookings).
    # purchase_id can't distinguish free from paid — create_booking always opens
    # a Purchase, even for free practices — so surface the practice's own price
    # flags. ORM-backed NOT NULL columns, picked up via from_attributes; no
    # population code needed.
    is_free: bool
    price_cents: int
    currency: str

    # E18 + M-3 + Z-7: zoom_link on the summary powers the dashboard
    # nearest-card "Войти" / Zoom button. It is access-gated (M-3): it must
    # reach only a user with a CONFIRMED / ATTENDED booking on the practice.
    # The gate is enforced in from_practice() below -- the SINGLE construction
    # point for every list-view consumer -- which defaults it to None
    # (fail-closed). A schema model_validator cannot be used: FastAPI
    # re-validates the response and would re-run it, wiping the value the
    # builder set.
    zoom_link: str | None = None

    # A4 V2 (ПРОМТ №572): same field, same NOT-owner-gated posture as
    # PracticeResponse.zoom_meeting_status above -- powers the SAME
    # pending-vs-failed distinction on list-view Zoom buttons (dashboard
    # nearest card, my-bookings). Set by from_practice() below; no ORM
    # source on Practice itself (ZoomMeeting is a separate table), so
    # model_validate() alone cannot populate it -- callers must pass it in,
    # the same shape as zoom_link_visible.
    zoom_meeting_status: str | None = None

    model_config = {"from_attributes": True}

    @classmethod
    def from_practice(
        cls,
        practice: Practice,
        *,
        master_name: str | None = None,
        zoom_link_visible: bool = False,
        zoom_meeting_status: str | None = None,
    ) -> "PracticeSummary":
        """Build a summary from a Practice ORM row -- the single construction
        point for all list-view consumers (bookings / waitlist / purchases).

        zoom_link is FAIL-CLOSED (Z-7): None unless the caller explicitly
        passes zoom_link_visible=True (warranted only by the requester's own
        CONFIRMED / ATTENDED booking). Because every summary is built here, no
        builder can forget to null it. master_name is filled here too -- it has
        no ORM source on the practice row (it lives on the joined user).
        """
        summary = cls.model_validate(practice)
        summary.master_name = master_name
        summary.zoom_link = practice.zoom_link if zoom_link_visible else None
        summary.zoom_meeting_status = zoom_meeting_status
        return summary


class ZoomStartTicketResponse(BaseModel):
    """POST /api/v1/practices/{id}/zoom/start-ticket (ПРОМТ №556, OWNER-1).

    Deliberately carries a one-time ticket, never a start_url -- see
    zoom/service.py's ticket-issuance docstring for why."""

    ticket: str
