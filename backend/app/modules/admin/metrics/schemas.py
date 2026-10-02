# =============================================================================
# VELO Backend -- Admin Metrics Schemas (E9 / 4a)
# =============================================================================
#
# Read-only engagement metrics for the admin dashboard drill-ins. Each metric
# has a DIFFERENT shape, mirroring its frontend view:
#   check-in -> rate + totals + weekly series + low-check-in practices
#   feedback -> rate + totals + rating distribution
#   return   -> rate + totals + top loyal users
#
# rate_pct is an integer percent (0 when the denominator is 0 -- honest empty).
# low_practices / top_users are STRUCTURED (id + name + number); the frontend
# composes the Russian subtitle, so no UI strings live in the backend.
# distribution counts ratings per zone (ScoreZoneCounts, BE-77): the one
# shared distribution shape, boundaries in diary.insights_service.
# =============================================================================

from uuid import UUID

from pydantic import BaseModel

from app.modules.diary.schemas import ScoreZoneCounts


# ---------------------------------------------------------------------------
# check-in
# ---------------------------------------------------------------------------
class SeriesPoint(BaseModel):
    """One bar in the check-in weekly chart (label = bucket date, value = %)."""

    label: str
    value: int


class LowCheckinPractice(BaseModel):
    """A practice with a low check-in rate in the period."""

    id: UUID
    title: str
    checkin_rate_pct: int
    total: int


class CheckinMetricResponse(BaseModel):
    """GET /api/v1/admin/metrics/check-in."""

    rate_pct: int
    total_records: int
    checked_in: int
    series: list[SeriesPoint]
    low_practices: list[LowCheckinPractice]


# ---------------------------------------------------------------------------
# feedback
# ---------------------------------------------------------------------------
class FeedbackMetricResponse(BaseModel):
    """GET /api/v1/admin/metrics/feedback."""

    rate_pct: int
    visited: int
    left_review: int
    distribution: ScoreZoneCounts


# ---------------------------------------------------------------------------
# return
# ---------------------------------------------------------------------------
class TopUser(BaseModel):
    """A loyal user, ranked by all-time attended practices."""

    id: UUID
    name: str
    practices_count: int


class ReturnMetricResponse(BaseModel):
    """GET /api/v1/admin/metrics/return."""

    rate_pct: int
    total_users: int
    returning: int
    top_users: list[TopUser]
