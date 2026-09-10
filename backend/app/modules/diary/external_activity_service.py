# =============================================================================
# VELO Backend -- External Activity Service (BE-27)
# =============================================================================
#
# One write path: the person records something they did OUTSIDE velo, and it
# appears in their diary immediately.
#
# ONE TRANSACTION, AND THAT IS THE WHOLE ORPHAN GUARANTEE. The activity row
# and its DiaryEvent are written into the caller's session and committed by
# get_db_session once, after the endpoint returns. There is deliberately NO
# try/except around the projection: catching it would let the activity
# survive a failed projection, which is exactly the orphan the requirement
# forbids. If the projection raises, nothing is committed and the person
# gets an error instead of a record they cannot see.
#
# NO BACKGROUND WORK, no outbox, no eventual consistency: the feed reads the
# same table the projection wrote, so the next GET already has it.
#
# SESSION RULES: write session, caller commits (P-01).
# =============================================================================

from datetime import datetime

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import record_audit
from app.modules.diary.models import ExternalActivity
from app.modules.diary.projections import add_external_activity_event
from app.modules.users.models import User

logger = structlog.get_logger()


async def create_external_activity(
    user: User,
    session: AsyncSession,
    *,
    occurred_at: datetime,
    activity_type: str,
    mood: int,
    custom_activity_name: str | None = None,
    thoughts: str | None = None,
) -> ExternalActivity:
    """Record an out-of-app activity and project it into the diary.

    Every field arrives already validated and normalized by
    CreateExternalActivityRequest: occurred_at is tz-aware, in UTC and not
    in the future; blank thoughts are None; the custom name is present
    exactly when the type is custom. This function re-checks none of it --
    a second copy of the rule here would be the copy that drifts.

    Args:
        user: The authenticated owner of the activity.
        session: Write session (caller commits).
        occurred_at: When the activity happened, UTC, not the entry time.
        activity_type: One of ExternalActivityType.
        mood: 1..10 score.
        custom_activity_name: Free-text label, custom type only.
        thoughts: Optional free text, already normalized.

    Returns:
        The created ExternalActivity, flushed so its id is populated.
    """
    activity = ExternalActivity(
        user_id=user.id,
        occurred_at=occurred_at,
        activity_type=activity_type,
        custom_activity_name=custom_activity_name,
        mood=mood,
        thoughts=thoughts,
    )
    session.add(activity)
    await session.flush()

    await add_external_activity_event(session, activity=activity)

    # STRUCTURAL FIELDS ONLY. The person's own text -- thoughts, and the
    # name they invented for a custom activity -- is deliberately absent
    # from the audit row and from the log line below: an audit trail is
    # read by operators, and a private diary entry copied into it is a
    # second, unguarded home for the thing the diary exists to keep.
    await record_audit(
        event="external_activity_created",
        actor_id=user.id,
        actor_type="user",
        target_type="external_activity",
        target_id=activity.id,
        data={
            "activity_type": activity_type,
            "occurred_at": occurred_at.isoformat(),
        },
        session=session,
    )

    logger.info(
        "external_activity_created",
        activity_id=str(activity.id),
        user_id=str(user.id),
        activity_type=activity_type,
    )
    return activity
