# =============================================================================
# VELO Backend -- Notification emitters' seam (Phase 6 / T1, item 1)
# =============================================================================
#
# ONE way to say "notify" from domain code: emit_notification() builds
# a notification_request document per the frozen comms 3c contract and
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
# idempotency_key: minted here as a uuid4 hex -- stable inside the
# outbox row, so at-least-once relay replays collapse in comms
# (partial unique index), while every logical request stays unique.
#
# CHANNELS: ["in_app", "telegram"] for every velo type (approved plan
# fork 7, channels) -- the bell always gets the row; telegram delivers for real once
# CHANNELS_MODE=real.
# =============================================================================

from datetime import datetime
from typing import Any
from uuid import uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.events.models import OutboxEvent
from app.core.events.service import (
    EVENT_NOTIFICATION_REQUEST,
    EVENT_REMINDER_CANCEL,
    emit_event,
)

# Every velo notification rings the bell and (in real mode) telegram.
DEFAULT_CHANNELS = ["in_app", "telegram"]

# Communication-audience target values (comms resolves over its synced
# contact book; group keys mirror core/events/service.py sync keys).
TARGET_ALL = ("all", "*")
TARGET_GROUP_ADMINS = ("group", "admins")
TARGET_GROUP_MASTERS = ("group", "masters")


async def emit_notification(
    session: AsyncSession,
    *,
    type: str,
    target_type: str,
    target_value: str,
    title: str,
    body: str,
    action_data: dict[str, Any] | None = None,
    priority: int = 5,
    scheduled_at: datetime | None = None,
    expiry_at: datetime | None = None,
    channels: list[str] | None = None,
) -> OutboxEvent:
    """Queue one notification_request in the caller's transaction.

    Args:
        session: The caller's read-write session (commit is the
            caller's; the event lives or dies with the domain change).
        type: Profile dictionary type key (e.g. "booking.confirmed").
        target_type: "user" | "group" | "all".
        target_value: Bare target: user uuid string, group key, "*".
        title: Stored fallback title (pre-rendered, shown in the
            inbox bell; channel templates override at delivery).
        body: Stored fallback body (same rules).
        action_data: Deep-link intent + scalar template variables;
            datetimes must already be formatted strings.
        priority: Queue priority (comms default 5; reminders use 2).
        scheduled_at: Future send time -- this is how a REMINDER is
            expressed on the frozen contract ("a reminder is just a
            Notification with a FUTURE scheduled_at").
        expiry_at: TTL; for reminders defaults to the anchor at the
            call site.
        channels: Delivery channels; defaults to DEFAULT_CHANNELS.

    Returns:
        The pending OutboxEvent row.
    """
    data: dict[str, Any] = {
        "idempotency_key": uuid4().hex,
        "type": type,
        "target_type": target_type,
        "target_value": target_value,
        "title": title,
        "body": body,
        "channels": list(channels) if channels else list(DEFAULT_CHANNELS),
        "priority": priority,
    }
    if action_data is not None:
        data["action_data"] = action_data
    if scheduled_at is not None:
        data["scheduled_at"] = scheduled_at.isoformat()
    if expiry_at is not None:
        data["expiry_at"] = expiry_at.isoformat()
    return await emit_event(session, EVENT_NOTIFICATION_REQUEST, data)


async def emit_reminder_cancel(
    session: AsyncSession,
    *,
    types: list[str],
    correlation_key: str,
    correlation_value: str,
    target_type: str | None = None,
    target_value: str | None = None,
) -> OutboxEvent:
    """Queue a reminder_cancel in the caller's transaction.

    Expires the PENDING reminders whose action_data[correlation_key]
    matches -- naturally idempotent on the comms side (a no-match set
    is a zero-row update). Target fields go together or not at all
    (wire rule).
    """
    data: dict[str, Any] = {
        "types": list(types),
        "correlation_key": correlation_key,
        "correlation_value": correlation_value,
    }
    if (target_type is None) != (target_value is None):
        raise ValueError(
            "reminder_cancel target fields go together or not at all"
        )
    if target_type is not None:
        data["target_type"] = target_type
        data["target_value"] = target_value
    return await emit_event(session, EVENT_REMINDER_CANCEL, data)
