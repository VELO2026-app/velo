# =============================================================================
# VELO Backend -- Diary Insights & Reviews Service (Phase 8.4 + E1,
#                                                     W25 split from service.py)
# =============================================================================
#
# Master-facing analytics: anonymous aggregated insights (get_practice_insights)
# and named/de-anonymised reviews (list_practice_reviews) for a completed
# practice. score_zone, zone_counts and ATTENTION_RATING_MAX are THE source
# of the 1..10 -> zone boundaries (BE-77) and are consumed by masters
# (reviews_service, students_service, stats_service), curator_groups
# (feedback_service, analytics_service), admin/metrics and
# diary/notify_master -- the reason this area is public API, not just
# internal to diary.
# =============================================================================

from collections.abc import Iterable
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import BadRequestError, NotFoundError
from app.modules.diary.models import Checkin, Feedback, ScoreZone
from app.modules.practices.models import Practice, PracticeStatus
from app.modules.users.helpers import display_name
from app.modules.users.models import User


# ===================================================================
# Practice insights (Phase 8.4, master-facing)
# ===================================================================


# ===================================================================
# Score zones (BE-77) -- the ONLY place the boundaries are written
# ===================================================================
#
# Owner decision (BE-77, 2026-10-02): every server surface -- distributions,
# feeds, notifications, the school aggregate -- splits a 1..10 mood or
# rating into the same five zones, keyed exactly like the frontend's
# utils/moodScale.ts. One table, top score of each zone in scale order; a
# zone starts one above the previous zone's top. Check-in moods and
# feedback ratings share it: one scale, one vocabulary.
_ZONES: tuple[tuple[ScoreZone, int], ...] = (
    (ScoreZone.BAD, 2),
    (ScoreZone.LOW, 4),
    (ScoreZone.NEUTRAL, 6),
    (ScoreZone.GOOD, 8),
    (ScoreZone.FIRE, 10),
)

_ZONE_BY_SCORE: dict[int, ScoreZone] = {}
_bottom = 1
for _zone, _top in _ZONES:
    for _score in range(_bottom, _top + 1):
        _ZONE_BY_SCORE[_score] = _zone
    _bottom = _top + 1
del _bottom, _zone, _top, _score

# "Needs attention" (owner decision, BE-77): a rating in the two lowest
# zones, bad and low -- i.e. 1..4. Derived from the table, not written as a
# second number, so the threshold cannot drift from the zones it names.
ATTENTION_RATING_MAX: int = dict(_ZONES)[ScoreZone.LOW]


def score_zone(score: int) -> ScoreZone:
    """Map a stored 1..10 mood / rating score to its zone.

    A plain lookup: the score is 1..10 by the ck_checkin_mood /
    ck_feedback_rating CHECKs and the request schemas, so every reachable
    score has an entry.
    """
    return _ZONE_BY_SCORE[score]


def zone_counts(rows: Iterable[tuple[int, int]]) -> dict[str, int]:
    """Fold (score, count) rows into counts for ALL five zones.

    Every zone is present, at 0 when no score falls in it -- the response
    schemas (ScoreZoneCounts) require all five keys. Scores are folded in
    Python rather than grouped by zone in SQL: a CASE in a query would be a
    second copy of the boundaries.
    """
    counts = {zone.value: 0 for zone in ScoreZone}
    for score, count in rows:
        counts[score_zone(score).value] += count
    return counts


