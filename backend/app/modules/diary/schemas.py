# =============================================================================
# VELO Backend -- Diary Schemas (Phase 8.1-8.4, NO-LITERALS)
# =============================================================================
#
# CHECKIN:
#   CheckinRequest / CheckinResponse / PaginatedCheckinsResponse
#
# FEEDBACK:
#   FeedbackRequest / FeedbackResponse / PaginatedFeedbacksResponse
#
# DIARY ENTRY:
#   CreateDiaryEntryRequest / UpdateDiaryEntryRequest
#   DiaryEntryResponse / PaginatedDiaryEntriesResponse
#
# INSIGHTS (master-facing):
#   MoodDistribution / RatingDistribution / PracticeInsightsResponse
#
# SUGGESTION-6 fix: ConfigDict(from_attributes=True) instead of dict style.
# NO-LITERALS: field limits sourced from config.py:
#   settings.diary_comment_max_length  -- comment field limit
#   settings.diary_entry_content_max_length
#   settings.diary_entry_title_max_length
# mood / rating are 1..10 integer scores (slider); validated by range,
#   not by a config list. UI derives the icon/label from the range
#   (1-3 / 4-7 / 8-10).
#
# CR-01: MoodDistribution / RatingDistribution fields changed from
#   optional (default=0) to required. These are response-only schemas --
#   the service always provides concrete values. Removing defaults makes
#   OpenAPI mark them as required, so the TS generator emits non-optional
#   fields and frontend code doesn't need `?.` guards.
# =============================================================================

from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationInfo,
    field_validator,
)

from app.core.config import settings
from app.modules.diary.models import ExternalActivityType


# ===================================================================
# Check-in schemas (Phase 8.1)
# ===================================================================


class CheckinRequest(BaseModel):
    """POST /api/v1/practices/{id}/checkin body."""

    mood: int
    comment: str | None = Field(
        default=None,
        min_length=1,
        max_length=settings.diary_comment_max_length,
    )

    @field_validator("mood")
    @classmethod
    def mood_must_be_valid(cls, v: int) -> int:
        """Validate mood is a 1..10 score."""
        if not 1 <= v <= 10:
            raise ValueError(f"mood must be between 1 and 10, got {v}")
        return v


class CheckinResponse(BaseModel):
    """Single checkin in API responses."""

    id: UUID
    practice_id: UUID
    user_id: UUID
    booking_id: UUID
    mood: int
    comment: str | None
    check_type: str
    created_at: datetime
    updated_at: datetime | None

    model_config = ConfigDict(from_attributes=True)


class PaginatedCheckinsResponse(BaseModel):
    """GET /api/v1/users/me/checkins -- paginated list."""

    items: list[CheckinResponse]
    total: int
    limit: int
    offset: int


# ===================================================================
# Feedback schemas (Phase 8.2)
# ===================================================================


class FeedbackRequest(BaseModel):
    """POST /api/v1/practices/{id}/feedback body."""

    rating: int
    comment: str | None = Field(
        default=None,
        min_length=1,
        max_length=settings.diary_comment_max_length,
    )

    @field_validator("rating")
    @classmethod
    def rating_must_be_valid(cls, v: int) -> int:
        """Validate rating is a 1..10 score."""
        if not 1 <= v <= 10:
            raise ValueError(f"rating must be between 1 and 10, got {v}")
        return v


class FeedbackResponse(BaseModel):
    """Single feedback in API responses."""

    id: UUID
    practice_id: UUID
    user_id: UUID
    booking_id: UUID
    rating: int
    comment: str | None
    created_at: datetime
    updated_at: datetime | None

    model_config = ConfigDict(from_attributes=True)


class PaginatedFeedbacksResponse(BaseModel):
    """GET /api/v1/users/me/feedbacks -- paginated list."""

    items: list[FeedbackResponse]
    total: int
    limit: int
    offset: int


# ===================================================================
# Diary Entry schemas (Phase 8.3)
# ===================================================================


