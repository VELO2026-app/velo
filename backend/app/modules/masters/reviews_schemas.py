# =============================================================================
# VELO Backend -- Master Reviews Schemas (#3 -- cross-practice attention feed)
# =============================================================================
#
# Master-wide named-reviews feed across the master's completed practices.
# Refines E1 (per-practice GET /practices/{id}/reviews): same de-anonymised
# projection, but aggregated over ALL of the master's completed practices and
# carrying the NEW practice_title field so the dashboard "Требуют внимания"
# block can show which practice each review came from.
#
# Class names are Master-prefixed and distinct from diary's ReviewItem to
# avoid OpenAPI component-name collisions in the generated frontend types.
# rating is the score's zone (ScoreZone, BE-77), the same five keys E1
# returns.
# =============================================================================

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel

from app.modules.diary.models import ScoreZone


class MasterReviewItem(BaseModel):
    """One named review in the master-wide feed.

    user_id is the reviewer's User.id (E1 remainder) -- it lets the dashboard
    navigate from a review straight to that student's profile. The author User
    is already joined in list_master_reviews, so this adds no query.
    """

    user_id: UUID
    reviewer_name: str
    avatar_url: str | None
    rating: ScoreZone
    comment: str | None
    practice_title: str
    created_at: datetime


class PaginatedMasterReviewsResponse(BaseModel):
    """GET /api/v1/masters/me/reviews -- paginated cross-practice feed."""

    items: list[MasterReviewItem]
    total: int
    limit: int
    offset: int
