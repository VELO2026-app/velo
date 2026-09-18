# =============================================================================
# VELO Backend -- Master Stats Service (E7)
# =============================================================================
#
# Read-only period-scoped projection for the master dashboard stat grid.
# Counts are anchored on Practice.scheduled_at within a calendar period, each
# with a period-over-period delta. The dashboard grid reads those bounds in
# UTC; the analytics summary at the bottom of this module reads them in the
# MASTER'S OWN timezone -- the two are named apart at every call site, and the
# supported periods are listed once, in core/periods.py.
#
#   practices_count    -- master's COMPLETED practices scheduled in the period.
#   participants_count -- DISTINCT users with an ATTENDED booking on those
#                         practices in the period.
#   income_cents       -- reused verbatim from the E2 finance projection
#                         (get_master_income): gross booked turnover for the
#                         period. Surfaced here for completeness so master stats
#                         and the finance screen share one income definition.
#
# WHAT THE GRID MEANS (GT-20). Both counts answer "what already happened", not
# "what is on my plate". practices_count used to include everything scheduled
# in the period, so a master with five future practices saw five under a tile
# labelled "Практик" and read it as five conducted.
#
# "Completed" is the practice STATUS, not "the clock has passed": time running
# out does not mean the practice finalized. That status is written in exactly
# one place -- _finalize_practice_core in bookings/service.py -- driven by
# bookings/autofinalize.py once the scheduled end (+ buffer) is behind us. So
# "it happened" here means the platform settled the session, not that a
# timestamp elapsed.
#
# Three consequences, all intended, none a defect:
#   - a period where every practice is still ahead reads 0 / 0 with "--" for
#     both deltas. The zero is honest, not a failed fetch.
#   - a practice running RIGHT NOW (status live) is not counted until it
#     finalizes, so a master mid-session does not see her own practice in the
#     tile. This is the first thing that will look like a bug and is not one.
#   - practices_count can be 1 while participants_count is 0. When Zoom
#     tracking is live the attendance verdict is deferred (no earlier than 15
#     minutes after the end, 2h deadline -- zoom/attendance_service.py): the
#     practice has happened and nobody is an attendee yet.
#
# WHY participants_count CARRIES NO PRACTICE-STATUS FILTER. It does not need
# one. ATTENDED is written only at or after finalization (the legacy proxy in
# bookings/service.py and zoom/attendance_service.py), and finalization is what
# sets COMPLETED, so an ATTENDED booking always sits on a COMPLETED practice.
# Narrowing practices_count therefore cannot hide an attendee: the pair stays
# coherent without a second filter.
#
# DELTAS:
#   practices / participants -- period_delta_pct (signed %, null when the
#     previous period was non-positive -- S-1). The PREVIOUS period is counted
#     by the same rule as the current one, so the percentage compares like with
#     like instead of measuring last week's plans against this week's results.
#   income -- delta_pct comes straight from get_master_income (same S-1 rule).
#
# CALENDAR BOUNDS come from core.periods (single source of truth, E7).
#
# SESSION RULES:
#   Read-only -- callers pass get_db_reader. No commit (P-01). ORM-only.
# =============================================================================

from datetime import UTC, datetime
from uuid import UUID

import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.periods import (
    calendar_period_bounds,
    calendar_period_bounds_in_tz,
    period_delta_pct,
    rate_delta_pp,
)
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.diary.insights_service import mood_bucket, rating_bucket
from app.modules.diary.models import Checkin, CheckType, Feedback
from app.modules.masters.finance_service import get_master_income
from app.modules.practices.models import Practice, PracticeStatus
from app.modules.users.models import User

logger = structlog.get_logger()


async def _count_practices(
    user_id: UUID,
    start: datetime,
    end: datetime,
    session: AsyncSession,
) -> int:
    """Count the master's COMPLETED practices scheduled in [start, end).

    COMPLETED and nothing else: draft, scheduled, live, cancelled and deleted
    are all "not a session that happened", and the tile this feeds is labelled
    "Практик". A practice scheduled inside the window but still ahead is
    deliberately absent -- see the module header for why that zero is honest.

    The window is anchored on scheduled_at, not on the finalization time: a
    completed practice belongs to the period it ran in.
    """
    stmt = select(func.count(Practice.id)).where(
        Practice.master_id == user_id,
        Practice.status == PracticeStatus.COMPLETED.value,
        Practice.scheduled_at >= start,
        Practice.scheduled_at < end,
    )
    return (await session.execute(stmt)).scalar_one()


