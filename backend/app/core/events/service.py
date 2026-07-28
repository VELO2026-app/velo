# =============================================================================
# VELO Backend -- Transactional Outbox: emit_event (Phase 6 / T0)
# =============================================================================
#
# The single producer-side entry point of integration design ID-2:
#
#     await emit_event(session, EVENT_USER_UPSERTED, {...})
#
# inserts an OutboxEvent row into the CALLER'S session -- same
# transaction as the domain change; the caller's commit/rollback is
# the event's commit/rollback. No commit and no flush-forcing here
# (P-01); a flush is issued only to keep insertion order deterministic
# within one session (BIGSERIAL ids are assigned at flush time, and
# the relay publishes in id order).
#
# CONTRACT MIRROR (comms app/transport/events.py, FROZEN Phase 3c):
#   - envelope {event, data} is assembled by the relay; this module
#     stores `data` and stamps the required version field "v": 1;
#   - event names: notification_request / user_upserted /
#     group_changed (KNOWN_EVENT_TYPES below);
#   - sync events (user_upserted / group_changed) carry NO
#     idempotency_key -- they are naturally idempotent by upsert
#     semantics; only notification_request has one (T1 concern; the
#     contract suggests the outbox row id);
#   - all data values must be JSON scalars / JSON trees -- checked
#     here so a producer bug dies in a velo test, not in the comms
#     DLQ.
# The constants are a MIRROR, not an import: velo must not import
# comms code across the service boundary. Divergence found -> ASK,
# do not silently fix either side (T0 handoff rule).
# =============================================================================

from typing import Any

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.events.models import OutboxEvent

logger = structlog.get_logger()

# -- Contract mirror (comms transport/events.py, frozen 3c) -------------------

SCHEMA_VERSION = 1

EVENT_NOTIFICATION_REQUEST = "notification_request"
EVENT_USER_UPSERTED = "user_upserted"
EVENT_GROUP_CHANGED = "group_changed"
# Additive T1 extension of the frozen 3c contract (Master-chat
# approved 2026-07-28; ships in the comms delivery raked out FIRST --
# provider before product, arch decision 8): expires PENDING reminders
# by correlation, mirroring comms engine/reminders.cancel_reminders.
EVENT_REMINDER_CANCEL = "reminder_cancel"

KNOWN_EVENT_TYPES = frozenset(
    {
        EVENT_NOTIFICATION_REQUEST,
        EVENT_USER_UPSERTED,
        EVENT_GROUP_CHANGED,
        EVENT_REMINDER_CANCEL,
    }
)

# Communication groups of integration design §4 (contact book keys,
# opaque to comms). `all` is NOT here on purpose: comms resolves
# target_type=all as "every active recipient" (engine/resolver.py,
# _resolve_all) -- derived, no membership sync.
GROUP_MASTERS = "masters"
GROUP_ADMINS = "admins"

_SCALAR_TYPES = (str, int, float, bool, type(None))


def _validate_json_tree(value: Any, path: str) -> None:
    """Reject values that cannot travel the wire as JSON.

    Mirrors the comms consumer's scalar discipline early: a UUID or a
    datetime object serialized by accident would either crash
    json.dumps in the relay or dead-letter in comms -- both worse and
    later than a ValueError in the emitting test.
    """
    if isinstance(value, _SCALAR_TYPES):
        return
    if isinstance(value, list):
        for i, item in enumerate(value):
            _validate_json_tree(item, f"{path}[{i}]")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str) or not key:
                raise ValueError(
                    f"outbox event data: key at {path} must be a "
                    f"non-empty string, got {key!r}"
                )
            _validate_json_tree(item, f"{path}.{key}")
        return
    raise ValueError(
        f"outbox event data: {path} is {type(value).__name__}, "
        f"expected a JSON scalar/list/object (stringify UUIDs and "
        f"datetimes at the emit site)"
    )


async def emit_event(
    session: AsyncSession,
    event_type: str,
    data: dict[str, Any],
) -> OutboxEvent:
    """Insert one outgoing event into the caller's transaction.

    Args:
        session: The caller's read-write session; the event commits
            and rolls back WITH the caller's domain change (ID-2).
        event_type: One of KNOWN_EVENT_TYPES (envelope event name).
        data: The event data document per the frozen comms contract,
            WITHOUT "v" -- the version is stamped here. JSON-scalar
            values only (str/int/float/bool/None, lists, objects).

    Returns:
        The pending OutboxEvent row (id assigned -- flushed).
    """
    if event_type not in KNOWN_EVENT_TYPES:
        raise ValueError(
            f"unknown outbox event type {event_type!r}; known: "
            f"{sorted(KNOWN_EVENT_TYPES)}"
        )
    if "v" in data:
        raise ValueError(
            "outbox event data must not carry 'v' -- the schema "
            "version is stamped by emit_event"
        )
    _validate_json_tree(data, path="data")

    event = OutboxEvent(
        event_type=event_type,
        payload={"v": SCHEMA_VERSION, **data},
    )
    session.add(event)
    # Assign the BIGSERIAL id now so events emitted later in the same
    # session are guaranteed a higher id (publication order mirrors
    # emission order within a transaction).
    await session.flush()

    logger.info(
        "outbox_event_emitted",
        event_id=event.id,
        event_type=event_type,
    )
    return event
