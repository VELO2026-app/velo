# =============================================================================
# VELO Backend -- Master Stats Schemas (E7)
# =============================================================================
#
# Two period-scoped responses for the master: the dashboard stat grid (UTC
# bounds) and the analytics summary added by BE-34 (bounds in the master's own
# timezone). Each *_delta_pct is the signed percent change vs the previous
# period, or null when there is no meaningful base (S-1: previous period was
# non-positive) -- the client renders "--".
#
# Class name is Master-prefixed to avoid OpenAPI component-name collisions.
# =============================================================================

from pydantic import BaseModel


class MasterStatsResponse(BaseModel):
    """GET /api/v1/masters/me/stats?period=week|month|quarter.

    practices_count    -- master's COMPLETED practices scheduled in the
                          period. Completed only (GT-20): a practice that is
                          still ahead, running, cancelled, draft or deleted
                          does not count, so a period with nothing finished
                          yet reads 0. The grid answers "what happened", not
                          "what is scheduled".
    participants_count -- distinct users with an ATTENDED booking across
                          those practices. An ATTENDED booking only ever
                          exists on a completed practice, so this count and
                          practices_count are always about the same sessions.
    income_cents       -- gross booked turnover for the period, reused
                          verbatim from the E2 finance projection. The
                          dashboard renders practices/participants; the
                          finance screen renders income.

    Each *_delta_pct is the signed percent change vs the previous period,
    or null when the previous period was non-positive (S-1).
    """

    practices_count: int
    practices_delta_pct: int | None
    participants_count: int
    participants_delta_pct: int | None
    income_cents: int
    income_delta_pct: int | None


# ---------------------------------------------------------------------------
# Analytics summary (BE-34)
# ---------------------------------------------------------------------------
class AnalyticsMoodDistribution(BaseModel):
    """Check-in counts by mood bucket (low 1-3 / mid 4-7 / high 8-10).

    Named apart from diary.schemas.MoodDistribution on purpose, following
    admin.metrics.schemas.FeedbackRatingDistribution: two components with one
    name would be emitted module-qualified in the OpenAPI document and break
    the frontend's flat re-export. Same shape, same thresholds, one owner --
    diary.insights_service.mood_bucket, which computes both.
    """

    high: int
    mid: int
    low: int


class AnalyticsRatingDistribution(BaseModel):
    """Feedback counts by rating bucket (confused 1-3 / good 4-7 / fire 8-10).

    AnalyticsMoodDistribution's twin, named apart for the same reason.
    """

    fire: int
    good: int
    confused: int


class MasterAnalyticsResponse(BaseModel):
    """GET /api/v1/masters/me/analytics?period=week|month|quarter.

    Everything the master's analytics screen shows, for one calendar period in
    the MASTER'S OWN timezone -- unlike the dashboard grid above, whose bounds
    are UTC.

    bookings_count is the rate denominator: bookings on the period's completed
    practices that were not cancelled. Counted in bookings rather than distinct
    people because a check-in is unique per booking.

    Deltas carry the two conventions from core/periods.py: counts use a signed
    percent change (null when the previous period had no base), rates use a
    spread in percentage POINTS (null when the previous period had no
    denominator). The client renders "--" for either null.

    rate fields are 0 when the period has no bookings -- an honest empty, the
    same answer the admin dashboards give.
    """

    practices_count: int
    practices_delta_pct: int | None

    bookings_count: int
    bookings_delta_pct: int | None

    checkins_count: int
    checkins_delta_pct: int | None

    feedbacks_count: int
    feedbacks_delta_pct: int | None

    checkin_rate_pct: int
    checkin_rate_delta_pp: int | None

    feedback_rate_pct: int
    feedback_rate_delta_pp: int | None

    checkins: AnalyticsMoodDistribution
    feedbacks: AnalyticsRatingDistribution
