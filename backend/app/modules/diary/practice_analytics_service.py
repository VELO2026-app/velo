# =============================================================================
# VELO Backend -- Practice analytics (BE-78)
# =============================================================================
#
# The «Аналитика по практике» screen: header, the PRE / review zone
# distributions, the «пришёл -> ушёл» pairs and the reviews with text.
#
# WHO MAY READ (owner, BE-78): the practice's leading master; for a practice
# OWNED by a school (Practice.school_id, BE-74) also that school's
# curator and its masters who are verified right now. That second half is
# the audience module's own predicate, master_broadcasts_to_school_clause --
# "curator of the school, or a kind='master' member with a verified profile"
# -- asked about the VIEWER instead of the teacher: the same people, one
# definition, so a suspended master loses this screen exactly when the school
# stops showing them. Everyone else -- admin included -- gets the masked 404
# (P-08), checked BEFORE the status, so the 400 "not completed" is only ever
# seen by someone entitled to the practice.
#
# ONE POPULATION: the practice's ATTENDED bookings. Every block counts only
# them, so every "X of N" uses N = attended and they reconcile. A PRE
# check-in of a no-show, of a booking Zoom has not judged yet (CONFIRMED) or
# of a cancelled booking is not «до». Reviews need no such filtering in
# practice: one is written only on an ATTENDED booking (diary/service.py
# upsert_feedback), and no writer moves a booking off ATTENDED -- every
# status writer starts from PENDING or CONFIRMED, and cancelling is refused
# once the practice completed (bookings/service.py). So `after` holds every
# review the practice has; the filter is there because it is the one
# population, not because it drops anything.
#
# ONE COMPUTATION FOR ANY NUMBER OF PRACTICES (BE-222):
# practice_analytics_counts answers the five figures for a set of
# practices, one grouped statement per figure whatever the set's size. The
# practice's own screen asks it for one id; the master's analytics list
# (masters/stats_service.py) asks it for the period's ids. The pairs and
# reviews totals are counted over the same FROM/WHERE the two lists page
# (_pairs_from, _reviews_from), so a total always matches its list.
#
# ZONES ONLY (BE-24, schools/feedback_service.py): a curator must not
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

from collections.abc import Sequence
from uuid import UUID

from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import BadRequestError, NotFoundError
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.diary.insights_service import score_zone, zone_counts
from app.modules.diary.models import Checkin, CheckType, Feedback
from app.modules.diary.schemas import PracticeAnalyticsViewerRole
from app.modules.practices.audience_service import (
    master_broadcasts_to_school_clause,
)
from app.modules.practices.models import Practice, PracticeStatus
from app.modules.practices.service import master_full_name
from app.modules.schools.models import (
    School,
    SchoolMember,
    SchoolMemberKind,
)
from app.modules.users.helpers import display_name
from app.modules.users.models import User


async def _load_readable_practice(
    user: User,
    practice_id: UUID,
    session: AsyncSession,
) -> tuple[Practice, PracticeAnalyticsViewerRole]:
    """The practice and HOW this user reads it; else masked 404.

    Rights first, status second (owner, BE-78): only an entitled reader
    learns that the practice is not completed yet.

    The role is decided HERE, in the one rights check (BE-78 (2)), so the
    screen never derives it: leader > curator > school_master when one
    person is several (a curator who ran the practice reads it as its
    leader -- their own CRM). The school branch returns a row only when the
    audience predicate admitted the user, so "not the school's curator"
    there means "a verified master of that school".
    """
    practice = await session.get(Practice, practice_id)
    if practice is None:
        raise NotFoundError("Practice not found")
    role: PracticeAnalyticsViewerRole | None = None
    if practice.master_id == user.id:
        role = PracticeAnalyticsViewerRole.LEADER
    elif practice.school_id is not None:
        curator_user_id = await session.scalar(
            select(School.curator_user_id).where(
                School.id == practice.school_id,
                master_broadcasts_to_school_clause(user.id),
            )
        )
        if curator_user_id is not None:
            role = (
                PracticeAnalyticsViewerRole.CURATOR
                if curator_user_id == user.id
                else PracticeAnalyticsViewerRole.SCHOOL_MASTER
            )
    if role is None:
        raise NotFoundError("Practice not found")
    if practice.status != PracticeStatus.COMPLETED.value:
        raise BadRequestError("Practice is not completed")
    return practice, role


def _school_student_clause(practice_id: UUID):
    """Correlated EXISTS: the row's person is a STUDENT member of the
    practice's school right now (BE-78 (2)). One value for every reader --
    the school roster is no secret to its leader or masters (BE-76); the
    curator's screen uses it to decide whether the school student profile
    (which requires that membership) can open. False for a practice outside
    any school: the scalar subquery is NULL and the EXISTS finds nothing.
    """
    return (
        select(SchoolMember.id)
        .where(
            SchoolMember.school_id
            == select(Practice.school_id)
            .where(Practice.id == practice_id)
            .scalar_subquery(),
            SchoolMember.user_id == Booking.user_id,
            SchoolMember.kind == SchoolMemberKind.STUDENT.value,
        )
        .exists()
    )


def _attended_in(practice_ids: Sequence[UUID]):
    """Where-clause pieces: the ATTENDED bookings of these practices."""
    return (
        Booking.practice_id.in_(practice_ids),
        Booking.status == BookingStatus.ATTENDED.value,
    )