async def _count_participants(
    user_id: UUID,
    start: datetime,
    end: datetime,
    session: AsyncSession,
) -> int:
    """Count DISTINCT attendees across the master's practices in [start, end).

    A participant is a user with an ATTENDED booking on one of this master's
    practices whose scheduled_at falls in the period. Counted distinctly, so a
    user attending several of the master's practices in the period counts once.

    Unchanged by GT-20 and deliberately not narrowed to COMPLETED practices:
    ATTENDED is written only at or after finalization, which is what sets
    COMPLETED, so every ATTENDED booking already sits on a completed practice.
    """
    stmt = (
        select(func.count(func.distinct(Booking.user_id)))
        .select_from(Booking)
        .join(Practice, Booking.practice_id == Practice.id)
        .where(
            Practice.master_id == user_id,
            Booking.status == BookingStatus.ATTENDED.value,
            Practice.scheduled_at >= start,
            Practice.scheduled_at < end,
        )
    )
    return (await session.execute(stmt)).scalar_one()


async def get_master_stats(
    user_id: UUID,
    period: str,
    session: AsyncSession,
) -> dict:
    """Period-scoped master stats + deltas. Returns a dict for MasterStatsResponse.

    practices_count (COMPLETED practices) and participants_count (their
    distinct attendees) are anchored on Practice.scheduled_at in the current
    calendar period; their deltas compare against the previous period counted
    by the same rule. income_cents / income_delta_pct are reused from the E2
    finance projection so master stats and the finance screen never disagree
    on what "income" means.
    """
    now = datetime.now(UTC)
    cur_start, cur_end, prev_start = calendar_period_bounds(period, now)

    practices = await _count_practices(user_id, cur_start, cur_end, session)
    prev_practices = await _count_practices(
        user_id, prev_start, cur_start, session,
    )

    participants = await _count_participants(
        user_id, cur_start, cur_end, session,
    )
    prev_participants = await _count_participants(
        user_id, prev_start, cur_start, session,
    )

    # Income comes from the E2 finance projection. It computes its own
    # (identical) bounds internally; the E7 follow-up refactor collapses those
    # onto core.periods too.
    income = await get_master_income(user_id, period, session)

    return {
        "practices_count": practices,
        "practices_delta_pct": period_delta_pct(practices, prev_practices),
        "participants_count": participants,
        "participants_delta_pct": period_delta_pct(
            participants, prev_participants,
        ),
        "income_cents": income["income_cents"],
        "income_delta_pct": income["delta_pct"],
    }


# ===========================================================================
# Analytics summary (BE-34) -- one request for the whole "Аналитика" screen
# ===========================================================================
#
# The screen used to build these numbers on the phone: 20 most recent
# completed practices, one insights request each, summed in the client. That
# undercounted every master with more than 20 practices in the period, called
# "week" the last 7x24 hours, and cost one round trip per practice.
#
# TWO THINGS DIFFER FROM THE DASHBOARD GRID ABOVE, both deliberate:
#   - bounds are the MASTER'S calendar, not UTC (calendar_period_bounds_in_tz).
#     A Monday practice in Europe/Moscow belongs to the master's week, and
#     until BE-34 it could land in the previous one for three hours of it.
#   - rates are percentages, so their delta is in POINTS (rate_delta_pp), not
#     a percent change of a percent.
#
# Buckets come from diary.insights_service (mood_bucket / rating_bucket), the
# same helpers the per-practice insights and the curator feeds use. The 1-3 /
# 4-7 / 8-10 thresholds are NOT restated here: a fourth copy is how three
# screens start disagreeing about what "good" means.