class CreateDiaryEntryRequest(BaseModel):
    """POST /api/v1/diary body."""

    content: str = Field(
        min_length=1, max_length=settings.diary_entry_content_max_length,
    )
    title: str | None = Field(
        default=None, max_length=settings.diary_entry_title_max_length,
    )
    mood: int | None = None
    practice_id: UUID | None = None
    # entry_type: note (default, the only type the composer creates this
    # iteration) or dream. Wired on the backend ahead of the UI input.
    entry_type: str = "note"
    # practice_phase: before/after relative to the linked practice; only
    # meaningful when practice_id is set.
    practice_phase: str | None = None

    @field_validator("mood")
    @classmethod
    def mood_must_be_valid(cls, v: int | None) -> int | None:
        """Validate mood is a 1..10 score (when provided)."""
        if v is None:
            return v
        if not 1 <= v <= 10:
            raise ValueError(f"mood must be between 1 and 10, got {v}")
        return v

    @field_validator("entry_type")
    @classmethod
    def entry_type_must_be_valid(cls, v: str) -> str:
        """Validate entry_type against allowed values from config."""
        allowed = settings.diary_allowed_entry_types
        if v not in allowed:
            raise ValueError(
                f"entry_type must be one of {allowed}, got '{v}'"
            )
        return v

    @field_validator("practice_phase")
    @classmethod
    def practice_phase_must_be_valid(cls, v: str | None) -> str | None:
        """Validate practice_phase against allowed values from config."""
        if v is None:
            return v
        allowed = settings.diary_allowed_practice_phases
        if v not in allowed:
            raise ValueError(
                f"practice_phase must be one of {allowed}, got '{v}'"
            )
        return v


class UpdateDiaryEntryRequest(BaseModel):
    """PATCH /api/v1/diary/{id} body.

    All fields optional. Only provided fields are updated.
    """

    content: str | None = Field(
        default=None,
        min_length=1,
        max_length=settings.diary_entry_content_max_length,
    )
    title: str | None = Field(
        default=None, max_length=settings.diary_entry_title_max_length,
    )
    mood: int | None = None
    practice_id: UUID | None = None
    entry_type: str | None = None
    practice_phase: str | None = None
    # Sentinel to distinguish "not provided" from "set to null".
    # If clear_mood is True, mood is set to None even if mood field is absent.
    clear_mood: bool = False
    clear_title: bool = False
    clear_practice: bool = False
    clear_practice_phase: bool = False

    @field_validator("mood")
    @classmethod
    def mood_must_be_valid(cls, v: int | None) -> int | None:
        """Validate mood is a 1..10 score (when provided)."""
        if v is None:
            return v
        if not 1 <= v <= 10:
            raise ValueError(f"mood must be between 1 and 10, got {v}")
        return v

    @field_validator("entry_type")
    @classmethod
    def entry_type_must_be_valid(cls, v: str | None) -> str | None:
        """Validate entry_type against allowed values from config."""
        if v is None:
            return v
        allowed = settings.diary_allowed_entry_types
        if v not in allowed:
            raise ValueError(
                f"entry_type must be one of {allowed}, got '{v}'"
            )
        return v

    @field_validator("practice_phase")
    @classmethod
    def practice_phase_must_be_valid(cls, v: str | None) -> str | None:
        """Validate practice_phase against allowed values from config."""
        if v is None:
            return v
        allowed = settings.diary_allowed_practice_phases
        if v not in allowed:
            raise ValueError(
                f"practice_phase must be one of {allowed}, got '{v}'"
            )
        return v


class DiaryEntryResponse(BaseModel):
    """Single diary entry in API responses."""

    id: UUID
    user_id: UUID
    practice_id: UUID | None
    entry_type: str
    practice_phase: str | None
    title: str | None
    content: str
    mood: int | None
    is_deleted: bool
    created_at: datetime
    updated_at: datetime | None

    model_config = ConfigDict(from_attributes=True)


class PaginatedDiaryEntriesResponse(BaseModel):
    """GET /api/v1/diary -- paginated list."""

    items: list[DiaryEntryResponse]
    total: int
    limit: int
    offset: int


# ===================================================================
# Practice Insights schemas (Phase 8.4, master-facing)
# ===================================================================


