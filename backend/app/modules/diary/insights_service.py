# =============================================================================
# VELO Backend -- Diary Insights & Reviews Service (Phase 8.4 + E1,
#                                                     W25 split from service.py)
# =============================================================================
#
# Master-facing analytics: anonymous aggregated insights (get_practice_insights)
# and named/de-anonymised reviews (list_practice_reviews) for a completed
# practice. ATTENTION_RATING_MAX, rating_bucket and mood_bucket are consumed
# by two masters modules (masters/reviews_service.py,
# masters/students_service.py) and, since BE-24, by
# curator_groups/feedback_service.py -- the reason this area is public API,
# not just internal to diary.
# =============================================================================

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import BadRequestError, NotFoundError
from app.modules.diary.models import Checkin, Feedback
from app.modules.practices.models import Practice, PracticeStatus
from app.modules.users.helpers import display_name
from app.modules.users.models import User


# ===================================================================
# Practice insights (Phase 8.4, master-facing)
# ===================================================================


def _score_bucket(score: int) -> str:
    """Map a 1..10 mood/rating score into a distribution bucket.

    1-3 -> low, 4-7 -> mid, 8-10 -> high. Feedback ratings reuse the same
    ranges under different names (confused/good/fire) via a name map at the
    call site.
    """
    if score <= 3:
        return "low"
    if score <= 7:
        return "mid"
    return "high"


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

    # 3. Mood distribution from check-ins, bucketed by score range
    #    (1-3 low / 4-7 mid / 8-10 high). mood is a 1..10 score now, so we
    #    pull the scores and bucket in Python rather than GROUP BY a string.
    checkins_stmt = (
        select(Checkin.mood, func.count(Checkin.id))
        .where(Checkin.practice_id == practice_id)
        .group_by(Checkin.mood)
    )
    checkins_result = await session.execute(checkins_stmt)
    checkins_buckets = {"low": 0, "mid": 0, "high": 0}
    for score, count in checkins_result.all():
        checkins_buckets[_score_bucket(score)] += count

    # 4. Rating distribution from feedbacks, bucketed by the same ranges
    #    (1-3 confused / 4-7 good / 8-10 fire).
    feedbacks_stmt = (
        select(Feedback.rating, func.count(Feedback.id))
        .where(Feedback.practice_id == practice_id)
        .group_by(Feedback.rating)
    )
    feedbacks_result = await session.execute(feedbacks_stmt)
    feedbacks_buckets = {"confused": 0, "good": 0, "fire": 0}
    _rating_bucket_name = {"low": "confused", "mid": "good", "high": "fire"}
    for score, count in feedbacks_result.all():
        feedbacks_buckets[_rating_bucket_name[_score_bucket(score)]] += count

    # 5. Count feedbacks with comments.
    comments_stmt = (
        select(func.count(Feedback.id))
        .where(
            Feedback.practice_id == practice_id,
            Feedback.comment.isnot(None),
        )
    )
    comments_count = (await session.execute(comments_stmt)).scalar_one()

    # MoodDistribution / RatingDistribution fields are required; the buckets
    # above are pre-seeded with all keys at 0, so missing scores are covered.
    return {
        "practice_id": practice_id,
        "participants": participants,
        "checkins": {
            "high": checkins_buckets["high"],
            "mid": checkins_buckets["mid"],
            "low": checkins_buckets["low"],
        },
        "feedbacks": {
            "fire": feedbacks_buckets["fire"],
            "good": feedbacks_buckets["good"],
            "confused": feedbacks_buckets["confused"],
        },
        "comments_count": comments_count,
    }


# ===================================================================
# Practice reviews (E1, master-facing, NON-anonymous)
# ===================================================================

# Rating helpers shared with the cross-practice feed in masters/reviews_service
# (S-1): public so the import targets diary's intentional API. The reviewer's
# display name uses the shared users.display_name formatter (S-1c) -- see
# list_practice_reviews below.
#
# A review with rating in this range is "negative" -- the confused bucket
# (1-3). attention=True narrows the feed to exactly these for the dashboard
# "needs attention" block.
ATTENTION_RATING_MAX = 3


def rating_bucket(score: int) -> str:
    """Map a 1..10 feedback rating to its UI bucket name.

    Same ranges as _score_bucket (1-3 / 4-7 / 8-10), but renamed to the
    feedback vocabulary (confused / good / fire) so the frontend reuses the
    rating icons it already renders for the anonymous distribution.
    """
    return {"low": "confused", "mid": "good", "high": "fire"}[
        _score_bucket(score)
    ]


def mood_bucket(score: int) -> str:
    """Map a 1..10 check-in mood to its UI bucket name (low / mid / high).

    rating_bucket's twin for the OTHER score, and public for the same
    reason: curator_groups/feedback_service.py must publish a check-in
    without publishing the number behind it, and writing the 1-3 / 4-7 /
    8-10 boundaries into a third module would put one fact in three places.

    The vocabulary is the anonymous distribution's (MoodDistribution:
    high / mid / low), not the feedback one -- moods have never been called
    confused/good/fire anywhere the frontend can see.
    """
    return _score_bucket(score)


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
    narrowed to the negative bucket (rating 1-3) for the dashboard
    "needs attention" feed; the same endpoint otherwise serves the full
    per-practice list.

    Args:
        user: Authenticated user (must be the practice owner).
        practice_id: Target practice UUID.
        session: Read session.
        limit: Page size.
        offset: Page offset.
        attention: When True, return only negative reviews (rating 1-3).

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
            "rating": rating_bucket(feedback.rating),
            "comment": feedback.comment,
            "created_at": feedback.created_at,
        }
        for feedback, author in rows
    ]

    return items, total