# THE DENOMINATOR -- which bookings count as "записавшиеся".
#
# Owner ruling (GT-39): a booking counts once it exists and was not cancelled,
# whatever the attendance machinery later decided about it.
#
# WHY NOT ATTENDED ONLY, which is what the screen does today: a check-in lands
# on a CONFIRMED booking BEFORE finalization, so scoping the denominator to
# ATTENDED zeroes the rate for the whole window between the practice ending
# and the attendance decision landing. That is the D4 bug, found and fixed
# twice in the admin dashboards (admin/metrics/service.py, then
# admin/stats/overview_service.py under W3). This is the third place, and it
# is the same bug.
#
# WHY CONFIRMED IS IN: it is not only a pre-finalization state. A practice
# with a real Zoom meeting DEFERS its confirmed bookings -- _finalize_practice
# _core leaves them CONFIRMED and zoom/report_poller.py decides them later,
# from the report or from the deadline fallback. Bounded, but live: a freshly
# completed practice legitimately shows CONFIRMED bookings.
#
# WHY PENDING IS OUT: it is the default a Booking row is created with, before
# the purchase settles -- an intention, not a booking.
# WHY CANCELLED IS OUT: the master should not be measured against a seat the
# person gave back.
#
# ONE CONSEQUENCE, REACHABLE AND LEFT VISIBLE: a person can check in and then
# cancel while the practice is still ahead, and the check-in row survives. So
# check-ins can exceed bookings and the rate can read above 100%. Not clamped
# -- a clamp would hide the only signal that this happened. Feedback cannot do
# the same: it is refused before completion (diary/service.py) and cancelling
# is refused after it (bookings/service.py), so that pair cannot occur.
_BOOKED_STATUSES = (
    BookingStatus.CONFIRMED.value,
    BookingStatus.ATTENDED.value,
    BookingStatus.NO_SHOW.value,
)


def _pct(numerator: int, denominator: int) -> int:
    """Integer percent; 0 when the denominator is 0.

    Zero rather than null, matching admin/metrics and admin/stats/overview:
    "nobody checked in out of nobody" is an honest empty, and one convention
    across the dashboards is worth more than a second opinion here. The
    DELTA is what goes null when there is no base -- see rate_delta_pp.
    """
    if denominator == 0:
        return 0
    return round(numerator / denominator * 100)


async def _count_bookings(
    user_id: UUID,
    start: datetime,
    end: datetime,
    session: AsyncSession,
) -> int:
    """Count non-cancelled bookings on the master's COMPLETED practices.

    BOOKINGS, NOT DISTINCT PEOPLE, and that is arithmetic rather than taste: a
    check-in is unique per BOOKING (Checkin's unique constraint), so the
    numerator is counted in bookings. One person with two bookings and two
    check-ins would otherwise produce 2/1 -- a 200% check-in rate.
    """
    stmt = (
        select(func.count(Booking.id))
        .select_from(Booking)
        .join(Practice, Booking.practice_id == Practice.id)
        .where(
            Practice.master_id == user_id,
            Practice.status == PracticeStatus.COMPLETED.value,
            Practice.scheduled_at >= start,
            Practice.scheduled_at < end,
            Booking.status.in_(_BOOKED_STATUSES),
        )
    )
    return (await session.execute(stmt)).scalar_one()


async def _mood_distribution(
    user_id: UUID,
    start: datetime,
    end: datetime,
    session: AsyncSession,
) -> dict[str, int]:
    """Check-in counts by mood bucket across the period's completed practices.

    Scores are pulled and bucketed in Python, exactly as the per-practice
    insights do it: grouping by a bucket in SQL would mean writing the 1-3 /
    4-7 / 8-10 boundaries into a query, which is the copy mood_bucket exists
    to prevent.
    Only PRE check-ins, like every other reader of this table
    (checkins_service, bookings/service, curator_groups/feedback_service,
    practices/enrichment_service). Not defensive decoration: uq_checkin_booking
    _type is unique on (booking_id, check_type), so a POST check-in would be a
    SECOND row for the same booking, and the denominator below counts bookings.
    Nothing writes POST today -- the filter is what keeps that true here the
    day something does, instead of quietly reporting a rate above 100%.
    """
    stmt = (
        select(Checkin.mood, func.count(Checkin.id))
        .select_from(Checkin)
        .join(Practice, Checkin.practice_id == Practice.id)
        .where(
            Practice.master_id == user_id,
            Practice.status == PracticeStatus.COMPLETED.value,
            Practice.scheduled_at >= start,
            Practice.scheduled_at < end,
            Checkin.check_type == CheckType.PRE.value,
        )
        .group_by(Checkin.mood)
    )
    buckets = {"high": 0, "mid": 0, "low": 0}
    for score, count in (await session.execute(stmt)).all():
        buckets[mood_bucket(score)] += count
    return buckets


