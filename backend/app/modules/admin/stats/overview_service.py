# =============================================================================
# VELO Backend -- Admin Stats Overview Service (E7)
# =============================================================================
#
# Read-only period-scoped platform overview for the admin dashboard. One call
# returns growth counts, revenue, engagement rates, and the pending-reports
# badge, each (except pending_reports) for the current calendar period with a
# period-over-period delta.
#
# DEFINITIONS (reused, not reinvented):
#   new_users / new_masters -- users (role==MASTER for the latter) whose
#     created_at falls in the period. "new_masters" tracks account-registration
#     date, symmetric with new_users (agreed convention; there is no clean
#     "became master at" timestamp).
#   practices_count -- platform practices scheduled in the period, excluding
#     draft / deleted / cancelled (same exclusion as master stats, E7).
#   revenue_cents / commission_cents -- GMV (completed Purchase.paid_cents) and
#     platform cut (CompanyLedger COMMISSION), mirroring admin revenue (E9/4b).
#   *_rate -- check-in / feedback / return, mirroring admin metrics (E9/4a),
#     anchored on Practice.scheduled_at:
#       check-in : checked-in non-cancelled bookings / non-cancelled bookings,
#                  for practices that have ENDED by wall-clock (W3, ПРОМТ №387
#                  -- NOT Booking.status==ATTENDED, which lags behind wall-clock
#                  end until autofinalize polls; same D4 bug class already
#                  fixed in admin/metrics/service.py).
#       feedback : feedbacks tied to non-cancelled bookings for ENDED
#                  practices / non-cancelled bookings for ENDED practices
#                  (W-3 join keeps the rate <= 100%).
#       return   : period attendees who also attended before the period start
#                  / period attendees. (Still ATTENDED-gated -- see the note
#                  on _return_counts.)
#   pending_reports -- COUNT(reports WHERE status=pending), period-independent.
#
# DELTAS:
#   counts / revenue -> period_delta_pct (signed %, null when prev <= 0, S-1).
#   rates -> rate_delta_pp (percentage points, null when the previous period
#            had no denominator).
#
# CALENDAR BOUNDS come from core.periods (single source of truth, E7).
#
# SESSION RULES:
#   Read-only -- callers pass get_db_reader. No commit (P-01). ORM-only.
# =============================================================================

from datetime import UTC, datetime, timedelta

import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.periods import (
    calendar_period_bounds,
    period_delta_pct,
    rate_delta_pp,
    shift_anchor,
)
from app.modules.admin.stats.overview_schemas import AdminStatsOverviewResponse
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.diary.models import Checkin, Feedback
from app.modules.payments.models import (
    CompanyLedger,
    CompanyLedgerType,
    LedgerStatus,
    Purchase,
    PurchaseStatus,
)
from app.modules.practices.models import Practice, PracticeStatus
from app.modules.reports.models import Report, ReportStatus
from app.modules.users.models import User, UserRole

logger = structlog.get_logger()

# Practices in these statuses are not period activity (mirror master stats).
_HIDDEN_PRACTICE_STATUSES = (
    PracticeStatus.DRAFT.value,
    PracticeStatus.DELETED.value,
    PracticeStatus.CANCELLED.value,
)


def _pct(numerator: int, denominator: int) -> int:
    """Integer percent; 0 when the denominator is 0 (mirrors admin metrics)."""
    if denominator == 0:
        return 0
    return round(numerator / denominator * 100)


# ---------------------------------------------------------------------------
# Growth counts
# ---------------------------------------------------------------------------
async def _count_new_users(
    start: datetime, end: datetime, session: AsyncSession,
) -> int:
    """Users registered in [start, end)."""
    stmt = select(func.count(User.id)).where(
        User.created_at >= start,
        User.created_at < end,
    )
    return (await session.execute(stmt)).scalar_one()


