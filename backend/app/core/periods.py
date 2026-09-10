# =============================================================================
# VELO Backend -- Calendar Period Bounds + Deltas (E7)
# =============================================================================
#
# Single source of truth for the period math used by period-scoped analytics
# (master stats, admin overview, and -- pending the E7 follow-up refactor --
# finance / metrics / revenue, which still carry their own copies).
#
# calendar_period_bounds(period, now) -> (cur_start, cur_end, prev_start).
# The supported periods and their exact bounds are listed ONCE, in that
# function's docstring. Deliberately not restated here: this header and the
# docstring carried the same list until a third period was added, and the next
# one should only have to be written in a single place.
#
# All boundaries are timezone-aware UTC. cur_end doubles as prev_end (periods
# are contiguous), so the previous period is [prev_start, cur_start). A master
# or admin in another timezone sees the UTC calendar period -- an accepted
# MVP simplification (the TZ revisit flagged in finance is centralised here).
#
# period_delta_pct / rate_delta_pp encode the two delta conventions used by the
# dashboards:
#   - counts and money -> signed percent change (period_delta_pct), null when
#     the previous period was non-positive (S-1: avoids div-by-zero and the
#     sign flip abs() would introduce). The client renders "--".
#   - rates (already a percent) -> simple point spread (rate_delta_pp); a
#     percent change of a percent would mislead.
# =============================================================================

from datetime import datetime, timedelta


def calendar_period_bounds(
    period: str, now: datetime,
) -> tuple[datetime, datetime, datetime]:
    """Return (cur_start, cur_end, prev_start) for a calendar period (UTC).

    week    -> Monday 00:00 .. next Monday; prev_start = previous Monday.
    quarter -> 1st of Jan/Apr/Jul/Oct 00:00 .. 1st of the next quarter;
               prev_start = 1st of the previous quarter.
    month   -> 1st 00:00 .. next 1st;      prev_start = previous month's 1st.

    cur_end doubles as prev_end (periods are contiguous): the previous period
    is [prev_start, cur_start). `now` is expected to be timezone-aware UTC.
    Any value other than "week" and "quarter" is treated as "month" (routers
    constrain the query param via Literal, so the service layer trusts it).
    Not every router offers every period: the fallback exists for callers that
    only ever pass week or month, not as a way to accept free-form input.
    """
    if period == "week":
        cur_start = (now - timedelta(days=now.weekday())).replace(
            hour=0, minute=0, second=0, microsecond=0,
        )
        cur_end = cur_start + timedelta(weeks=1)
        prev_start = cur_start - timedelta(weeks=1)
        return cur_start, cur_end, prev_start

    if period == "quarter":
        # First month of the quarter now falls in: 1, 4, 7, 10.
        first_month = ((now.month - 1) // 3) * 3 + 1
        cur_start = now.replace(
            month=first_month, day=1,
            hour=0, minute=0, second=0, microsecond=0,
        )
        # The two year edges are NOT symmetric: only Q4 rolls forward (Oct ->
        # Jan of the next year) and only Q1 rolls back (Jan -> Oct of the
        # previous one). Same shape as the month branch below, step 3.
        if cur_start.month == 10:
            cur_end = cur_start.replace(year=cur_start.year + 1, month=1)
        else:
            cur_end = cur_start.replace(month=cur_start.month + 3)
        if cur_start.month == 1:
            prev_start = cur_start.replace(year=cur_start.year - 1, month=10)
        else:
            prev_start = cur_start.replace(month=cur_start.month - 3)
        # shift_anchor() below has no quarter branch on purpose -- the full
        # reasoning is the KNOWN CEILING marker there, not repeated here.
        return cur_start, cur_end, prev_start

    # month
    cur_start = now.replace(
        day=1, hour=0, minute=0, second=0, microsecond=0,
    )
    if cur_start.month == 12:
        cur_end = cur_start.replace(year=cur_start.year + 1, month=1)
    else:
        cur_end = cur_start.replace(month=cur_start.month + 1)
    if cur_start.month == 1:
        prev_start = cur_start.replace(year=cur_start.year - 1, month=12)
    else:
        prev_start = cur_start.replace(month=cur_start.month - 1)
    return cur_start, cur_end, prev_start


# KNOWN CEILING -- shift_anchor has no "quarter" branch.
#
# MECHANICS: the branch below is week-or-else-month. A "quarter" reaching it
#   falls into the month arithmetic, so the stepper would move the anchor by
#   one month while the grid renders three -- offset -1 would return a window
#   overlapping the current one. Wrong numbers under a correct-looking label,
#   which is the failure mode the quarter segment was withheld from the
#   dashboard to avoid in the first place.
# STATUS: acknowledged by design.
# TASK: none, deliberately. The state is unreachable today (see TRIGGER), and
#   a backlog card for an unreachable state is one nobody can close or verify.
# TRIGGER: any router whose period value reaches shift_anchor starts accepting
#   "quarter". Today all four callers are admin services (revenue, overview,
#   metrics, participants) fed by routers pinned to Literal["week", "month"],
#   and GET /masters/me/stats -- the one endpoint that does take "quarter" --
#   has no offset parameter and never calls this function.
# FIX: mirror the month arithmetic on quarters -- index the quarter as
#   year * 4 + (month - 1) // 3, add the offset, divmod back, and pin day=1 to
#   the resulting quarter's first month (calendar_period_bounds re-pins it
#   anyway).
# REJECTED: adding that branch now, together with GT-31. It would be code no
#   caller can reach, and the only test able to cover it would have to build a
#   request the routers reject -- a state the product cannot produce.
def shift_anchor(period: str, now: datetime, offset: int) -> datetime:
    """Shift `now` by `offset` whole periods (weeks or months).

    offset 0 -> now; -1 -> the previous week/month; +1 -> the next. Used by the
    admin-overview stepper: the returned anchor is fed to calendar_period_bounds,
    so the navigated period's delta is still measured against the period
    immediately before it. Pure date math -- default offset 0 is a no-op.
    """
    if offset == 0:
        return now
    if period == "week":
        return now + timedelta(weeks=offset)
    # month: shift year/month arithmetically; pin to day 1 to avoid day-overflow
    # (calendar_period_bounds re-pins day=1 anyway).
    total = now.year * 12 + (now.month - 1) + offset
    year, month0 = divmod(total, 12)
    return now.replace(year=year, month=month0 + 1, day=1)


def period_delta_pct(current: int, previous: int) -> int | None:
    """Signed percent change of `current` vs `previous`, or None.

    Returns None when `previous <= 0`: previous == 0 divides by zero, and a
    negative previous would flip the sign through the ratio. In both cases
    there is no meaningful base, so the client shows "--" instead of a
    misleading percentage (S-1 pattern, mirrors the E2 income delta).
    """
    if previous > 0:
        return round((current - previous) / previous * 100)
    return None


def rate_delta_pp(current_pct: int, previous_pct: int | None) -> int | None:
    """Difference in percentage POINTS (current - previous), or None.

    For rate metrics (check-in / feedback / return) both sides are already
    percentages, so we report the point spread rather than a percent change of
    a percent. None when there is no previous-period rate to compare against
    (e.g. the previous period had no denominator / activity).
    """
    if previous_pct is None:
        return None
    return current_pct - previous_pct
