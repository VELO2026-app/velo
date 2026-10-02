# =============================================================================
# VELO Backend -- Curator Group Analytics Service (tz-curator.md §6 MVP)
# =============================================================================
#
# ONE aggregate for the curator's "how is my school doing" screen. The §6
# gate (PM-2) was lifted by the owner on 2026-10-02; until the spec lands
# this endpoint ships the four metrics the existing tables answer without
# a new column, an index or a backfill:
#
#   practices     -- counts by lifecycle state (completed / upcoming);
#   members       -- active memberships by kind (the roster's rows);
#   engagement    -- the PERIOD-SCOPED cards (owner brief 2026-10-02, part 1):
#                    practices conducted / people who came / came again /
#                    joined-but-never-came, scoped by ?period=week|month|
#                    quarter over the CURATOR'S OWN calendar (BE-34 bounds);
#   feedback      -- PRE check-in mood + review rating, BUCKETED, with the
#                    EXACT predicates of the two BE-24 feeds (a number on
#                    the analytics screen must reconcile with the feed it
#                    came from, or the curator sees two truths);
#   top_practices -- completed practices ranked by check-ins + reviews.
#
# ENGAGEMENT VOCABULARY (pinned here once; the cards' labels paraphrase it):
#   conducted = the practice's status is COMPLETED (the platform settled the
#     session, GT-20) and its scheduled_at is inside the window -- the same
#     anchor as the master dashboard's practices_count;
#   came = an ATTENDED booking on a school practice scheduled in the window.
#     ATTENDED is written only at or after finalization, so such a booking
#     always sits on a COMPLETED practice (the master-stats reasoning) and
#     the pair cannot disagree;
#   came again = >=2 attended bookings in the window;
#   joined and never came = a STUDENT-kind member with zero attended
#     bookings on this school's practices EVER (lifetime -- the slider does
#     not move it). Masters are appointed, not joined, and conduct rather
#     than book, so their rows stay out of every denominator;
#   left a review = a distinct user whose Feedback landed on a school
#     practice scheduled in the window (the reviews feed has no booking
#     filter, and neither does this -- same anchor, same buckets as the
#     all-time rating group, so the two distributions reconcile). The
#     «процент фидбеков» divides reviewers by members.students on the
#     client: the denominator already rides the payload, and one fact in
#     one field cannot disagree with itself;
#   conducted practices (part 3, owner 2026-10-02) = EVERY completed
#     practice in the window, newest first, each carrying its own
#     attendance (distinct ATTENDED), check-ins (PRE on non-cancelled
#     bookings -- the /checkins feed predicate) and feedback aggregates
#     (distinct reviewers + the five-scale buckets). The client renders a
#     card per practice with its own strip, so the per-practice numbers
#     use the same predicates as the totals -- a card's attendees sum into
#     «человек приходило» up to double-attendance overlap.
#
# THE BE-24 RULE STANDS: reach, not depth. Bucketed scores only, no
# per-student rows, no raw 1..10, no comment text -- the feeds already show
# the named detail; this screen is the shape of it.
#
# SESSION RULES: read-only -- callers pass get_db_reader. No commit (P-01).
# =============================================================================

from datetime import UTC, datetime
from uuid import UUID

import structlog
from sqlalchemy import distinct, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.periods import calendar_period_bounds_in_tz
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.curator_groups.models import (
    CuratorGroupMember,
    CuratorMemberKind,
)
from app.modules.curator_groups.service import _get_group_or_404
from app.modules.diary.insights_service import (
    mood_bucket,
    rating_bucket_five,
)
from app.modules.diary.models import Checkin, CheckType, Feedback
from app.modules.practices.audience_service import (
    practice_in_curator_group_clause,
)
from app.modules.practices.models import Practice, PracticeStatus
from app.modules.users.helpers import display_name
from app.modules.users.models import User

logger = structlog.get_logger()

TOP_PRACTICES_LIMIT = 5


