# =============================================================================
# VELO Backend -- Notification emitters' seam (Phase 6 / T1, item 1)
# =============================================================================
#
# ONE way to say "notify" from domain code: emit_notification() builds
# a notification_request document per the comms protocol 3.0.0 and
# hands it to the transactional outbox (emit_event, ID-2) -- the
# notification exists exactly when the domain change commits.
#
# WHAT DOMAIN CODE OWNS (integration design):
#   - the TYPE: a dot-notation key of the profile dictionary §2 --
#     which types exist is profile knowledge (ID-3), velo only names
#     them at the emit site;
#   - the AUDIENCE, per the C-boundary ID-4: domain relations (who is
#     booked, who queues on the waitlist) are expanded by VELO into N
#     user-targeted emits; communication audiences (group:admins,
#     group:all, group:masters, all) go as ONE emit that comms
#     resolves over its contact book;
#   - the STORED FALLBACK title/body: the inbox bell shows the parent
#     notification's stored text, and templates only override at
#     CHANNEL delivery -- so emit sites pass short, PRE-RENDERED,
#     human-readable Russian strings (the product's primary locale),
#     never "{placeholder}" skeletons;
#   - action_data: the deep-link intent {action, params} plus SCALAR
#     template variables; dates as pre-formatted strings (arch §2.3 --
#     datetime does not survive the wire).
#
# idempotency_key: the identity of the DOMAIN FACT, passed by the emit
# site (required) -- e.g. "booking-confirmed:<booking_id>". comms holds
# one job per key FOREVER (unique index, whatever the job's outcome): the
# same key with the same bytes is the same job, the same key with other
# bytes is refused as a conflict. So a key names one fact, and a fact
# that can legitimately happen again (a practice moved twice) carries the
# identity of the act in its key -- see core/events/reminders.py. A fan-out
# (one fact, N recipients) puts the recipient in the key.
#
# CHANNELS and PRIORITY are not ours to send (comms protocol 3.0.0): the
# profile routes each type to its channels (comms-profile/types.yaml),
# and the request's field set is closed -- a request that still carried
# either would be refused at intake.
#
# correlation: the product's own opaque reference, stored untouched by
# comms; reminder_cancel matches it by EQUALITY. comms never reads the
# letter (title/body/action_data) to find a job.
# =============================================================================

from datetime import datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.events.models import OutboxEvent
from app.core.events.service import (
    EVENT_NOTIFICATION_REQUEST,
    EVENT_REMINDER_CANCEL,
    emit_event,
)

# comms bounds both opaque strings of the envelope to 1..200 characters.
# Checked HERE so a bad key names its emit site, instead of surfacing as
# an intake rejection after the outbox and the relay.
ENVELOPE_STRING_MAX = 200

# Communication-audience target values (comms resolves over its synced
# contact book; group keys mirror core/events/service.py sync keys).
TARGET_ALL = ("all", "*")
TARGET_GROUP_ADMINS = ("group", "admins")
TARGET_GROUP_MASTERS = ("group", "masters")


def _envelope_string(name: str, value: str) -> str:
    """Refuse an envelope string comms would refuse (1..200 characters)."""
    if not isinstance(value, str) or not 1 <= len(value) <= ENVELOPE_STRING_MAX:
        raise ValueError(
            f"{name} must be a string of 1..{ENVELOPE_STRING_MAX} "
            f"characters, got {value!r}"
        )
    return value


async def emit_notification(
    session: AsyncSession,
    *,
    idempotency_key: str,
    type: str,
    target_type: str,
    target_value: str,
    title: str,
    body: str,
    action_data: dict[str, Any] | None = None,
    scheduled_at: datetime | None = None,
    expiry_at: datetime | None = None,
    correlation: str | None = None,
) -> OutboxEvent:
    """Queue one notification_request in the caller's transaction.

    Args:
        session: The caller's read-write session (commit is the
            caller's; the event lives or dies with the domain change).
        idempotency_key: The identity of the domain fact (1..200
            chars). Repeating the fact must repeat the key; two facts
            must never share one (see the module header).
        type: Profile dictionary type key (e.g. "booking.confirmed");
            the profile routes it to its channels.
        target_type: "user" | "group" | "all".
        target_value: Bare target: user uuid string, group key, "*".
        title: Stored fallback title (pre-rendered, shown in the
            inbox bell; channel templates override at delivery).
        body: Stored fallback body (same rules).
        action_data: Deep-link intent + scalar template variables;
            datetimes must already be formatted strings.
        scheduled_at: "Not before" -- this is how a REMINDER is
            expressed ("a reminder is just a Notification with a
            FUTURE scheduled_at").
        expiry_at: TTL; for reminders defaults to the anchor at the
            call site.
        correlation: The product's reference for reminder_cancel
            (1..200 chars), matched by equality. None = the job is never
            cancelled; the field is then absent from the envelope.

    Returns:
        The pending OutboxEvent row.
    """
    data: dict[str, Any] = {
        "idempotency_key": _envelope_string(
            "idempotency_key", idempotency_key,
        ),
        "type": type,
        "target_type": target_type,
        "target_value": target_value,
        "title": title,
        "body": body,
    }
    if action_data is not None:
        data["action_data"] = action_data
    if scheduled_at is not None:
        data["scheduled_at"] = scheduled_at.isoformat()
    if expiry_at is not None:
        data["expiry_at"] = expiry_at.isoformat()
    if correlation is not None:
        data["correlation"] = _envelope_string("correlation", correlation)
    return await emit_event(session, EVENT_NOTIFICATION_REQUEST, data)


async def emit_reminder_cancel(
    session: AsyncSession,
    *,
    types: list[str],
    correlation: str,
    target_type: str | None = None,
    target_value: str | None = None,
) -> OutboxEvent:
    """Queue a reminder_cancel in the caller's transaction.

    Cancels the jobs of these types that were sent with EXACTLY this
    envelope correlation (an equality test on an opaque string; comms
    never reads the letter). One job has one correlation, so a job is
    cancelled along one axis only -- a reminder the product may need to
    cancel for two reasons is cancelled by the caller once per job,
    along its own correlation. Naturally idempotent on the comms side
    (a no-match set is a zero-row update). Target fields go together or
    not at all (wire rule).
    """
    if not types:
        raise ValueError("reminder_cancel needs at least one type")
    if (target_type is None) != (target_value is None):
        raise ValueError(
            "reminder_cancel target fields go together or not at all"
        )
    data: dict[str, Any] = {
        "types": list(types),
        "correlation": _envelope_string("correlation", correlation),
    }
    if target_type is not None:
        data["target_type"] = target_type
        data["target_value"] = target_value
    return await emit_event(session, EVENT_REMINDER_CANCEL, data)
