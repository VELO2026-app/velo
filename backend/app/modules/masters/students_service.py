# =============================================================================
# VELO Backend -- Master Students Service (E5)
# =============================================================================
#
# Read-only CRM aggregate over bookings + practices + diary.
#
# LIST (GET /masters/me/students) -- "Мои ученики": a "student" here is a
# user with >= 1 ATTENDED booking on a practice owned by this master, and
# ONLY that (owner-ruled, ПРОМТ №609: kept deliberately narrow, NOT
# unified with DETAIL below -- the two lists mean different things on
# purpose). Group attended bookings on the master's practices by user.
# practices_count = number of attended practices. needs_attention = the
# student's MOST RECENT feedback on this master's practices is in the
# negative bucket (rating <= 3), computed for the current page only via
# one DISTINCT ON query. Optional case-insensitive name search;
# offset/limit pagination.
#
# DETAIL (GET /masters/me/students/{id}) -- "Профиль ученика": WIDER gate
# (P6, ПРОМТ №609) -- reachable for anyone this master can already see on
# screen, via groups_service.is_master_audience_member (a derived
# "Ученики" member OR a custom-group member with no booking at all), not
# ATTENDED-only. practices_count + hours (attended duration summed / 60),
# satisfaction_pct (round(avg(rating)*10) over the student's feedbacks on
# this master's practices), and the newest recent_checkins / feedbacks
# stay attended/feedback-only and degrade to honest zeros/empty for
# someone admitted with no attended history. 404 only for someone this
# master has no relationship to at all -- see get_master_student_detail's
# own docstring.
#
# SESSION RULES:
#   Read-only -- callers pass get_db_reader. No commit (P-01).
# =============================================================================

from uuid import UUID

import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.diary.insights_service import ATTENTION_RATING_MAX
from app.modules.diary.models import Checkin, Feedback
from app.modules.masters.groups_service import is_master_audience_member
from app.modules.practices.models import Practice
from app.modules.users.helpers import display_name
from app.modules.users.models import User

logger = structlog.get_logger()

# Cap on the recent_checkins / feedbacks lists on the detail screen.
_RECENT_LIMIT = 10


async def _needs_attention_map(
    master_id: UUID,
    student_ids: list[UUID],
    session: AsyncSession,
) -> dict[UUID, bool]:
    """Map student_id -> whether their latest feedback is negative (<= 3).

    One DISTINCT ON query: ordering by (user_id, created_at DESC) makes the
    first row per user the most recent feedback. Only the current page of
    student ids is scanned. Students with no feedback are absent (default
    False at the call site).
    """
    if not student_ids:
        return {}

    stmt = (
        select(Feedback.user_id, Feedback.rating)
        .join(Practice, Feedback.practice_id == Practice.id)
        .where(
            Practice.master_id == master_id,
            Feedback.user_id.in_(student_ids),
        )
        .distinct(Feedback.user_id)
        .order_by(Feedback.user_id, Feedback.created_at.desc())
    )
    rows = (await session.execute(stmt)).all()
    return {
        user_id: rating <= ATTENTION_RATING_MAX for user_id, rating in rows
    }