async def get_curator_group_analytics(
    user: User,
    group_id: UUID,
    session: AsyncSession,
    period: str,
) -> dict:
    """The school's analytics aggregate (§6).

    Ownership goes through _get_group_or_404: another curator's school and
    a school that does not exist are the same 404 (P-08).

    Takes the whole User, not an id: the engagement window is the curator's
    own calendar (calendar_period_bounds_in_tz, BE-34), and the timezone
    that defines it lives on the same row as the id that scopes the query
    -- the same call get_master_analytics makes.

    Returns a dict ready for CuratorGroupAnalyticsResponse.
    """
    group = await _get_group_or_404(user.id, group_id, session)
    window_start, window_end, _prev_start = calendar_period_bounds_in_tz(
        period, datetime.now(UTC), user.timezone,
    )

    # -- Practices by state. Drafts/cancelled/deleted stay out of every
    #    number: the total on the screen is "ran + planned", and a curator
    #    doing arithmetic on it must not need to know what a draft is.
    status_rows = (
        await session.execute(
            select(Practice.status, func.count())
            .where(Practice.curator_group_id == group.id)
            .group_by(Practice.status)
        )
    ).all()
    by_status = {status: count for status, count in status_rows}
    completed = by_status.get(PracticeStatus.COMPLETED.value, 0)
    upcoming = (
        by_status.get(PracticeStatus.SCHEDULED.value, 0)
        + by_status.get(PracticeStatus.LIVE.value, 0)
    )

    # -- Active memberships, grouped in one pass (the page's counters read
    #    the same rows; the two screens must never disagree).
    member_rows = (
        await session.execute(
            select(CuratorGroupMember.kind, func.count())
            .where(CuratorGroupMember.group_id == group.id)
            .group_by(CuratorGroupMember.kind)
        )
    ).all()
    by_kind = {kind: count for kind, count in member_rows}

    payload = await _feedback_and_top(group.id, session, completed, upcoming, by_kind)
    payload["engagement"] = await _engagement(group.id, window_start, window_end, session)
    return payload


async def _feedback_and_top(
    group_id: UUID,
    session: AsyncSession,
    completed: int,
    upcoming: int,
    by_kind: dict,
) -> dict:
    """The second half of the aggregate: the two bucketed distributions and
    the top-practices ranking. Split out only to keep each function's shape
    readable; there is no second caller."""
    # -- Mood buckets over PRE check-ins on the school's practices. Grouped
    #    by the RAW score (at most ten groups) and bucketed in Python, so
    #    the 1-3/4-7/8-10 boundaries live only in insights_service, exactly
    #    as the feeds do it.
    mood_rows = (
        await session.execute(
            select(Checkin.mood, func.count())
            .join(Practice, Checkin.practice_id == Practice.id)
            .join(Booking, Checkin.booking_id == Booking.id)
            .where(
                practice_in_curator_group_clause(group_id),
                Checkin.check_type == CheckType.PRE.value,
                Booking.status != BookingStatus.CANCELLED.value,
            )
            .group_by(Checkin.mood)
        )
    ).all()
    mood = {"low": 0, "mid": 0, "high": 0}
    for raw_mood, count in mood_rows:
        mood[mood_bucket(raw_mood)] += count

    # -- Rating buckets over reviews. NO booking-status filter, matching
    #    the reviews feed (BE-24): a review the practice's master reads is
    #    a review the school counts.
    rating_rows = (
        await session.execute(
            select(Feedback.rating, func.count())
            .join(Practice, Feedback.practice_id == Practice.id)
            .where(practice_in_curator_group_clause(group_id))
            .group_by(Feedback.rating)
        )
    ).all()
    rating = {"bad": 0, "low": 0, "neutral": 0, "good": 0, "fire": 0}
    for raw_rating, count in rating_rows:
        rating[rating_bucket_five(raw_rating)] += count

    # -- The completed practices ranked by engagement. The per-practice
    #    counts reuse the same predicates as the two aggregates above, so a
    #    row's numbers sum into the screens' totals (up to the limit-5 cut).
    checkin_counts = (
        select(Checkin.practice_id, func.count().label("checkins"))
        .join(Booking, Checkin.booking_id == Booking.id)
        .where(
            Checkin.check_type == CheckType.PRE.value,
            Booking.status != BookingStatus.CANCELLED.value,
        )
        .group_by(Checkin.practice_id)
        .subquery()
    )
    feedback_counts = (
        select(Feedback.practice_id, func.count().label("reviews"))
        .group_by(Feedback.practice_id)
        .subquery()
    )
    engagement = func.coalesce(checkin_counts.c.checkins, 0) + func.coalesce(
        feedback_counts.c.reviews, 0
    )
    top_rows = (
        await session.execute(
            select(
                Practice,
                User,
                func.coalesce(checkin_counts.c.checkins, 0),
                func.coalesce(feedback_counts.c.reviews, 0),
            )
            .join(User, Practice.master_id == User.id)
            .outerjoin(checkin_counts, checkin_counts.c.practice_id == Practice.id)
            .outerjoin(feedback_counts, feedback_counts.c.practice_id == Practice.id)
            .where(
                Practice.curator_group_id == group_id,
                Practice.status == PracticeStatus.COMPLETED.value,
            )
            .order_by(engagement.desc(), Practice.scheduled_at.desc())
            .limit(TOP_PRACTICES_LIMIT)
        )
    ).all()

    return {
        "practices": {
            "total": completed + upcoming,
            "completed": completed,
            "upcoming": upcoming,
        },
        "members": {
            "masters": by_kind.get("master", 0),
            "students": by_kind.get("student", 0),
        },
        "feedback": {
            "checkins_count": sum(mood.values()),
            "reviews_count": sum(rating.values()),
            "mood": mood,
            "rating": rating,
        },
        "top_practices": [
            {
                "practice_id": practice.id,
                "title": practice.title,
                "master_name": display_name(master.first_name, master.last_name),
                "scheduled_at": practice.scheduled_at,
                "checkins_count": checkins,
                "reviews_count": reviews,
            }
            for practice, master, checkins, reviews in top_rows
        ],
    }


