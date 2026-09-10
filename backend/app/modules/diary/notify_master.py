# =============================================================================
# VELO Backend -- Master-facing diary notifications (BE-33, items 5 and 6)
# =============================================================================
#
# Two emits, both from the participant's own write path: a check-in or a
# review lands on a practice, and the master who runs it is told about it.
#
# ONE MESSAGE PER RECORD, NOT A DIGEST (owner ruling). A check-in carries a
# comment -- "болит спина" -- and it is worth reading BEFORE the session; a
# digest afterwards keeps the count and loses the only reason anyone opens
# these at all.
#
# THE SCORE LEAVES AS AN EMOJI, NEVER AS THE STORED 1..10.
#
# This is NOT the GT-28 ceiling, and citing it that way is how the rule gets
# "fixed" later: a master already reads the raw mood of his own practice --
# bookings/router.py hands him AttendanceCheckinResponse.mood as an int. The
# reason is the SURFACE. An attendance roster is a screen inside the app,
# opened by somebody who already has the context and closed with it. A
# notification travels to Telegram, lands in a chat history, is searchable
# and screenshottable, and outlives the practice, the booking and the app
# session. A participant's exact score has no business living there.
#
# An emoji rather than the bucket token ("fire" / "good" / "confused"): the
# profile carries a Russian and an English sheet and velo emits ONE payload,
# so a word would be wrong in one of them. Emoji are what these sheets
# already speak.
#
# WHY THIS SITS IN diary/ AND NOT core/events/ NEXT TO notify.py: nothing
# under core/ imports app.modules -- checked across the whole package, not
# assumed -- and these two helpers need Checkin, Feedback, Practice, User
# and the bucket helpers. Putting them in core would make this file the
# first breach of that direction, for no gain: diary already owns both
# records and already imports practices and users.
#
# SESSION RULES: both helpers ride the caller's transaction (transactional
# outbox) -- the notification exists exactly when the check-in does. No
# commit here (P-01).
# =============================================================================

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.events.notify import emit_notification
from app.modules.diary.insights_service import mood_bucket, rating_bucket
from app.modules.diary.models import Checkin, Feedback
from app.modules.practices.models import Practice
from app.modules.users.helpers import display_name
from app.modules.users.models import User

logger = structlog.get_logger()

CHECKIN_RECEIVED_TYPE = "practice.checkin_received"
FEEDBACK_RECEIVED_TYPE = "practice.feedback_received"

# Bucket -> emoji. The mood buckets are low/mid/high and the rating buckets
# confused/good/fire (diary/insights_service.py); the same three ranges under
# two vocabularies, so one map with both spellings keeps the ranges written
# down once here too.
_BUCKET_EMOJI = {
    "low": "😕",
    "mid": "🙂",
    "high": "🔥",
    "confused": "😕",
    "good": "🙂",
    "fire": "🔥",
}


def _emoji(bucket: str) -> str:
    """Emoji for a mood/rating bucket, falling back to a neutral face.

    The fallback is not defensive decoration: mood_bucket and rating_bucket
    are total over 1..10 and a miss would mean somebody widened the buckets
    without touching this map -- better a plain face in one message than a
    KeyError inside the participant's own write transaction, which would
    roll back their check-in over a rendering detail.
    """
    return _BUCKET_EMOJI.get(bucket, "🙂")


async def notify_master_of_checkin(
    session: AsyncSession,
    *,
    checkin: Checkin,
    practice: Practice,
    author: User,
) -> bool:
    """Tell the practice's master that a participant checked in.

    Returns False without emitting when the author IS the master -- a master
    who books and checks into his own session would otherwise be told about
    himself. Everything else about that case is legitimate (the check-in is
    real, the diary entry is his), so this is a guard on the message, not on
    the record.
    """
    if practice.master_id == author.id:
        return False

    name = display_name(author.first_name, author.last_name)
    comment = checkin.comment or ""
    await emit_notification(
        session,
        type=CHECKIN_RECEIVED_TYPE,
        target_type="user",
        target_value=str(practice.master_id),
        title="Новый чек-ин",
        body=(
            f"{name} отметился перед практикой «{practice.title}»."
            + (f" {comment}" if comment else "")
        ),
        action_data={
            "action": "open_practice",
            "params": {"practice_id": str(practice.id)},
            "practice_title": practice.title,
            "participant_name": name,
            "mood": _emoji(mood_bucket(checkin.mood)),
            "comment": comment,
        },
    )
    logger.info(
        "master_notified_checkin",
        practice_id=str(practice.id),
        master_id=str(practice.master_id),
    )
    return True


async def notify_master_of_feedback(
    session: AsyncSession,
    *,
    feedback: Feedback,
    practice: Practice,
    author: User,
) -> bool:
    """Tell the practice's master that a participant left a review.

    Same self-notification guard and the same emoji rule as the check-in
    above; see this module's header for why the rating is not a number.
    """
    if practice.master_id == author.id:
        return False

    name = display_name(author.first_name, author.last_name)
    comment = feedback.comment or ""
    await emit_notification(
        session,
        type=FEEDBACK_RECEIVED_TYPE,
        target_type="user",
        target_value=str(practice.master_id),
        title="Новый отзыв",
        body=(
            f"{name} оставил отзыв о практике «{practice.title}»."
            + (f" {comment}" if comment else "")
        ),
        action_data={
            "action": "open_practice",
            "params": {"practice_id": str(practice.id)},
            "practice_title": practice.title,
            "participant_name": name,
            "rating": _emoji(rating_bucket(feedback.rating)),
            "comment": comment,
        },
    )
    logger.info(
        "master_notified_feedback",
        practice_id=str(practice.id),
        master_id=str(practice.master_id),
    )
    return True


__all__ = [
    "CHECKIN_RECEIVED_TYPE",
    "FEEDBACK_RECEIVED_TYPE",
    "notify_master_of_checkin",
    "notify_master_of_feedback",
]