async def list_master_students(
    master_id: UUID,
    session: AsyncSession,
    *,
    search: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> tuple[list[dict], int]:
    """List the master's students (attended-booking aggregate).

    Returns (items, total). Each item is a dict ready for StudentListItem.
    """
    base = (
        select(User, func.count(Booking.id).label("practices_count"))
        .join(Booking, Booking.user_id == User.id)
        .join(Practice, Booking.practice_id == Practice.id)
        .where(
            Practice.master_id == master_id,
            Booking.status == BookingStatus.ATTENDED.value,
        )
        .group_by(User.id)
    )

    if search:
        full_name = func.concat(
            func.coalesce(User.first_name, ""),
            " ",
            func.coalesce(User.last_name, ""),
        )
        base = base.where(full_name.ilike(f"%{search}%"))

    # Total = number of distinct students (drop ordering for the count).
    total = (
        await session.execute(
            select(func.count()).select_from(base.order_by(None).subquery())
        )
    ).scalar_one()

    # Most practices first, then a stable tiebreaker.
    rows = (
        await session.execute(
            base.order_by(func.count(Booking.id).desc(), User.id)
            .limit(limit)
            .offset(offset)
        )
    ).all()

    page_ids = [user.id for user, _count in rows]
    attention = await _needs_attention_map(master_id, page_ids, session)

    items = [
        {
            "id": user.id,
            "name": display_name(user.first_name, user.last_name),
            "avatar_url": user.avatar_url,
            "practices_count": count,
            "needs_attention": attention.get(user.id, False),
        }
        for user, count in rows
    ]

    return items, total


async def get_master_student_detail(
    master_id: UUID,
    student_id: UUID,
    session: AsyncSession,
) -> dict:
    """Per-student aggregate for the detail screen.

    Returns a dict ready for StudentDetailResponse.

    Raises:
        NotFoundError: when `student_id` is not someone this master can
            already see on screen -- see is_master_audience_member's own
            docstring for the two admitted cases (P6, owner-ruled widen,
            ПРОМТ №609; this screen used to gate on ATTENDED-only, the
            same as list_master_students below -- that mismatch is why a
            master could open «Мои группы» -> a member with no attended
            booking yet and get a hard 404 here).

    practices_count/hours/satisfaction_pct/recent_checkins/feedbacks below
    are STILL attended-only / feedback-only, unchanged -- widening the
    GATE does not widen what these mean. For someone admitted via the
    group-membership branch with zero bookings at all, every aggregate
    below degrades to its own honest empty value (count=0 via COALESCE/
    a grouping-less COUNT, satisfaction_pct=None, both lists=[]) rather
    than crashing or fabricating history -- none of these queries assumed
    at least one row existed.
    """
    if not await is_master_audience_member(master_id, student_id, session):
        raise NotFoundError("Student not found")

    # practices_count + attended duration in one pass. Deliberately STILL
    # ATTENDED-only (see the docstring above) -- a widened-gate student
    # with no attended booking correctly gets practices_count=0/hours=0
    # here, not an error: COUNT/COALESCE(SUM) over zero matching rows in
    # a non-grouped aggregate still returns one row of zeros, never no
    # rows at all.
    practices_count, total_minutes = (
        await session.execute(
            select(
                func.count(Booking.id),
                func.coalesce(func.sum(Practice.duration_minutes), 0),
            )
            .join(Practice, Booking.practice_id == Practice.id)
            .where(
                Practice.master_id == master_id,
                Booking.user_id == student_id,
                Booking.status == BookingStatus.ATTENDED.value,
            )
        )
    ).one()

    # Identity for the detail header — same source as the list (StudentListItem):
    # the student's User record. Guaranteed present (the booking FK references it).
    student = await session.get(User, student_id)
    name = (
        display_name(student.first_name, student.last_name)
        if student is not None else "Участник"
    )
    avatar_url = student.avatar_url if student is not None else None

    hours = round(total_minutes / 60, 1)

    # satisfaction_pct = round(avg(rating) * 10); null when no feedback.
    avg_rating = (
        await session.execute(
            select(func.avg(Feedback.rating))
            .join(Practice, Feedback.practice_id == Practice.id)
            .where(
                Practice.master_id == master_id,
                Feedback.user_id == student_id,
            )
        )
    ).scalar_one()
    satisfaction_pct = (
        round(float(avg_rating) * 10) if avg_rating is not None else None
    )

    # Recent check-ins (newest first, capped).
    checkin_rows = (
        await session.execute(
            select(Checkin.mood, Checkin.comment, Checkin.created_at)
            .join(Practice, Checkin.practice_id == Practice.id)
            .where(
                Practice.master_id == master_id,
                Checkin.user_id == student_id,
            )
            .order_by(Checkin.created_at.desc())
            .limit(_RECENT_LIMIT)
        )
    ).all()

    # Feedbacks (newest first, capped).
    feedback_rows = (
        await session.execute(
            select(Feedback.rating, Feedback.comment, Feedback.created_at)
            .join(Practice, Feedback.practice_id == Practice.id)
            .where(
                Practice.master_id == master_id,
                Feedback.user_id == student_id,
            )
            .order_by(Feedback.created_at.desc())
            .limit(_RECENT_LIMIT)
        )
    ).all()

    return {
        "name": name,
        "avatar_url": avatar_url,
        "practices_count": practices_count,
        "hours": hours,
        "satisfaction_pct": satisfaction_pct,
        "recent_checkins": [
            {"mood": mood, "comment": comment, "created_at": created_at}
            for mood, comment, created_at in checkin_rows
        ],
        "feedbacks": [
            {"rating": rating, "comment": comment, "created_at": created_at}
            for rating, comment, created_at in feedback_rows
        ],
    }