async def _count_new_masters(
    start: datetime, end: datetime, session: AsyncSession,
) -> int:
    """Master-role users registered in [start, end) (by account creation)."""
    stmt = select(func.count(User.id)).where(
        User.role == UserRole.MASTER,
        User.created_at >= start,
        User.created_at < end,
    )
    return (await session.execute(stmt)).scalar_one()


async def _count_practices(
    start: datetime, end: datetime, session: AsyncSession,
) -> int:
    """Platform practices scheduled in [start, end) (excludes hidden)."""
    stmt = select(func.count(Practice.id)).where(
        Practice.status.notin_(_HIDDEN_PRACTICE_STATUSES),
        Practice.scheduled_at >= start,
        Practice.scheduled_at < end,
    )
    return (await session.execute(stmt)).scalar_one()


# ---------------------------------------------------------------------------
# Revenue
# ---------------------------------------------------------------------------
async def _sum_revenue(
    start: datetime, end: datetime, session: AsyncSession,
) -> int:
    """GMV: SUM(paid_cents) of completed purchases completed in [start, end)."""
    stmt = select(func.coalesce(func.sum(Purchase.paid_cents), 0)).where(
        Purchase.status == PurchaseStatus.COMPLETED.value,
        Purchase.completed_at >= start,
        Purchase.completed_at < end,
    )
    return (await session.execute(stmt)).scalar_one()


async def _sum_commission(
    start: datetime, end: datetime, session: AsyncSession,
) -> int:
    """Platform commission booked into the company ledger in [start, end)."""
    stmt = select(func.coalesce(func.sum(CompanyLedger.amount_cents), 0)).where(
        CompanyLedger.type == CompanyLedgerType.COMMISSION.value,
        CompanyLedger.status == LedgerStatus.DONE.value,
        CompanyLedger.created_at >= start,
        CompanyLedger.created_at < end,
    )
    return (await session.execute(stmt)).scalar_one()


# ---------------------------------------------------------------------------
# Engagement rates -- each returns (numerator, denominator) for the period
# ---------------------------------------------------------------------------
async def _past_practice_ids_in_period(
    start: datetime, end: datetime, now: datetime, session: AsyncSession,
) -> list:
    """Practice ids scheduled in [start, end) that have ENDED by wall-clock
    (scheduled_at + duration_minutes < now). Mirrors
    admin/metrics/service.py's _past_practices_in_period -- deliberately NOT
    gated on Booking.status==ATTENDED, which only flips once the async
    autofinalize worker polls (up to its poll interval after the practice
    ends). Gating on ATTENDED was the D4 bug in admin/metrics: a check-in or
    feedback lands on a still-CONFIRMED booking before finalization runs, so
    ATTENDED-scoping zeroed the rate during that window. _checkin_counts and
    _feedback_counts below had the same gate and the same bug (W3, ПРОМТ
    №386/387); this fixes both the same way metrics/service.py already fixed
    theirs, so the two admin dashboards agree.
    """
    rows = (
        await session.execute(
            select(
                Practice.id, Practice.scheduled_at, Practice.duration_minutes,
            ).where(
                Practice.status.notin_(_HIDDEN_PRACTICE_STATUSES),
                Practice.scheduled_at >= start,
                Practice.scheduled_at < end,
            )
        )
    ).all()
    return [
        r.id
        for r in rows
        if r.scheduled_at + timedelta(minutes=r.duration_minutes) < now
    ]


async def _past_practice_ids_before(
    before: datetime, now: datetime, session: AsyncSession,
) -> list:
    """Practice ids scheduled before `before` that have ENDED by wall-clock.

    Sibling of _past_practice_ids_in_period, without a lower bound -- used
    by _return_counts' "attended before the period start" side, where that
    side of the query is unbounded in the past rather than a fixed window.
    """
    rows = (
        await session.execute(
            select(
                Practice.id, Practice.scheduled_at, Practice.duration_minutes,
            ).where(
                Practice.status.notin_(_HIDDEN_PRACTICE_STATUSES),
                Practice.scheduled_at < before,
            )
        )
    ).all()
    return [
        r.id
        for r in rows
        if r.scheduled_at + timedelta(minutes=r.duration_minutes) < now
    ]


