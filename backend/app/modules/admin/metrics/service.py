# =============================================================================
# VELO Backend -- Admin Metrics Service (E9 / 4a; formulas rewritten D4/D5)
# =============================================================================
#
# Read-only engagement rates for the admin dashboard, per DISTINCT PRACTICE
# (operator formulas, PROMPT №319). All three honor the same period + offset as
# the dashboard stepper (offset 0 = current, -1 = previous week/month, ...).
#
# "PAST practice in period" (check-in / feedback denominator):
#   Practice.scheduled_at in [period_start, period_end)  AND
#   ENDED by wall-clock: scheduled_at + duration_minutes < now.
#   Real practices only (draft / cancelled / deleted excluded).
#   NOT gated on Booking.status==ATTENDED -- that gate was the D4 bug: a
#   check-in lands on a CONFIRMED booking BEFORE finalization, so ATTENDED-
#   scoping zeroed the rate.
#
# CHECK-IN rate = past practices with >=1 check-in / total past practices.
# FEEDBACK rate = past practices with >=1 feedback / total past practices.
# RETURN   rate = users with >=2 bookings in period / users with >=1 booking in
#   period. top_users = period bookers by practice-count desc, top 50.
#
# rate_pct is integer percent, 0 when the denominator is 0 (honest empty).
# CALENDAR BOUNDS + the offset shift come from core.periods (E7 single source).
#
# SESSION RULES:
#   Read-only -- callers pass get_db_reader. No commit (P-01). ORM-only.
# =============================================================================

import math
from datetime import UTC, datetime, timedelta
from uuid import UUID

import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.periods import calendar_period_bounds, shift_anchor
from app.modules.admin.metrics.schemas import (
    CheckinMetricResponse,
    FeedbackMetricResponse,
    LowCheckinPractice,
    FeedbackRatingDistribution,
    ReturnMetricResponse,
    SeriesPoint,
    TopUser,
)
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.diary.models import Checkin, Feedback
from app.modules.practices.models import Practice, PracticeStatus
from app.modules.users.helpers import display_name
from app.modules.users.models import User

logger = structlog.get_logger()

# Rating buckets (mirror E1 / diary insights): confused 1-3, good 4-7, fire 8+.
_CONFUSED_MAX = 3
_GOOD_MAX = 7

# How many practices / users to surface in the low / top sections.
_LOW_LIMIT = 5
_TOP_LIMIT = 50

# Practices that never "happened" -> excluded from the denominators (mirrors the
# admin-overview exclusion, E7).
_HIDDEN_PRACTICE_STATUSES = (
    PracticeStatus.DRAFT.value,
    PracticeStatus.DELETED.value,
    PracticeStatus.CANCELLED.value,
)


def _pct(numerator: int, denominator: int) -> int:
    """Integer percent; 0 when the denominator is 0."""
    if denominator == 0:
        return 0
    return round(numerator / denominator * 100)


def _period_window(period: str, offset: int) -> tuple[datetime, datetime, datetime]:
    """(now, start, end) for the navigated calendar period (offset-shifted)."""
    now = datetime.now(UTC)
    anchor = shift_anchor(period, now, offset)
    start, end, _prev = calendar_period_bounds(period, anchor)
    return now, start, end


def _bucket_layout(
    period: str, start: datetime, end: datetime,
) -> tuple[int, int]:
    """Return (bucket_days, n_buckets) for the series.

    week -> 7 daily buckets; month -> weekly buckets spanning the month.
    """
    if period == "week":
        return 1, 7
    total_days = (end - start).days
    return 7, max(1, math.ceil(total_days / 7))


async def _past_practices_in_period(
    start: datetime,
    end: datetime,
    now: datetime,
    session: AsyncSession,
) -> list:
    """Real practices scheduled in [start, end) that have ENDED by wall-clock.

    The "ended" test (scheduled_at + duration_minutes < now) is per-row, so it
    is applied in Python to stay SQL-dialect portable (no interval arithmetic).
    Returns lightweight rows: (id, title, scheduled_at, duration_minutes).
    """
    rows = (
        await session.execute(
            select(
                Practice.id,
                Practice.title,
                Practice.scheduled_at,
                Practice.duration_minutes,
            ).where(
                Practice.status.notin_(_HIDDEN_PRACTICE_STATUSES),
                Practice.scheduled_at >= start,
                Practice.scheduled_at < end,
            )
        )
    ).all()
    return [
        r
        for r in rows
        if r.scheduled_at + timedelta(minutes=r.duration_minutes) < now
    ]


