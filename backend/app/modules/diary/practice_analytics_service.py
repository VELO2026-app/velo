# =============================================================================
# VELO Backend -- Practice analytics (BE-78)
# =============================================================================
#
# The «Аналитика по практике» screen: header, the PRE / review zone
# distributions, the «пришёл -> ушёл» pairs and the reviews with text.
#
# WHO MAY READ (owner, BE-78): the practice's leading master; for a practice
# OWNED by a school (Practice.curator_group_id, BE-74) also that school's
# curator and its masters who are verified right now. That second half is
# the audience module's own predicate, master_broadcasts_to_group_clause --
# "curator of the school, or a kind='master' member with a verified profile"
# -- asked about the VIEWER instead of the teacher: the same people, one
# definition, so a suspended master loses this screen exactly when the school
# stops showing them. Everyone else -- admin included -- gets the masked 404
# (P-08), checked BEFORE the status, so the 400 "not completed" is only ever
# seen by someone entitled to the practice.
#
# ONE POPULATION: the practice's ATTENDED bookings. Every block counts only
# them, so every "X of N" uses N = attended and they reconcile. A PRE
# check-in of a no-show is not «до»; a booking corrected away from ATTENDED
# after its review drops out of every block at once.
#
# ZONES ONLY (BE-24, curator_groups/feedback_service.py): a curator must not
# see a stranger's stored 1..10, so the scores leave as ScoreZone -- for the
# leading master too, one contract for every reader. score_zone / zone_counts
# are the single source of the boundaries (BE-77).
#
# PAIRS are glued by BOOKING: the PRE check-in and the review of the same
# ATTENDED booking. booking_id is NOT NULL on both tables (models + their
# create migrations, never altered), so the booking is always there to glue
# by. Gluing by (practice, user) instead would pair a PRE check-in left on a
# CANCELLED booking with the review of the person's later attended booking --
# a different booking, a check-in made for an attendance that never happened.
#
# SESSION RULES: read-only -- callers pass get_db_reader. No commit (P-01).
# =============================================================================

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import BadRequestError, NotFoundError
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.curator_groups.models import CuratorGroup
from app.modules.diary.insights_service import score_zone, zone_counts
from app.modules.diary.models import Checkin, CheckType, Feedback
from app.modules.practices.audience_service import (
    master_broadcasts_to_group_clause,
)
from app.modules.practices.models import Practice, PracticeStatus
from app.modules.practices.service import master_full_name
from app.modules.users.helpers import display_name
from app.modules.users.models import User


async def _load_readable_practice(
    user: User,
    practice_id: UUID,
    session: AsyncSession,
) -> Practice:
    """The practice, if this user may read its analytics; else masked 404.

    Rights first, status second (owner, BE-78): only an entitled reader
    learns that the practice is not completed yet.
    """
    practice = await session.get(Practice, practice_id)
    if practice is None:
        raise NotFoundError("Practice not found")
    allowed = practice.master_id == user.id
    if not allowed and practice.curator_group_id is not None:
        allowed = bool(
            await session.scalar(
                select(
                    select(CuratorGroup.id)
                    .where(
                        CuratorGroup.id == practice.curator_group_id,
                        master_broadcasts_to_group_clause(user.id),
                    )
                    .exists()
                )
            )
        )
    if not allowed:
        raise NotFoundError("Practice not found")
    if practice.status != PracticeStatus.COMPLETED.value:
        raise BadRequestError("Practice is not completed")
    return practice


def _attended(practice_id: UUID):
    """Join condition pieces: the ATTENDED bookings of this practice."""
    return (
        Booking.practice_id == practice_id,
        Booking.status == BookingStatus.ATTENDED.value,
    )