async def _checkin_counts(
    start: datetime, end: datetime, now: datetime, session: AsyncSession,
) -> tuple[int, int]:
    """(checked_in, total_records) over non-cancelled bookings for practices
    that have ENDED by wall-clock in [start, end) (see
    _past_practice_ids_in_period -- NOT gated on Booking.status==ATTENDED)."""
    past_ids = await _past_practice_ids_in_period(start, end, now, session)
    if not past_ids:
        return 0, 0
    total = (
        await session.execute(
            select(func.count(Booking.id)).where(
                Booking.practice_id.in_(past_ids),
                Booking.status != BookingStatus.CANCELLED.value,
            )
        )
    ).scalar_one()
    checked = (
        await session.execute(
            select(func.count(func.distinct(Booking.id)))
            .select_from(Booking)
            .join(Checkin, Checkin.booking_id == Booking.id)
            .where(
                Booking.practice_id.in_(past_ids),
                Booking.status != BookingStatus.CANCELLED.value,
            )
        )
    ).scalar_one()
    return checked, total


async def _feedback_counts(
    start: datetime, end: datetime, now: datetime, session: AsyncSession,
) -> tuple[int, int]:
    """(left_review, visited) over practices that have ENDED by wall-clock in
    [start, end) (see _past_practice_ids_in_period -- NOT gated on
    Booking.status==ATTENDED).

    left_review still requires a matching non-cancelled booking on the same
    (practice_id, user_id) as the feedback, so it never exceeds visited (W-3,
    unchanged).
    """
    past_ids = await _past_practice_ids_in_period(start, end, now, session)
    if not past_ids:
        return 0, 0
    visited = (
        await session.execute(
            select(func.count(Booking.id)).where(
                Booking.practice_id.in_(past_ids),
                Booking.status != BookingStatus.CANCELLED.value,
            )
        )
    ).scalar_one()
    left_review = (
        await session.execute(
            select(func.count())
            .select_from(Feedback)
            .join(
                Booking,
                (Booking.practice_id == Feedback.practice_id)
                & (Booking.user_id == Feedback.user_id),
            )
            .where(
                Feedback.practice_id.in_(past_ids),
                Booking.status != BookingStatus.CANCELLED.value,
            )
        )
    ).scalar_one()
    return left_review, visited


async def _return_counts(
    start: datetime, end: datetime, now: datetime, session: AsyncSession,
) -> tuple[int, int]:
    """(returning, total_users) over period attendees in [start, end).

    returning = period attendees who also attended a practice that had
    ENDED (by wall-clock) before the period start.

    SW11 (Батч B, ПРОМТ №579): "attended" is now a Checkin row on a
    non-cancelled booking for a practice that has ENDED by wall-clock --
    the same signal _checkin_counts uses -- NOT Booking.status==ATTENDED,
    which was the same autofinalize-lag class already fixed for
    _checkin_counts/_feedback_counts (see _past_practice_ids_in_period's
    docstring): a check-in lands on a still-CONFIRMED booking before
    autofinalize flips it, so ATTENDED-gating undercounted here exactly
    the way it did there.
    """
    past_ids = await _past_practice_ids_in_period(start, end, now, session)
    period_user_ids: set = set()
    if past_ids:
        period_user_ids = set(
            (
                await session.execute(
                    select(func.distinct(Booking.user_id))
                    .select_from(Booking)
                    .join(Checkin, Checkin.booking_id == Booking.id)
                    .where(
                        Booking.practice_id.in_(past_ids),
                        Booking.status != BookingStatus.CANCELLED.value,
                    )
                )
            ).scalars().all()
        )
    total_users = len(period_user_ids)

    returning = 0
    if period_user_ids:
        prior_ids = await _past_practice_ids_before(start, now, session)
        if prior_ids:
            returning_ids = set(
                (
                    await session.execute(
                        select(func.distinct(Booking.user_id))
                        .select_from(Booking)
                        .join(Checkin, Checkin.booking_id == Booking.id)
                        .where(
                            Booking.practice_id.in_(prior_ids),
                            Booking.status != BookingStatus.CANCELLED.value,
                            Booking.user_id.in_(period_user_ids),
                        )
                    )
                ).scalars().all()
            )
            returning = len(returning_ids)
    return returning, total_users


