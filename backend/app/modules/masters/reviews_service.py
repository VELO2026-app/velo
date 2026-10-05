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
# Newest-first, paginated. SESSION RULES: read-only, no commit (P-01).
# =============================================================================

from uuid import UUID

import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.diary.insights_service import (
    ATTENTION_RATING_MAX,
    score_zone,
)
from app.modules.diary.models import Feedback
from app.modules.practices.models import Practice, PracticeStatus
from app.modules.users.helpers import display_name
from app.modules.users.models import User

logger = structlog.get_logger()


async def list_master_reviews(
    master_id: UUID,
    session: AsyncSession,
    *,
    attention: bool = False,
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

    Args:
        master_id: The authenticated master's user id (ownership scope).
        session: Read session.
        attention: When True, return only reviews that need attention
            (rating <= ATTENTION_RATING_MAX, i.e. 1-4).
        limit: Page size.
        offset: Page offset.

    Returns:
        Tuple of (items, total_count). Each item is a dict ready for
        MasterReviewItem (adds practice_title vs E1's ReviewItem).
    """
    base = (
        select(Feedback, User, Practice.title)
        .join(Practice, Feedback.practice_id == Practice.id)
        .join(User, Feedback.user_id == User.id)
        .where(
            Practice.master_id == master_id,
            Practice.status == PracticeStatus.COMPLETED.value,
        )
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
            base.order_by(Feedback.created_at.desc())
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
