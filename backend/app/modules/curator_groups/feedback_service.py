# =============================================================================
# VELO Backend -- Curator Group Feedback Service (BE-24 / GT-28)
# =============================================================================
#
# Two read-only feeds for the CURATOR of a school: the PRE check-ins and the
# named reviews left on the school's practices, INCLUDING practices the
# curator did not run.
#
# THE SCHOOL WIDENS THE CURATOR'S REACH, NOT THEIR DEPTH. They see more
# practices; per practice they see no more than the master who ran it, and
# on two axes deliberately less:
#
#   - the SCORES ARE BUCKETS, never the stored 1..10. mood_bucket /
#     rating_bucket, the same helpers the master's own feeds use
#     (diary/insights_service.py). The raw numbers exist in exactly one
#     master-facing place -- GET /masters/me/students/{id}, the per-student
#     dossier -- and that path is the one thing a curator must not have.
#   - CHECK-INS ARE PRE ONLY, AND ONLY ON NON-CANCELLED BOOKINGS. That is
#     what the master's own named check-in view shows (bookings/service.py
#     get_attendance); POST check-ins reach a master only through the same
#     dossier.
#
# THE SCOPE IS THE PRACTICE, NOT THE STUDENT, and that is the reason this
# module exists instead of a curator arm on masters/students_service.py.
# That service answers "everything about this student"; a curator is
# entitled to "what happened on my school's practices" and nothing wider.
# There is no per-student endpoint here and adding one would not be a
# bigger version of this feature, it would be a different one.
#
# WHICH PRACTICES ARE THE SCHOOL'S is practice_in_curator_group_clause
# (practices/audience_service.py) -- an audience row, and nothing else. A
# practice by a master who has since left the school still counts; see that
# predicate's docstring for the owner ruling behind it.
#
# SESSION RULES: read-only -- callers pass get_db_reader. No commit (P-01).
# =============================================================================

from uuid import UUID

import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.bookings.models import Booking, BookingStatus
from app.modules.curator_groups.service import _get_group_or_404
from app.modules.diary.insights_service import mood_bucket, rating_bucket
from app.modules.diary.models import Checkin, CheckType, Feedback
from app.modules.practices.audience_service import (
    practice_in_curator_group_clause,
)
from app.modules.practices.models import Practice
from app.modules.users.helpers import display_name
from app.modules.users.models import User

logger = structlog.get_logger()


async def list_curator_group_checkins(
    curator_user_id: UUID,
    group_id: UUID,
    session: AsyncSession,
    *,
    practice_id: UUID | None = None,
    limit: int = 20,
    offset: int = 0,
) -> tuple[list[dict], int]:
    """PRE check-ins on this school's practices, newest first.

    Ownership goes through _get_group_or_404, so somebody else's school and
    a school that does not exist are the same 404 (P-08) -- the curator of
    another school learns nothing about this one.

    THREE FILTERS, EACH LOAD-BEARING:
      - the practice belongs to the school (an audience row);
      - the check-in is PRE. POST is a future socket, and the only
        master-facing place it surfaces is the per-student dossier;
      - the booking is not CANCELLED. get_attendance drops those rows from
        the master's own roster, so keeping them here would show the
        curator a check-in the practice's own master cannot see.

    Ordering is the ROW's created_at, not the practice's date: the feed is
    "what has been coming in", and a school's practices are not read in one
    sitting. id descending breaks ties, so a page boundary cannot swallow
    or repeat a row when two check-ins share a timestamp.

    Args:
        curator_user_id: The authenticated curator (ownership scope).
        group_id: The school.
        session: Read session.
        practice_id: Optional narrowing to one practice of the school. NOT
            a second access rule -- a practice outside the school stays
            invisible through it, because the school predicate is still
            applied and simply matches nothing.
        limit: Page size.
        offset: Page offset.

    Returns:
        Tuple of (items, total_count). Each item is a dict ready for
        CuratorGroupCheckinItem.

    Raises:
        NotFoundError: The group does not exist or is not this curator's.
    """
    group = await _get_group_or_404(curator_user_id, group_id, session)

    base = (
        select(Checkin, User, Practice.title)
        .join(Practice, Checkin.practice_id == Practice.id)
        .join(Booking, Checkin.booking_id == Booking.id)
        .join(User, Checkin.user_id == User.id)
        .where(
            practice_in_curator_group_clause(group.id),
            Checkin.check_type == CheckType.PRE.value,
            Booking.status != BookingStatus.CANCELLED.value,
        )
    )
    if practice_id is not None:
        base = base.where(Checkin.practice_id == practice_id)

    # Total derived from the base query, so the filters are written once.
    total = (
        await session.execute(
            select(func.count()).select_from(base.subquery())
        )
    ).scalar_one()

    rows = (
        await session.execute(
            base.order_by(Checkin.created_at.desc(), Checkin.id.desc())
            .limit(limit)
            .offset(offset)
        )
    ).all()

    items = [
        {
            # The student is NAMED -- owner decision, 27 August. Anonymising
            # or aggregating here "to be safe" would be a defect, not
            # caution: a school that cannot see who wrote what cannot act
            # on it. user_id rides along for the same reason: two students
            # called Александр are two people, and the dossier screen the
            # id could address refuses a curator on its own.
            "user_id": author.id,
            "student_name": display_name(author.first_name, author.last_name),
            "avatar_url": author.avatar_url,
            "mood": mood_bucket(checkin.mood),
            "comment": checkin.comment,
            "practice_id": checkin.practice_id,
            "practice_title": practice_title,
            "created_at": checkin.created_at,
        }
        for checkin, author, practice_title in rows
    ]

    return items, total


async def list_curator_group_reviews(
    curator_user_id: UUID,
    group_id: UUID,
    session: AsyncSession,
    *,
    practice_id: UUID | None = None,
    limit: int = 20,
    offset: int = 0,
) -> tuple[list[dict], int]:
    """Named reviews on this school's practices, newest first.

    The school-scoped counterpart to masters/reviews_service.py's
    list_master_reviews, and shaped after it on purpose: same bucketed
    rating, same newest-first order, same total-from-the-base-query.

    NO BOOKING-STATUS FILTER, unlike the check-in feed above. It is not an
    omission: the master's own review feeds do not carry one either, and a
    review the master reads is a review the curator may read.

    Args, Returns, Raises: as list_curator_group_checkins.
    """
    group = await _get_group_or_404(curator_user_id, group_id, session)

    base = (
        select(Feedback, User, Practice.title)
        .join(Practice, Feedback.practice_id == Practice.id)
        .join(User, Feedback.user_id == User.id)
        .where(practice_in_curator_group_clause(group.id))
    )
    if practice_id is not None:
        base = base.where(Feedback.practice_id == practice_id)

    total = (
        await session.execute(
            select(func.count()).select_from(base.subquery())
        )
    ).scalar_one()

    rows = (
        await session.execute(
            base.order_by(Feedback.created_at.desc(), Feedback.id.desc())
            .limit(limit)
            .offset(offset)
        )
    ).all()

    items = [
        {
            "user_id": author.id,
            "student_name": display_name(author.first_name, author.last_name),
            "avatar_url": author.avatar_url,
            "rating": rating_bucket(feedback.rating),
            "comment": feedback.comment,
            "practice_id": feedback.practice_id,
            "practice_title": practice_title,
            "created_at": feedback.created_at,
        }
        for feedback, author, practice_title in rows
    ]

    return items, total
