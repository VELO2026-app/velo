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
from uuid import UUID

import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import Select

from app.core.audit import record_audit
from app.core.config import settings
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


async def list_custom_activity_names(
    user: User,
    session: AsyncSession,
) -> list[str]:
    """The person's own custom activity names, freshest first (BE-37).

    Somebody who typed "Бальные танцы" a week ago should not have to type
    it again. Only their own names, by construction: the filter is on
    user_id and there is no parameter that could widen it.

    THE FILTER IS `custom_activity_name IS NOT NULL`, NOT
    `activity_type == 'custom'`. Today the two are equivalent -- the DB
    constraint ck_external_activity_custom makes the name present exactly
    when the type is custom -- but they are not the same promise. What we
    are afraid of here is a null in a list of names, and the null check is
    what forbids it; if that constraint were ever relaxed, the type filter
    would let nulls through and this one still would not. Both together
    would be worse than either: the next reader would assume each catches
    something and leave both untouched.

    CASE-INSENSITIVE, SPELLING OF THE FRESHEST. "Йога" and "йога" are one
    activity typed twice by one person, and showing both would spend two
    of eight slots on one thing. Inner spacing is NOT normalised: "Йога
    нидра" and "Йога  нидра" stay two names, because guessing at what a
    person meant inside a name is a different decision from folding case.

    TWO TIE-BREAKS, AND NEITHER IS BY id. The id is a UUID: ordering by it
    is stable within one run and random between them, which is exactly the
    defect this line shipped in BE-30 and repaired in GT-35.
      - inner: two spellings of one name sharing occurred_at -- the
        alphabetically first spelling wins;
      - outer: two different names sharing their freshest occurred_at --
        ordered by the folded name, so the eight that survive the limit
        are always the same eight.

    QUERY SHAPE, and where it stops being cheap: DISTINCT ON folds the
    names, so the database must sort by lower(name), which
    ix_external_activities_user_occurred does not provide -- that index
    covers the WHERE and not the ORDER BY. The sort therefore runs over
    one person's rows and nobody else's, which is tens today. The cost
    grows with ONE PERSON'S history, not with the number of people; past
    a few hundred custom entries for a single person the fix is an
    expression index on (user_id, lower(custom_activity_name)). Not built
    now: an index for a load that does not exist is machinery under a
    state nothing can reach.

    Args:
        user: The authenticated owner; the only scope there is.
        session: Read session.

    Returns:
        Up to settings.external_activity_name_suggestions names, newest
        use first. Empty when the person has never used a custom type.
    """
    rows = (
        await session.execute(custom_activity_names_statement(user.id))
    ).scalars().all()
    return list(rows)


def custom_activity_names_statement(user_id: UUID) -> Select:
    """The statement behind list_custom_activity_names, built separately.

    SPLIT OUT SO THE ORDERING CAN BE ASSERTED AT ALL. The outer tie-break
    is unobservable from the endpoint: the inner DISTINCT ON already
    leaves the subquery sorted by the folded name, and postgres happens to
    preserve that through the outer sort -- so removing the tie-break
    changes no answer today and every behavioural test keeps passing.
    Measured, not assumed: dropping it left the whole file green.

    It stays anyway, because "happens to preserve" is not a promise -- a
    sort is not documented as stable, and a plan change would reorder ties
    silently. A claim about the query is asserted against the query.
    """
    folded = func.lower(ExternalActivity.custom_activity_name)
    freshest = (
        select(
            ExternalActivity.custom_activity_name.label("name"),
            ExternalActivity.occurred_at.label("occurred_at"),
            folded.label("folded"),
        )
        .where(
            ExternalActivity.user_id == user_id,
            ExternalActivity.custom_activity_name.is_not(None),
        )
        .distinct(folded)
        .order_by(
            folded,
            ExternalActivity.occurred_at.desc(),
            ExternalActivity.custom_activity_name.asc(),
        )
        .subquery()
    )
    return (
        select(freshest.c.name)
        .order_by(
            freshest.c.occurred_at.desc(),
            freshest.c.folded.asc(),
        )
        .limit(settings.external_activity_name_suggestions)
    )