async def get_practice_analytics(
    user: User,
    practice_id: UUID,
    session: AsyncSession,
) -> dict:
    """Header, both zone distributions and the two list totals."""
    practice = await _load_readable_practice(user, practice_id, session)
    master = await session.get(User, practice.master_id)

    attended = await session.scalar(
        select(func.count(Booking.id)).where(*_attended(practice_id))
    )
    before_rows = (
        await session.execute(
            select(Checkin.mood, func.count())
            .join(Booking, Booking.id == Checkin.booking_id)
            .where(
                *_attended(practice_id),
                Checkin.check_type == CheckType.PRE.value,
            )
            .group_by(Checkin.mood)
        )
    ).all()
    after_rows = (
        await session.execute(
            select(Feedback.rating, func.count())
            .join(Booking, Booking.id == Feedback.booking_id)
            .where(*_attended(practice_id))
            .group_by(Feedback.rating)
        )
    ).all()

    return {
        "practice_id": practice.id,
        "title": practice.title,
        "direction": practice.direction,
        "scheduled_at": practice.scheduled_at,
        "timezone": practice.timezone,
        "master_name": master_full_name(
            master.first_name if master else None,
            master.last_name if master else None,
        ),
        "master_avatar_url": master.avatar_url if master else None,
        "attended": attended or 0,
        "before": zone_counts(before_rows),
        "after": zone_counts(after_rows),
        "pairs_total": await session.scalar(
            select(func.count()).select_from(_pairs_query(practice_id).subquery())
        ),
        "reviews_total": await session.scalar(
            select(func.count()).select_from(_reviews_query(practice_id).subquery())
        ),
    }


def _pairs_query(practice_id: UUID):
    return (
        select(Checkin.mood, Feedback.rating, User)
        .select_from(Booking)
        .join(
            Checkin,
            (Checkin.booking_id == Booking.id)
            & (Checkin.check_type == CheckType.PRE.value),
        )
        .join(Feedback, Feedback.booking_id == Booking.id)
        .join(User, User.id == Booking.user_id)
        .where(*_attended(practice_id))
    )


def _reviews_query(practice_id: UUID):
    return (
        select(Feedback, User)
        .join(Booking, Booking.id == Feedback.booking_id)
        .join(User, User.id == Booking.user_id)
        .where(
            *_attended(practice_id),
            Feedback.comment.is_not(None),
            func.btrim(Feedback.comment) != "",
        )
    )


async def list_practice_analytics_pairs(
    user: User,
    practice_id: UUID,
    session: AsyncSession,
    *,
    limit: int,
    offset: int,
) -> tuple[list[dict], int]:
    """«Пришёл -> ушёл»: zone before and after, ordered by name, then user."""
    await _load_readable_practice(user, practice_id, session)
    base = _pairs_query(practice_id)
    total = await session.scalar(select(func.count()).select_from(base.subquery()))
    rows = (
        await session.execute(
            base.order_by(
                func.lower(func.coalesce(User.first_name, "")),
                func.lower(func.coalesce(User.last_name, "")),
                User.id,
            )
            .limit(limit)
            .offset(offset)
        )
    ).all()
    items = [
        {
            "user_id": person.id,
            "name": display_name(person.first_name, person.last_name),
            "avatar_url": person.avatar_url,
            "before_zone": score_zone(mood),
            "after_zone": score_zone(rating),
        }
        for mood, rating, person in rows
    ]
    return items, total or 0


async def list_practice_analytics_reviews(
    user: User,
    practice_id: UUID,
    session: AsyncSession,
    *,
    limit: int,
    offset: int,
) -> tuple[list[dict], int]:
    """Reviews WITH text, newest first, then id. No score: the card asks none."""
    await _load_readable_practice(user, practice_id, session)
    base = _reviews_query(practice_id)
    total = await session.scalar(select(func.count()).select_from(base.subquery()))
    rows = (
        await session.execute(
            base.order_by(Feedback.created_at.desc(), Feedback.id.desc())
            .limit(limit)
            .offset(offset)
        )
    ).all()
    items = [
        {
            "user_id": person.id,
            "name": display_name(person.first_name, person.last_name),
            "avatar_url": person.avatar_url,
            "comment": feedback.comment,
            "created_at": feedback.created_at,
        }
        for feedback, person in rows
    ]
    return items, total or 0