def _rate_with_delta(
    cur: tuple[int, int], prev: tuple[int, int],
) -> tuple[int, int | None]:
    """Return (current_rate_pct, point_delta_vs_prev).

    The delta is None when the previous period had no denominator (no activity
    to compare against), so an empty prior period never shows a misleading
    jump from 0.
    """
    cur_num, cur_den = cur
    prev_num, prev_den = prev
    current_rate = _pct(cur_num, cur_den)
    prev_rate = _pct(prev_num, prev_den) if prev_den > 0 else None
    return current_rate, rate_delta_pp(current_rate, prev_rate)


async def get_admin_stats_overview(
    period: str,
    session: AsyncSession,
    *,
    offset: int = 0,
) -> AdminStatsOverviewResponse:
    """Period-scoped platform overview + deltas for the admin dashboard.

    `offset` steps the window by whole periods (0 = current, -1 = previous
    week/month, +1 = next) for the dashboard stepper. The delta is still vs the
    period immediately before the navigated one. Default 0 preserves behavior.
    """
    now = datetime.now(UTC)
    anchor = shift_anchor(period, now, offset)
    cur_start, cur_end, prev_start = calendar_period_bounds(period, anchor)

    # -- growth counts (current + previous) --
    new_users = await _count_new_users(cur_start, cur_end, session)
    prev_new_users = await _count_new_users(prev_start, cur_start, session)
    new_masters = await _count_new_masters(cur_start, cur_end, session)
    prev_new_masters = await _count_new_masters(prev_start, cur_start, session)
    practices = await _count_practices(cur_start, cur_end, session)
    prev_practices = await _count_practices(prev_start, cur_start, session)

    # -- revenue (current + previous) + commission (current) --
    revenue = await _sum_revenue(cur_start, cur_end, session)
    prev_revenue = await _sum_revenue(prev_start, cur_start, session)
    commission = await _sum_commission(cur_start, cur_end, session)

    # -- engagement rates (current + previous) --
    checkin_rate, checkin_delta = _rate_with_delta(
        await _checkin_counts(cur_start, cur_end, now, session),
        await _checkin_counts(prev_start, cur_start, now, session),
    )
    feedback_rate, feedback_delta = _rate_with_delta(
        await _feedback_counts(cur_start, cur_end, now, session),
        await _feedback_counts(prev_start, cur_start, now, session),
    )
    return_rate, return_delta = _rate_with_delta(
        await _return_counts(cur_start, cur_end, now, session),
        await _return_counts(prev_start, cur_start, now, session),
    )

    # -- moderation (period-independent) --
    pending_reports = (
        await session.execute(
            select(func.count(Report.id)).where(
                Report.status == ReportStatus.PENDING.value,
            )
        )
    ).scalar_one()

    return AdminStatsOverviewResponse(
        new_users=new_users,
        new_users_delta_pct=period_delta_pct(new_users, prev_new_users),
        new_masters=new_masters,
        new_masters_delta_pct=period_delta_pct(new_masters, prev_new_masters),
        practices_count=practices,
        practices_delta_pct=period_delta_pct(practices, prev_practices),
        revenue_cents=revenue,
        revenue_delta_pct=period_delta_pct(revenue, prev_revenue),
        commission_cents=commission,
        checkin_rate_pct=checkin_rate,
        checkin_rate_delta=checkin_delta,
        feedback_rate_pct=feedback_rate,
        feedback_rate_delta=feedback_delta,
        return_rate_pct=return_rate,
        return_rate_delta=return_delta,
        pending_reports=pending_reports,
    )