async def get_checkin_metric(
    period: str,
    session: AsyncSession,
    *,
    offset: int = 0,
) -> CheckinMetricResponse:
    """Check-in rate (per past practice) + weekly series + low-check-in list."""
    now, start, end = _period_window(period, offset)
    past = await _past_practices_in_period(start, end, now, session)
    past_ids = [r.id for r in past]
    total_records = len(past)  # total PAST practices in the period

    # Per-practice check-in counts + participant (non-cancelled booking) counts.
    checkin_counts: dict[UUID, int] = {}
    booking_counts: dict[UUID, int] = {}
    if past_ids:
        for pid, cnt in (
            await session.execute(
                select(Checkin.practice_id, func.count(Checkin.id))
                .where(Checkin.practice_id.in_(past_ids))
                .group_by(Checkin.practice_id)
            )
        ).all():
            checkin_counts[pid] = cnt
        for pid, cnt in (
            await session.execute(
                select(Booking.practice_id, func.count(Booking.id))
                .where(
                    Booking.practice_id.in_(past_ids),
                    Booking.status != BookingStatus.CANCELLED.value,
                )
                .group_by(Booking.practice_id)
            )
        ).all():
            booking_counts[pid] = cnt

    # Numerator: distinct past practices with >=1 check-in.
    checked_in = sum(1 for r in past if checkin_counts.get(r.id, 0) > 0)

    # Series: per bucket, share of past practices that had >=1 check-in.
    bucket_days, n_buckets = _bucket_layout(period, start, end)
    bucket_total = [0] * n_buckets
    bucket_checked = [0] * n_buckets
    for r in past:
        idx = (r.scheduled_at - start).days // bucket_days
        idx = max(0, min(idx, n_buckets - 1))
        bucket_total[idx] += 1
        if checkin_counts.get(r.id, 0) > 0:
            bucket_checked[idx] += 1
    series = [
        SeriesPoint(
            label=(start + timedelta(days=i * bucket_days)).strftime("%d.%m"),
            value=_pct(bucket_checked[i], bucket_total[i]),
        )
        for i in range(n_buckets)
    ]

    # Low-check-in drill-in: per-practice participation depth (check-ins /
    # participants), lowest first -- kept for the detail screen even though the
    # headline is per-practice-binary.
    def _prate(pid: UUID) -> int:
        return _pct(checkin_counts.get(pid, 0), booking_counts.get(pid, 0))

    low_sorted = sorted(
        past, key=lambda r: (_prate(r.id), -booking_counts.get(r.id, 0)),
    )
    low_practices = [
        LowCheckinPractice(
            id=r.id,
            title=r.title,
            checkin_rate_pct=_prate(r.id),
            total=booking_counts.get(r.id, 0),
        )
        for r in low_sorted[:_LOW_LIMIT]
    ]

    return CheckinMetricResponse(
        rate_pct=_pct(checked_in, total_records),
        total_records=total_records,
        checked_in=checked_in,
        series=series,
        low_practices=low_practices,
    )


async def get_feedback_metric(
    period: str,
    session: AsyncSession,
    *,
    offset: int = 0,
) -> FeedbackMetricResponse:
    """Feedback rate (per past practice) + rating distribution for the period."""
    now, start, end = _period_window(period, offset)
    past = await _past_practices_in_period(start, end, now, session)
    past_ids = [r.id for r in past]
    visited = len(past)  # total PAST practices in the period

    # All feedbacks on those past practices: bucket ratings + which practices
    # have >=1 feedback (numerator). Per-practice denominator makes the rate
    # <= 100% structurally (former W-3 concern is now inherent).
    left_review = 0
    fire = good = confused = 0
    if past_ids:
        feedback_practice_ids: set[UUID] = set()
        rows = (
            await session.execute(
                select(Feedback.practice_id, Feedback.rating).where(
                    Feedback.practice_id.in_(past_ids)
                )
            )
        ).all()
        for pid, rating in rows:
            feedback_practice_ids.add(pid)
            if rating <= _CONFUSED_MAX:
                confused += 1
            elif rating <= _GOOD_MAX:
                good += 1
            else:
                fire += 1
        left_review = len(feedback_practice_ids)

    return FeedbackMetricResponse(
        rate_pct=_pct(left_review, visited),
        visited=visited,
        left_review=left_review,
        distribution=FeedbackRatingDistribution(
            fire=fire, good=good, confused=confused,
        ),
    )


async def get_return_metric(
    period: str,
    session: AsyncSession,
    *,
    offset: int = 0,
) -> ReturnMetricResponse:
    """Return rate (repeat-in-period) + top loyal users for the period.

    rate = users with >=2 distinct bookings in the period / users with >=1.
    top_users = period bookers ranked by distinct practice-count desc (top 50).
    """
    now, start, end = _period_window(period, offset)

    # One row per user who booked >=1 non-cancelled practice scheduled in the
    # period, with their distinct practice-count. Selecting the User entity with
    # GROUP BY User.id is PK-covered (same pattern as the prior top query).
    rows = (
        await session.execute(
            select(User, func.count(func.distinct(Booking.practice_id)))
            .join(Booking, Booking.user_id == User.id)
            .join(Practice, Booking.practice_id == Practice.id)
            .where(
                Practice.status.notin_(_HIDDEN_PRACTICE_STATUSES),
                Practice.scheduled_at >= start,
                Practice.scheduled_at < end,
                Booking.status != BookingStatus.CANCELLED.value,
            )
            .group_by(User.id)
        )
    ).all()

    total_users = len(rows)
    returning = sum(1 for _user, cnt in rows if cnt >= 2)

    top = sorted(rows, key=lambda uc: (-uc[1], str(uc[0].id)))[:_TOP_LIMIT]
    top_users = [
        TopUser(
            id=user.id,
            name=display_name(user.first_name, user.last_name),
            practices_count=cnt,
        )
        for user, cnt in top
    ]

    return ReturnMetricResponse(
        rate_pct=_pct(returning, total_users),
        total_users=total_users,
        returning=returning,
        top_users=top_users,
    )
