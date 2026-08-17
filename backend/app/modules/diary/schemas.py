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

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.config import settings


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