async def get_practice_insights(
    user: User,
    practice_id: UUID,
    session: AsyncSession,
) -> dict:
    """Get aggregated anonymous insights for a completed practice.

    Only the practice's master can access insights.

    Args:
        user: Authenticated user (must be practice owner).
        practice_id: Target practice UUID.
        session: Read session.

    Returns:
        Dict with participants, checkins distribution, feedbacks
        distribution, and comments_count.

    Raises:
        NotFoundError: Practice not found or user is not the owner (P-08).
        BadRequestError: Practice is not completed.
    """
    # 1. Load practice and verify ownership.
    practice = await session.get(Practice, practice_id)

    if practice is None or practice.master_id != user.id:
        raise NotFoundError("Practice not found")

    if practice.status != PracticeStatus.COMPLETED.value:
        raise BadRequestError(
            "Insights are only available for completed practices"
        )

    # 2. Count attended participants.
    from app.modules.bookings.models import Booking, BookingStatus
    participants_stmt = (
        select(func.count(Booking.id))
        .where(
            Booking.practice_id == practice_id,
            Booking.status == BookingStatus.ATTENDED.value,
        )
    )
    participants = (await session.execute(participants_stmt)).scalar_one()

    # 3. Mood distribution from check-ins, folded into the five zones
    #    (zone_counts).
    checkins_stmt = (
        select(Checkin.mood, func.count(Checkin.id))
        .where(Checkin.practice_id == practice_id)
        .group_by(Checkin.mood)
    )
    checkins_result = await session.execute(checkins_stmt)
    checkins = zone_counts(checkins_result.all())

    # 4. Rating distribution from feedbacks, the same five zones.
    feedbacks_stmt = (
        select(Feedback.rating, func.count(Feedback.id))
        .where(Feedback.practice_id == practice_id)
        .group_by(Feedback.rating)
    )
    feedbacks_result = await session.execute(feedbacks_stmt)
    feedbacks = zone_counts(feedbacks_result.all())

    # 5. Count feedbacks with comments.
    comments_stmt = (
        select(func.count(Feedback.id))
        .where(
            Feedback.practice_id == practice_id,
            Feedback.comment.isnot(None),
        )
    )
    comments_count = (await session.execute(comments_stmt)).scalar_one()

    # ScoreZoneCounts fields are required; zone_counts returns every zone,
    # at 0 when empty.
    return {
        "practice_id": practice_id,
        "participants": participants,
        "checkins": checkins,
        "feedbacks": feedbacks,
        "comments_count": comments_count,
    }


# ===================================================================
# Practice reviews (E1, master-facing, NON-anonymous)
# ===================================================================

# The reviewer's display name uses the shared users.display_name formatter
# (S-1c). The zone and the attention threshold are score_zone /
# ATTENTION_RATING_MAX above, shared with masters/reviews_service.


async def list_practice_reviews(
    user: User,
    practice_id: UUID,
    session: AsyncSession,
    *,
    limit: int = 20,
    offset: int = 0,
    attention: bool = False,
) -> tuple[list[dict], int]:
    """List named (de-anonymised) reviews for a completed practice.

    Master-facing counterpart to get_practice_insights: identical ownership
    and completed-practice guards (P-08: 404 to a non-owner so the practice's
    existence is not revealed), but returns the reviewer's name, avatar and
    comment text instead of anonymous counts.

    All feedbacks are included -- a missing comment is allowed and the rating
    always exists -- ordered newest-first. When attention=True, the page is
    narrowed to the reviews that need attention (rating 1-4, zones bad and
    low -- ATTENTION_RATING_MAX) for the dashboard
    "needs attention" feed; the same endpoint otherwise serves the full
    per-practice list.

    Args:
        user: Authenticated user (must be the practice owner).
        practice_id: Target practice UUID.
        session: Read session.
        limit: Page size.
        offset: Page offset.
        attention: When True, return only reviews that need attention
            (rating <= ATTENTION_RATING_MAX, i.e. 1-4).

    Returns:
        Tuple of (items, total_count). Each item is a dict ready for ReviewItem.

    Raises:
        NotFoundError: Practice not found or user is not the owner (P-08).
        BadRequestError: Practice is not completed.
    """
    # 1. Load practice and verify ownership (mirror get_practice_insights).
    practice = await session.get(Practice, practice_id)

    if practice is None or practice.master_id != user.id:
        raise NotFoundError("Practice not found")

    if practice.status != PracticeStatus.COMPLETED.value:
        raise BadRequestError(
            "Reviews are only available for completed practices"
        )

    # 2. Base query: each feedback joined to its author for name + avatar.
    base = (
        select(Feedback, User)
        .join(User, Feedback.user_id == User.id)
        .where(Feedback.practice_id == practice_id)
    )
    if attention:
        base = base.where(Feedback.rating <= ATTENTION_RATING_MAX)

    # 3. Total derived from the base query (11.1 pattern -- filters once).
    total = (
        await session.execute(
            select(func.count()).select_from(base.subquery())
        )
    ).scalar_one()

    # 4. Newest-first page.
    rows = (
        await session.execute(
            base.order_by(Feedback.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
    ).all()

    items = [
        {
            # user_id lets the frontend navigate review -> reviewer profile
            # (E1 remainder). The author User is already in the join.
            "user_id": author.id,
            "reviewer_name": display_name(author.first_name, author.last_name),
            "avatar_url": author.avatar_url,
            "rating": score_zone(feedback.rating),
            "comment": feedback.comment,
            "created_at": feedback.created_at,
        }
        for feedback, author in rows
    ]

    return items, total