async def _rating_distribution(
    user_id: UUID,
    start: datetime,
    end: datetime,
    session: AsyncSession,
) -> dict[str, int]:
    """Feedback counts by rating bucket across the period's completed practices.

    mood_distribution's twin; rating_bucket renames the same three ranges into
    the feedback vocabulary (confused / good / fire).
    """
    stmt = (
        select(Feedback.rating, func.count(Feedback.id))
        .select_from(Feedback)
        .join(Practice, Feedback.practice_id == Practice.id)
        .where(
            Practice.master_id == user_id,
            Practice.status == PracticeStatus.COMPLETED.value,
            Practice.scheduled_at >= start,
            Practice.scheduled_at < end,
        )
        .group_by(Feedback.rating)
    )
    buckets = {"fire": 0, "good": 0, "confused": 0}
    for score, count in (await session.execute(stmt)).all():
        buckets[rating_bucket(score)] += count
    return buckets


async def _analytics_window(
    user_id: UUID,
    start: datetime,
    end: datetime,
    session: AsyncSession,
) -> dict:
    """Every number the screen shows, for ONE window.

    Called twice -- current period and previous -- so the two sides can never
    be computed by different rules. The previous window is [prev_start,
    cur_start): calendar_period_bounds_in_tz returns contiguous bounds, so
    cur_start doubles as the previous window's end.
    """
    practices = await _count_practices(user_id, start, end, session)
    bookings = await _count_bookings(user_id, start, end, session)
    checkins = await _mood_distribution(user_id, start, end, session)
    feedbacks = await _rating_distribution(user_id, start, end, session)

    checkins_count = sum(checkins.values())
    feedbacks_count = sum(feedbacks.values())
    return {
        "practices_count": practices,
        "bookings_count": bookings,
        "checkins_count": checkins_count,
        "feedbacks_count": feedbacks_count,
        "checkin_rate_pct": _pct(checkins_count, bookings),
        "feedback_rate_pct": _pct(feedbacks_count, bookings),
        "checkins": checkins,
        "feedbacks": feedbacks,
    }


async def get_master_analytics(
    user: User,
    period: str,
    session: AsyncSession,
) -> dict:
    """Period-scoped analytics summary for one master. -> MasterAnalyticsResponse.

    Takes the User rather than a user id because it needs both halves of the
    same row -- the id to scope the query and the timezone to build the
    calendar -- and passing them separately is how a request ends up scoped to
    one master and bounded by another's calendar.

    The previous period is returned as DELTAS, not as a second copy of every
    number: counts as a signed percent change (period_delta_pct, null when the
    previous period had no base), rates as a point spread (rate_delta_pp).
    Shipping both the previous values and the deltas would put one fact in two
    fields that can disagree the moment one of them is null.
    """
    cur_start, _cur_end, prev_start = calendar_period_bounds_in_tz(
        period, datetime.now(UTC), user.timezone,
    )

    current = await _analytics_window(user.id, cur_start, _cur_end, session)
    previous = await _analytics_window(user.id, prev_start, cur_start, session)

    return {
        "practices_count": current["practices_count"],
        "practices_delta_pct": period_delta_pct(
            current["practices_count"], previous["practices_count"],
        ),
        "bookings_count": current["bookings_count"],
        "bookings_delta_pct": period_delta_pct(
            current["bookings_count"], previous["bookings_count"],
        ),
        "checkins_count": current["checkins_count"],
        "checkins_delta_pct": period_delta_pct(
            current["checkins_count"], previous["checkins_count"],
        ),
        "feedbacks_count": current["feedbacks_count"],
        "feedbacks_delta_pct": period_delta_pct(
            current["feedbacks_count"], previous["feedbacks_count"],
        ),
        "checkin_rate_pct": current["checkin_rate_pct"],
        # The previous rate is passed as None when the previous period had no
        # denominator at all: _pct would have answered an honest 0 there, and
        # "0% last week" would render as a real drop rather than "no base".
        "checkin_rate_delta_pp": rate_delta_pp(
            current["checkin_rate_pct"],
            previous["checkin_rate_pct"]
            if previous["bookings_count"] > 0
            else None,
        ),
        "feedback_rate_pct": current["feedback_rate_pct"],
        "feedback_rate_delta_pp": rate_delta_pp(
            current["feedback_rate_pct"],
            previous["feedback_rate_pct"]
            if previous["bookings_count"] > 0
            else None,
        ),
        "checkins": current["checkins"],
        "feedbacks": current["feedbacks"],
    }