async def _engagement(
    group_id: UUID,
    window_start: datetime,
    window_end: datetime,
    session: AsyncSession,
) -> dict:
    """The period-scoped cards (owner brief 2026-10-02, parts 1-2).

    See the module header for the exact vocabulary. Grouped statements:
    one count for conducted, one per-user grouping that answers «came» and
    «came again» off the same rows (so the pair cannot disagree), the
    lifetime never-came count, and the feedback pair (distinct reviewers +
    the rating buckets, both window-anchored on the practice).
    """
    # -- Conducted: COMPLETED practices scheduled inside the window. The
    #    practice-status filter is what keeps a cancelled session that
    #    happened to sit inside the window out of «проведено».
    conducted_count = (
        await session.execute(
            select(func.count())
            .select_from(Practice)
            .where(
                Practice.curator_group_id == group_id,
                Practice.status == PracticeStatus.COMPLETED.value,
                Practice.scheduled_at >= window_start,
                Practice.scheduled_at < window_end,
            )
        )
    ).scalar_one()

    # -- Who came, grouped per user: the row count is «человек приходило»
    #    and the >=2 rows are «пришли ещё раз». Anchored on the practice's
    #    scheduled_at, so attendance lands in the period the session
    #    happened in, not the day somebody's booking was finalized.
    per_user_rows = (
        await session.execute(
            select(Booking.user_id, func.count())
            .join(Practice, Booking.practice_id == Practice.id)
            .where(
                Practice.curator_group_id == group_id,
                Practice.scheduled_at >= window_start,
                Practice.scheduled_at < window_end,
                Booking.status == BookingStatus.ATTENDED.value,
            )
            .group_by(Booking.user_id)
        )
    ).all()
    attendees = len(per_user_rows)
    repeat_attendees = sum(1 for _user_id, count in per_user_rows if count >= 2)

    # -- Joined and never came: LIFETIME (every window contains every
    #    never-came member equally), student rows only. NOT IN over the
    #    school's all-time attendees; user_id is never NULL, so the empty
    #    subquery case degrades to «everyone never came» -- correct for a
    #    school that has never held a practice.
    ever_attended = (
        select(Booking.user_id)
        .join(Practice, Booking.practice_id == Practice.id)
        .where(
            Practice.curator_group_id == group_id,
            Booking.status == BookingStatus.ATTENDED.value,
        )
        .scalar_subquery()
    )
    never_came = (
        await session.execute(
            select(func.count())
            .select_from(CuratorGroupMember)
            .where(
                CuratorGroupMember.group_id == group_id,
                CuratorGroupMember.kind == CuratorMemberKind.STUDENT.value,
                CuratorGroupMember.user_id.not_in(ever_attended),
            )
        )
    ).scalar_one()

    # -- The feedback share («Процент фидбеков», owner 2026-10-02): distinct
    #    users whose review landed on an in-window practice, plus the
    #    in-window rating buckets on the FIVE scale (rating_bucket_five --
    #    the same mapping as the all-time group above, so the two always
    #    reconcile; the /reviews FEED keeps its three-chip rating_bucket,
    #    a chip and a strip segment are different answers by design).
    #    SAME anchor as attendance (the practice's scheduled_at).
    #    The denominator is NOT computed here: it is members.students, which
    #    already rides the payload -- one fact, one field.
    reviewer_rows = (
        await session.execute(
            select(Feedback.user_id, func.count())
            .join(Practice, Feedback.practice_id == Practice.id)
            .where(
                Practice.curator_group_id == group_id,
                Practice.scheduled_at >= window_start,
                Practice.scheduled_at < window_end,
            )
            .group_by(Feedback.user_id)
        )
    ).all()

    window_rating_rows = (
        await session.execute(
            select(Feedback.rating, func.count())
            .join(Practice, Feedback.practice_id == Practice.id)
            .where(
                Practice.curator_group_id == group_id,
                Practice.scheduled_at >= window_start,
                Practice.scheduled_at < window_end,
            )
            .group_by(Feedback.rating)
        )
    ).all()
    window_rating = {"bad": 0, "low": 0, "neutral": 0, "good": 0, "fire": 0}
    for raw_rating, count in window_rating_rows:
        window_rating[rating_bucket_five(raw_rating)] += count

    # -- The period's conducted practices (part 3, owner 2026-10-02): every
    #    COMPLETED practice of the window, newest first. The practices are
    #    fetched first (a bounded set -- the window), then the per-practice
    #    aggregates run as IN-queries over their ids with the SAME
    #    predicates the totals above use, so a card's numbers reconcile
    #    with the cards and totals around it.
    practice_rows = (
        await session.execute(
            select(Practice, User)
            .join(User, Practice.master_id == User.id)
            .where(
                Practice.curator_group_id == group_id,
                Practice.status == PracticeStatus.COMPLETED.value,
                Practice.scheduled_at >= window_start,
                Practice.scheduled_at < window_end,
            )
            .order_by(Practice.scheduled_at.desc())
        )
    ).all()

    conducted: list[dict] = []
    if practice_rows:
        practice_ids = [practice.id for practice, _master in practice_rows]

        attendee_counts = dict(
            (
                await session.execute(
                    select(Booking.practice_id, func.count(distinct(Booking.user_id)))
                    .where(
                        Booking.practice_id.in_(practice_ids),
                        Booking.status == BookingStatus.ATTENDED.value,
                    )
                    .group_by(Booking.practice_id)
                )
            ).all()
        )
        checkin_counts = dict(
            (
                await session.execute(
                    select(Checkin.practice_id, func.count())
                    .join(Booking, Checkin.booking_id == Booking.id)
                    .where(
                        Checkin.practice_id.in_(practice_ids),
                        Checkin.check_type == CheckType.PRE.value,
                        Booking.status != BookingStatus.CANCELLED.value,
                    )
                    .group_by(Checkin.practice_id)
                )
            ).all()
        )
        reviewer_counts = dict(
            (
                await session.execute(
                    select(Feedback.practice_id, func.count(distinct(Feedback.user_id)))
                    .where(Feedback.practice_id.in_(practice_ids))
                    .group_by(Feedback.practice_id)
                )
            ).all()
        )
        reviews_counts = dict(
            (
                await session.execute(
                    select(Feedback.practice_id, func.count())
                    .where(Feedback.practice_id.in_(practice_ids))
                    .group_by(Feedback.practice_id)
                )
            ).all()
        )
        practice_rating_rows = (
            await session.execute(
                select(Feedback.practice_id, Feedback.rating, func.count())
                .where(Feedback.practice_id.in_(practice_ids))
                .group_by(Feedback.practice_id, Feedback.rating)
            )
        ).all()
        ratings: dict[UUID, dict[str, int]] = {
            practice_id: {"bad": 0, "low": 0, "neutral": 0, "good": 0, "fire": 0}
            for practice_id in practice_ids
        }
        for practice_id, raw_rating, count in practice_rating_rows:
            ratings[practice_id][rating_bucket_five(raw_rating)] += count

        for practice, master in practice_rows:
            conducted.append(
                {
                    "practice_id": practice.id,
                    "title": practice.title,
                    # Icon facet, schema-on-read JSONB (data.taxonomy.direction).
                    "direction": (practice.data or {}).get("taxonomy", {}).get("direction"),
                    "master_name": display_name(master.first_name, master.last_name),
                    "scheduled_at": practice.scheduled_at,
                    "timezone": practice.timezone,
                    "attendees_count": attendee_counts.get(practice.id, 0),
                    "checkins_count": checkin_counts.get(practice.id, 0),
                    "reviewers_count": reviewer_counts.get(practice.id, 0),
                    "reviews_count": reviews_counts.get(practice.id, 0),
                    "rating": ratings[practice.id],
                }
            )

    return {
        "practices_conducted": conducted_count,
        "attendees": attendees,
        "repeat_attendees": repeat_attendees,
        "repeat_pct": _pct(repeat_attendees, attendees),
        "joined_never_came": never_came,
        "reviewers": len(reviewer_rows),
        "rating": window_rating,
        "conducted_practices": conducted,
    }


def _pct(part: int, total: int) -> int:
    """Integer-rounded share, 0 when there is no denominator.

    The master-analytics rule for rates: an empty period is an honest 0,
    never a null -- the card reads «0% … 0 из 0», not a dash.
    """
    if total <= 0:
        return 0
    return round(part / total * 100)