class MoodDistribution(BaseModel):
    """Check-in mood counts for a practice, bucketed by score range.

    mood is a 1..10 score; counts are grouped into three buckets:
      low  = scores 1-3
      mid  = scores 4-7
      high = scores 8-10

    CR-01: fields are required (no default=0). This is a response-only
    schema -- the service always provides concrete values.
    """

    high: int
    mid: int
    low: int


class RatingDistribution(BaseModel):
    """Feedback rating counts for a practice, bucketed by score range.

    rating is a 1..10 score; counts are grouped into three buckets:
      confused = scores 1-3
      good     = scores 4-7
      fire     = scores 8-10

    CR-01: fields are required (no default=0). Same rationale as
    MoodDistribution above.
    """

    fire: int
    good: int
    confused: int


class PracticeInsightsResponse(BaseModel):
    """GET /api/v1/practices/{id}/insights -- aggregated data.

    All data is anonymous: no user IDs, names, or comment texts.
    Only numeric distributions and counts.
    """

    practice_id: UUID
    participants: int
    checkins: MoodDistribution
    feedbacks: RatingDistribution
    comments_count: int


# ===================================================================
# Practice reviews schemas (E1, master-facing, NON-anonymous)
# ===================================================================


class ReviewItem(BaseModel):
    """One named review (GET /api/v1/practices/{id}/reviews).

    The de-anonymised counterpart to RatingDistribution: where insights expose
    only numeric buckets, this carries the reviewer's name, avatar and comment
    text. `rating` is the stored 1..10 score mapped to the three UI buckets
    (1-3 confused / 4-7 good / 8-10 fire) so the frontend reuses the same
    rating icons it already renders for the anonymous distribution.

    user_id is the reviewer's User.id (E1 remainder) -- it lets the frontend
    navigate from a review to that student's profile. The author User is
    already joined in list_practice_reviews, so this adds no query.
    """

    user_id: UUID
    reviewer_name: str
    avatar_url: str | None
    rating: Literal["fire", "good", "confused"]
    comment: str | None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class PaginatedReviewsResponse(BaseModel):
    """GET /api/v1/practices/{id}/reviews -- paginated named reviews."""

    items: list[ReviewItem]
    total: int
    limit: int
    offset: int


# ===================================================================
# Diary feed schemas (Diary redesign iteration -- unified timeline)
# ===================================================================


class DiaryFeedItem(BaseModel):
    """One event in the unified diary timeline (GET /api/v1/diary/feed).

    A denormalized projection of a DiaryEvent. `snapshot` is an open dict
    whose shape depends on `kind` -- the frontend reads the fields it needs
    per kind (practice card fields, mood, rating, content preview, etc.).
    Keeping it open here avoids a combinatorial explosion of per-kind schemas
    while the feed card design is still settling; the kinds themselves are a
    closed vocabulary (see kind).

    `source_type` + `source_id` let the card deep-link back to the originating
    object (practice detail now, replay archive later).
    """

    id: UUID
    kind: str
    occurred_at: datetime
    source_type: str
    source_id: UUID
    snapshot: dict
    # created_at is the write time (distinct from occurred_at); exposed so the
    # client can tell "written now about a past event" if needed.
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class DiaryFeedResponse(BaseModel):
    """GET /api/v1/diary/feed -- cursor-paginated unified timeline.

    `next_cursor` is an opaque cursor packing the last item's (occurred_at,
    id) when a full page was returned (more may remain); null marks the end
    of the feed. The client passes it back verbatim as the `cursor` query
    param for the next page -- it is not a bare timestamp (SW12: occurred_at
    alone cannot order ties, see feed_service.list_diary_feed).
    """

    items: list[DiaryFeedItem]
    next_cursor: str | None


# ===================================================================
# External activity schemas (BE-27)
# ===================================================================


