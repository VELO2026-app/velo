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
# ENGAGEMENT VOCABULARY (BE-107, owner decisions 2026-10-02/03; pinned here
# once, the cards' labels paraphrase it). Every period metric reads ONE set
# of practices -- THE PERIOD'S PRACTICES: the school's (curator_group_id),
# COMPLETED (the platform settled the session, GT-20), scheduled_at inside
# the window [start, end) of the CURATOR'S OWN calendar (BE-34 bounds).
#   conducted = the number of the period's practices;
#   came («человек приходило») = distinct users with an ATTENDED booking on
#     the period's practices WHO ARE STUDENTS OF THE SCHOOL NOW (a member
#     row of kind=student). Guests of a public school practice, the school's
#     masters and people who left (their row is deleted on leave) do not
#     count. The denominator is members.students -- the same population;
#   came again = those students with ATTENDED bookings on >= 2 DISTINCT
#     practices of the period;
#   joined and never came = students who JOINED IN THE PERIOD
#     (joined_at in the window) with no ATTENDED booking on a school
#     practice scheduled from their joining to the window's end. A practice
#     attended BEFORE joining does not count as coming. joined_at is the
#     moment of joining the school: a master demoted to student keeps the
#     joined_at of his joining (owner ruling, BE-107 gate);
#   visits / reviews (the feedback share, «X из Y») = ATTENDED bookings and
#     Feedback rows on the period's practices, EVERYONE who came (guests
#     included -- one population for both, owner ruling). A review needs an
#     ATTENDED booking (diary/service.py) and no writer ever moves a booking
#     off ATTENDED, so reviews <= visits by construction; reviews is the sum
#     of the period's rating zones (one statement), so the share reconciles
#     with the strip and with the /reviews feed. The SERVER computes
#     reviews_pct (the _pct rule, as repeat_pct);
#   the period's practices list = ALL of them, newest first, no limit, each
#     with its master's name and avatar and its own aggregates: attendees
#     (everyone ATTENDED -- «Ученики» on the card means everyone who was
#     there, VELO's own vocabulary), check-ins (the /checkins feed
#     predicate), reviews and the five-zone strip.
#
# EVERYTHING IS COUNTED IN SQL: no statement here returns a row per person.
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
from sqlalchemy import and_, distinct, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.periods import calendar_period_bounds_in_tz
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.curator_groups.models import (
    CuratorGroupMember,
    CuratorMemberKind,
)
from app.modules.curator_groups.service import _get_group_or_404
from app.modules.diary.insights_service import zone_counts
from app.modules.diary.models import Checkin, CheckType, Feedback
from app.modules.practices.audience_service import (
    practice_in_school_feedback_clause,
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
    """The second half of the aggregate: the two zone distributions and
    the top-practices ranking. Split out only to keep each function's shape
    readable; there is no second caller."""
    # -- Mood zones over PRE check-ins on the school's practices. Grouped
    #    by the RAW score (at most ten groups) and folded in Python
    #    (zone_counts), so the zone boundaries live only in
    #    insights_service, exactly as the feeds do it.
    mood_rows = (
        await session.execute(
            select(Checkin.mood, func.count())
            .join(Practice, Checkin.practice_id == Practice.id)
            .join(Booking, Checkin.booking_id == Booking.id)
            .where(
                practice_in_school_feedback_clause(group_id),
                Checkin.check_type == CheckType.PRE.value,
                Booking.status != BookingStatus.CANCELLED.value,
            )
            .group_by(Checkin.mood)
        )
    ).all()
    mood = zone_counts(mood_rows)

    # -- Rating zones over reviews. NO booking-status filter, matching
    #    the reviews feed (BE-24): a review the practice's master reads is
    #    a review the school counts.
    rating_rows = (
        await session.execute(
            select(Feedback.rating, func.count())
            .join(Practice, Feedback.practice_id == Practice.id)
            .where(practice_in_school_feedback_clause(group_id))
            .group_by(Feedback.rating)
        )
    ).all()
    rating = zone_counts(rating_rows)

    # -- The completed practices ranked by engagement. The per-practice
    #    counts reuse the same predicates as the two aggregates above, so a
    #    row's numbers sum into the screens' totals (up to the limit-5 cut).
    #    Both subqueries are narrowed to THIS school's completed practices
    #    (BE-107): grouping the whole Checkin / Feedback tables to keep five
    #    rows would read every school's history.
    school_completed = (
        Practice.curator_group_id == group_id,
        Practice.status == PracticeStatus.COMPLETED.value,
    )
    checkin_counts = (
        select(Checkin.practice_id, func.count().label("checkins"))
        .join(Booking, Checkin.booking_id == Booking.id)
        .join(Practice, Checkin.practice_id == Practice.id)
        .where(
            *school_completed,
            Checkin.check_type == CheckType.PRE.value,
            Booking.status != BookingStatus.CANCELLED.value,
        )
        .group_by(Checkin.practice_id)
        .subquery()
    )
    feedback_counts = (
        select(Feedback.practice_id, func.count().label("reviews"))
        .join(Practice, Feedback.practice_id == Practice.id)
        .where(*school_completed)
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
            .where(*school_completed)
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
    """The period-scoped cards (owner brief 2026-10-02; BE-107 decisions).

    See the module header for the exact vocabulary. A fixed number of
    statements, every one an aggregate: conducted, students who came (and
    came again) in one row, joined-in-period-and-never-came, the period's
    visits, the rating zones (whose sum is the reviews), then the practices
    list and its per-practice aggregates as IN-queries.
    """
    # THE PERIOD'S PRACTICES -- one predicate for every period metric.
    period_practices = (
        Practice.curator_group_id == group_id,
        Practice.status == PracticeStatus.COMPLETED.value,
        Practice.scheduled_at >= window_start,
        Practice.scheduled_at < window_end,
    )

    conducted_count = (
        await session.execute(
            select(func.count()).select_from(Practice).where(*period_practices)
        )
    ).scalar_one()

    # -- Students who came, and came again: one grouped subquery (one row
    #    per student, inside the database) folded into ONE result row. The
    #    member join is the decision-1 population: students of the school
    #    now; a guest, a master or a leaver has no student row here.
    per_student = (
        select(
            Booking.user_id,
            func.count(distinct(Booking.practice_id)).label("practices"),
        )
        .join(Practice, Booking.practice_id == Practice.id)
        .join(
            CuratorGroupMember,
            and_(
                CuratorGroupMember.group_id == group_id,
                CuratorGroupMember.user_id == Booking.user_id,
                CuratorGroupMember.kind == CuratorMemberKind.STUDENT.value,
            ),
        )
        .where(*period_practices, Booking.status == BookingStatus.ATTENDED.value)
        .group_by(Booking.user_id)
        .subquery()
    )
    attendees, repeat_attendees = (
        await session.execute(
            select(
                func.count(),
                func.count().filter(per_student.c.practices >= 2),
            ).select_from(per_student)
        )
    ).one()

    # -- Joined in the period and never came: correlated on the member row,
    #    so "came" means AFTER joining and before the window's end.
    came_since_joining = (
        select(Booking.id)
        .join(Practice, Booking.practice_id == Practice.id)
        .where(
            Booking.user_id == CuratorGroupMember.user_id,
            Booking.status == BookingStatus.ATTENDED.value,
            Practice.curator_group_id == group_id,
            Practice.scheduled_at >= CuratorGroupMember.joined_at,
            Practice.scheduled_at < window_end,
        )
        .exists()
    )
    never_came = (
        await session.execute(
            select(func.count())
            .select_from(CuratorGroupMember)
            .where(
                CuratorGroupMember.group_id == group_id,
                CuratorGroupMember.kind == CuratorMemberKind.STUDENT.value,
                CuratorGroupMember.joined_at >= window_start,
                CuratorGroupMember.joined_at < window_end,
                ~came_since_joining,
            )
        )
    ).scalar_one()

    # -- The feedback share: visits = everyone ATTENDED on the period's
    #    practices; reviews = the period's Feedback rows, read as the sum of
    #    their rating zones (one statement for both the strip and the count).
    visits = (
        await session.execute(
            select(func.count())
            .select_from(Booking)
            .join(Practice, Booking.practice_id == Practice.id)
            .where(*period_practices, Booking.status == BookingStatus.ATTENDED.value)
        )
    ).scalar_one()
    window_rating = zone_counts(
        (
            await session.execute(
                select(Feedback.rating, func.count())
                .join(Practice, Feedback.practice_id == Practice.id)
                .where(*period_practices)
                .group_by(Feedback.rating)
            )
        ).all()
    )
    reviews = sum(window_rating.values())

    # -- The period's practices list: ALL of them, newest first (decision
    #    4), then the per-practice aggregates as IN-queries over their ids
    #    with the same predicates the totals use.
    practice_rows = (
        await session.execute(
            select(Practice, User)
            .join(User, Practice.master_id == User.id)
            .where(*period_practices)
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
        practice_rating_rows = (
            await session.execute(
                select(Feedback.practice_id, Feedback.rating, func.count())
                .where(Feedback.practice_id.in_(practice_ids))
                .group_by(Feedback.practice_id, Feedback.rating)
            )
        ).all()
        rows_by_practice: dict[UUID, list[tuple[int, int]]] = {
            practice_id: [] for practice_id in practice_ids
        }
        for practice_id, raw_rating, count in practice_rating_rows:
            rows_by_practice[practice_id].append((raw_rating, count))
        ratings: dict[UUID, dict[str, int]] = {
            practice_id: zone_counts(rows)
            for practice_id, rows in rows_by_practice.items()
        }
        for practice, master in practice_rows:
            conducted.append(
                {
                    "practice_id": practice.id,
                    "title": practice.title,
                    # Icon facet, schema-on-read JSONB (data.taxonomy.direction).
                    "direction": (practice.data or {}).get("taxonomy", {}).get("direction"),
                    "master_name": display_name(master.first_name, master.last_name),
                    "master_avatar_url": master.avatar_url,
                    "scheduled_at": practice.scheduled_at,
                    "timezone": practice.timezone,
                    "attendees_count": attendee_counts.get(practice.id, 0),
                    "checkins_count": checkin_counts.get(practice.id, 0),
                    # The practice's reviews ARE its zone counts' sum.
                    "reviews_count": sum(ratings[practice.id].values()),
                    "rating": ratings[practice.id],
                }
            )

    return {
        "practices_conducted": conducted_count,
        "attendees": attendees,
        "repeat_attendees": repeat_attendees,
        "repeat_pct": _pct(repeat_attendees, attendees),
        "joined_never_came": never_came,
        "visits": visits,
        "reviews": reviews,
        "reviews_pct": _pct(reviews, visits),
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