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
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

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

    THE ORDERING KEY IS occurred_at, AND EVERYTHING ELSE HERE IS A
    TIE-BREAK. The distinction is the whole lesson of three deliveries:
    a sort key has to be the thing that orders the rows by MEANING, and
    whatever is added after it only keeps equal rows from swapping places.
    The result of a tie-break is not a promise to anybody.

    NEITHER TIE-BREAK IS BY id. A UUID is random, so ordering by it is
    stable inside one run and arbitrary between them -- shipped in BE-30,
    repaired in GT-35, and not repeated here.

      - inner: two spellings of one name sharing occurred_at -- one of
        them is shown;
      - outer: two different names sharing their freshest occurred_at --
        both keep their places from call to call.

    WHICH one wins either tie is DELIBERATELY NOT PINNED, and no test
    asserts it. Both comparisons are between strings, and string order in
    postgres comes from the database's collation: "ЙОГА" sorts before
    "Йога" under C.UTF-8 and after it under a linguistic collation --
    measured on one machine, both ways. Nobody ever decided which spelling
    of a person's own name should win, so there is nothing to defend; what
    the tie-breaks buy is that the answer does not move between runs on a
    given server, and that is what they are for. Forcing byte order
    (COLLATE "C") was tried and rolled back: it changes a visible list to
    make an invisible property portable, and it puts every capital letter
    ahead of every small one.

    THE CASE FOLDING, unlike the tie-breaks, DOES depend on the database's
    locale and must. lower() takes its case-mapping rules from there, and
    pinning a collation onto its argument stops it folding Cyrillic at all
    -- lower('ЙОГА' COLLATE "C") returns 'ЙОГА'. The locale is not set in
    docker-compose.yml, so this rests on the postgres image's default;
    test_three_spellings_are_one_name_in_its_freshest_form is the detector
    and will fail loudly rather than quietly if that default ever changes.

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
    folded = func.lower(ExternalActivity.custom_activity_name)
    freshest = (
        select(
            ExternalActivity.custom_activity_name.label("name"),
            ExternalActivity.occurred_at.label("occurred_at"),
            folded.label("folded"),
        )
        .where(
            ExternalActivity.user_id == user.id,
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
    rows = (
        await session.execute(
            select(freshest.c.name)
            .order_by(
                freshest.c.occurred_at.desc(),
                freshest.c.folded.asc(),
            )
            .limit(settings.external_activity_name_suggestions)
        )
    ).scalars().all()
    return list(rows)