def _pairs_from(stmt: Select, practice_ids: Sequence[UUID]) -> Select:
    """«Пришёл -> ушёл» rows: an attended booking with BOTH its PRE check-in
    and its review. The one FROM/WHERE behind the pairs list and pairs_total.
    """
    return (
        stmt.select_from(Booking)
        .join(
            Checkin,
            (Checkin.booking_id == Booking.id)
            & (Checkin.check_type == CheckType.PRE.value),
        )
        .join(Feedback, Feedback.booking_id == Booking.id)
        .join(User, User.id == Booking.user_id)
        .where(*_attended_in(practice_ids))
    )


def _reviews_from(stmt: Select, practice_ids: Sequence[UUID]) -> Select:
    """Reviews WITH text of attended bookings. The one FROM/WHERE behind the
    reviews list and reviews_total; a rating with no or blank text is in
    `after` but not here.
    """
    return (
        stmt.select_from(Feedback)
        .join(Booking, Booking.id == Feedback.booking_id)
        .join(User, User.id == Booking.user_id)
        .where(
            *_attended_in(practice_ids),
            Feedback.comment.is_not(None),
            func.btrim(Feedback.comment) != "",
        )
    )


async def practice_analytics_counts(
    practice_ids: Sequence[UUID],
    session: AsyncSession,
) -> dict[UUID, dict]:
    """attended / before / after / pairs_total / reviews_total per practice.

    Five grouped statements whatever the number of practices -- no statement
    per practice. Every id passed gets an entry: a practice nobody came to
    reads 0 with all five zones present (zone_counts), not a missing key.
    No rights check and no status check here: callers decide which
    practices may be read (_load_readable_practice, or the master's own
    completed practices in masters/stats_service.py).
    """
    attended = dict(
        (
            await session.execute(
                select(Booking.practice_id, func.count(Booking.id))
                .where(*_attended_in(practice_ids))
                .group_by(Booking.practice_id)
            )
        ).all()
    )
    before_rows = (
        await session.execute(
            select(Booking.practice_id, Checkin.mood, func.count())
            .select_from(Checkin)
            .join(Booking, Booking.id == Checkin.booking_id)
            .where(
                *_attended_in(practice_ids),
                Checkin.check_type == CheckType.PRE.value,
            )
            .group_by(Booking.practice_id, Checkin.mood)
        )
    ).all()
    after_rows = (
        await session.execute(
            select(Booking.practice_id, Feedback.rating, func.count())
            .select_from(Feedback)
            .join(Booking, Booking.id == Feedback.booking_id)
            .where(*_attended_in(practice_ids))
            .group_by(Booking.practice_id, Feedback.rating)
        )
    ).all()
    pairs = dict(
        (
            await session.execute(
                _pairs_from(
                    select(Booking.practice_id, func.count()), practice_ids,
                ).group_by(Booking.practice_id)
            )
        ).all()
    )
    reviews = dict(
        (
            await session.execute(
                _reviews_from(
                    select(Booking.practice_id, func.count()), practice_ids,
                ).group_by(Booking.practice_id)
            )
        ).all()
    )

    before: dict[UUID, list[tuple[int, int]]] = {pid: [] for pid in practice_ids}
    for pid, mood, count in before_rows:
        before[pid].append((mood, count))
    after: dict[UUID, list[tuple[int, int]]] = {pid: [] for pid in practice_ids}
    for pid, rating, count in after_rows:
        after[pid].append((rating, count))

    return {
        pid: {
            "attended": attended.get(pid, 0),
            "before": zone_counts(before[pid]),
            "after": zone_counts(after[pid]),
            "pairs_total": pairs.get(pid, 0),
            "reviews_total": reviews.get(pid, 0),
        }
        for pid in practice_ids
    }


async def get_practice_analytics(
    user: User,
    practice_id: UUID,
    session: AsyncSession,
) -> dict:
    """Header, both zone distributions and the two list totals."""
    practice, role = await _load_readable_practice(user, practice_id, session)
    master = await session.get(User, practice.master_id)
    counts = (await practice_analytics_counts([practice.id], session))[practice.id]

    return {
        "practice_id": practice.id,
        "viewer_role": role,
        # Only the curator's taps need the school (the school student
        # profile route); nobody else is handed it.
        "school_id": (
            practice.school_id
            if role is PracticeAnalyticsViewerRole.CURATOR
            else None
        ),
        "title": practice.title,
        "direction": practice.direction,
        "scheduled_at": practice.scheduled_at,
        "timezone": practice.timezone,
        "master_name": master_full_name(
            master.first_name if master else None,
            master.last_name if master else None,
        ),
        "master_avatar_url": master.avatar_url if master else None,
        **counts,
    }


def _pairs_query(practice_id: UUID):
    return _pairs_from(
        select(
            Checkin.mood,
            Feedback.rating,
            User,
            _school_student_clause(practice_id).label("is_school_student"),
        ),
        [practice_id],
    )


def _reviews_query(practice_id: UUID):
    return _reviews_from(
        select(
            Feedback,
            User,
            _school_student_clause(practice_id).label("is_school_student"),
        ),
        [practice_id],
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
            "is_school_student": bool(member),
        }
        for mood, rating, person, member in rows
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
            "is_school_student": bool(member),
        }
        for feedback, person, member in rows
    ]
    return items, total or 0
