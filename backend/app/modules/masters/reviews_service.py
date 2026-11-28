# =============================================================================
# VELO Backend -- Master Reviews Service (#3 -- cross-practice attention feed)
# =============================================================================
#
# Owner-scoped, read-only aggregation of named feedbacks across ALL of the
# master's COMPLETED practices -- the cross-practice counterpart to E1's
# per-practice list_practice_reviews.
#
# REUSE (consolidate, do not duplicate): the score -> zone mapping
# (score_zone, BE-77) and the attention threshold come from
# diary.insights_service; the reviewer's display name comes from the shared
# users.display_name formatter (S-1c). Neither import forms a cycle
# (users.helpers is import-free; diary.insights_service does not import
# masters reviews).
#
# attention=True narrows the feed to ratings 1-4 (zones bad and low,
# ATTENTION_RATING_MAX) for the dashboard "Требуют внимания" block;
# attention=False returns the full feed.
#
# period (BE-228) narrows the feed to the practices of the master's own
# calendar week / month / quarter. The window comes from the same call as
# GET /masters/me/analytics (calendar_period_bounds_in_tz on the master's
# timezone) and the practices from the same predicate (stats_service.
# completed_in_window), so the "Требуют внимания" block and the numbers
# above it are about the same practices by construction. A review belongs to
# the period of its PRACTICE (scheduled_at), not of the day it was written: a
# Monday review of last Friday's practice is last week's, as it is in
# analytics' feedbacks_count.
#
# Newest-first, paginated. SESSION RULES: read-only, no commit (P-01).
# =============================================================================

from datetime import UTC, datetime

import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.periods import calendar_period_bounds_in_tz
from app.modules.diary.insights_service import (
    ATTENTION_RATING_MAX,
    score_zone,
)
from app.modules.diary.models import Feedback
from app.modules.masters.stats_service import completed_in_window
from app.modules.practices.models import Practice
from app.modules.users.helpers import display_name
from app.modules.users.models import User

logger = structlog.get_logger()


async def list_master_reviews(
    user: User,
    session: AsyncSession,
    *,
    attention: bool = False,
    period: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> tuple[list[dict], int]:
    """List named reviews across the master's completed practices.

    Each feedback is joined to its author (name + avatar) and its practice
    (title). Scope is the master's own COMPLETED practices only -- a feedback
    on another master's practice, or on a not-yet-completed one, never appears.
    When attention=True the page is narrowed to the reviews that need
    attention (rating 1-4, ATTENTION_RATING_MAX) for the dashboard
    "needs attention" feed.

    Takes the User rather than a user id for the reason get_master_analytics
    does: the id scopes the query and the timezone defines the period's
    calendar, and handing them over separately is how a request ends up
    scoped to one master and bounded by another's calendar.

    Args:
        user: The authenticated master (ownership scope + calendar).
        session: Read session.
        attention: When True, return only reviews that need attention
            (rating <= ATTENTION_RATING_MAX, i.e. 1-4).
        period: "week" | "month" | "quarter" (BE-228) -- only reviews of
            practices scheduled in the master's current calendar period,
            [cur_start, cur_end) of calendar_period_bounds_in_tz. None keeps
            every period.
        limit: Page size.
        offset: Page offset.

    Returns:
        Tuple of (items, total_count). Each item is a dict ready for
        MasterReviewItem (adds practice_title vs E1's ReviewItem).
    """
    # No period: every COMPLETED practice of the master. With one: the period's
    # practices, by the predicate analytics counts them by -- the same function
    # with its window filled in (calendar_period_bounds_in_tz, the master's
    # own calendar), so the two cannot differ in what a period's practice is.
    window: tuple[datetime | None, datetime | None] = (None, None)
    if period is not None:
        cur_start, cur_end, _prev_start = calendar_period_bounds_in_tz(
            period, datetime.now(UTC), user.timezone,
        )
        window = (cur_start, cur_end)

    base = (
        select(Feedback, User, Practice.title)
        .join(Practice, Feedback.practice_id == Practice.id)
        .join(User, Feedback.user_id == User.id)
        .where(*completed_in_window(user.id, *window))
    )
    if attention:
        base = base.where(Feedback.rating <= ATTENTION_RATING_MAX)

    # Total derived from the base query (filters applied once).
    total = (
        await session.execute(
            select(func.count()).select_from(base.subquery())
        )
    ).scalar_one()

    rows = (
        await session.execute(
            # id breaks ties: reviews created in one transaction share a
            # created_at, and without a total order a page boundary may
            # repeat one review and skip another between two requests.
            base.order_by(Feedback.created_at.desc(), Feedback.id.desc())
            .limit(limit)
            .offset(offset)
        )
    ).all()

    items = [
        {
            # user_id lets the dashboard navigate review -> reviewer profile
            # (E1 remainder). The author User is already in the join.
            "user_id": author.id,
            "reviewer_name": display_name(author.first_name, author.last_name),
            "avatar_url": author.avatar_url,
            "rating": score_zone(feedback.rating),
            "comment": feedback.comment,
            "practice_title": practice_title,
            "created_at": feedback.created_at,
        }
        for feedback, author, practice_title in rows
    ]

    return items, total
