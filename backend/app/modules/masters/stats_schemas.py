# =============================================================================
# VELO Backend -- Master Stats Schemas (E7)
# =============================================================================
#
# Period-scoped stat grid for the master dashboard. All counts are for the
# current calendar period (week|month, UTC); each *_delta_pct is the signed
# percent change vs the previous period, or null when there is no meaningful
# base (S-1: previous period was non-positive) -- the client renders "--".
#
# Class name is Master-prefixed to avoid OpenAPI component-name collisions.
# =============================================================================

from pydantic import BaseModel


class MasterStatsResponse(BaseModel):
    """GET /api/v1/masters/me/stats?period=week|month.

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