class CreateExternalActivityRequest(BaseModel):
    """POST /api/v1/diary/external-activities body.

    `activity_type` is typed as the ENUM, not as a str validated against a
    config list the way entry_type is: the closed set then reaches the
    frontend as a union in generated.ts, and a value added without a card
    to draw it breaks the build instead of the feed. See
    ExternalActivityType's own docstring.

    `occurred_at` must be timezone-aware and must not be in the future --
    a diary of what happened cannot hold what has not. Both are checked
    here so the answer is a field-attributed 422 rather than a 500 from a
    naive/aware comparison further down.
    """

    occurred_at: datetime
    activity_type: ExternalActivityType
    custom_activity_name: str | None = Field(
        default=None,
        max_length=settings.external_activity_name_max_length,
        # validate_default IS THE WHOLE FIX, not a flag beside it. A
        # field_validator does NOT run when the key is absent from the
        # body, so without this the commonest mistake of the two -- type
        # 'custom' and no name at all -- would stop being refused and
        # return 201. Measured, not assumed: the prototype without it
        # turned that case from a 422 into a created row.
        validate_default=True,
    )
    mood: int
    thoughts: str | None = Field(
        default=None,
        max_length=settings.diary_entry_content_max_length,
    )

    @field_validator("occurred_at")
    @classmethod
    def occurred_at_must_be_aware_and_past(cls, v: datetime) -> datetime:
        """Reject a naive timestamp and a future one; normalize to UTC.

        Normalizing HERE and not in the service is what makes "same instant,
        different offset" one stored value: +03:00 and Z arrive as the same
        UTC point, and the feed's ordering never sees an offset.
        """
        if v.tzinfo is None or v.tzinfo.utcoffset(v) is None:
            raise ValueError(
                "occurred_at must include a timezone offset"
            )
        v = v.astimezone(UTC)
        if v > datetime.now(UTC):
            raise ValueError("occurred_at cannot be in the future")
        return v

    @field_validator("mood")
    @classmethod
    def mood_must_be_valid(cls, v: int) -> int:
        """Validate mood is a 1..10 score (required here, unlike a note)."""
        if not 1 <= v <= 10:
            raise ValueError(f"mood must be between 1 and 10, got {v}")
        return v

    @field_validator("thoughts")
    @classmethod
    def blank_thoughts_is_none(cls, v: str | None) -> str | None:
        """Whitespace-only text is absence, and is stored as absence.

        Without this a body of spaces would land in text_search and in the
        snapshot preview as a blank line the feed cannot render and the
        search cannot match.
        """
        if v is None:
            return None
        stripped = v.strip()
        return stripped or None

    @field_validator("custom_activity_name")
    @classmethod
    def custom_name_matches_type(
        cls, v: str | None, info: ValidationInfo,
    ) -> str | None:
        """The name is required exactly when the type is custom.

        A FIELD validator on the SECOND of the two fields, not a model
        validator, and the difference is the error's address: pydantic
        gives a model validator no `loc`, so both refusals used to arrive
        at body level and the frontend could not put them under the input
        they belong to. Contract 4.1 asks for 422 precisely so it can.

        Reading a sibling works because `activity_type` is DECLARED ABOVE
        this field: info.data holds the fields already validated, in
        declaration order. It holds only the ones that PASSED -- an
        unknown activity_type is absent from it entirely, hence .get()
        and the early return: that request already has its 422 on
        activity_type, and a second refusal about the name would only
        send the person looking in the wrong place.

        Both directions stay here together. Split across two checks in
        two places they would be two rules that can be relaxed one at a
        time, and the DB constraint they mirror
        (ck_external_activity_custom) is deliberately one expression for
        the same reason.
        """
        name = (v or "").strip()
        activity_type = info.data.get("activity_type")
        if activity_type is None:
            return name or None
        if activity_type is ExternalActivityType.CUSTOM and not name:
            raise ValueError(
                "custom_activity_name is required when "
                "activity_type is 'custom'"
            )
        if activity_type is not ExternalActivityType.CUSTOM and v is not None:
            raise ValueError(
                "custom_activity_name is only allowed when "
                "activity_type is 'custom'"
            )
        return name or None


class ExternalActivityResponse(BaseModel):
    """POST /api/v1/diary/external-activities -- the created activity.

    `occurred_at` comes back normalized to UTC, which is the value the
    diary orders by; `created_at` is the write time and the two differ
    whenever somebody enters yesterday's massage today.
    """

    id: UUID
    occurred_at: datetime
    activity_type: ExternalActivityType
    custom_activity_name: str | None
    mood: int
    thoughts: str | None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
