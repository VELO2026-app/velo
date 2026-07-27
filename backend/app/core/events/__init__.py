# =============================================================================
# VELO Backend -- core/events: transactional outbox to comms (Phase 6 / T0)
# =============================================================================
#
# The product side of the velo<->comms transport (integration design
# ID-2): OutboxEvent model + emit_event (same-transaction insert) +
# sync helpers (identity/group projection) + the background relay.
# The wire contract is FROZEN in comms app/transport/events.py; the
# mirrored constants live in service.py.
# =============================================================================

from app.core.events.models import OutboxEvent
from app.core.events.service import (
    EVENT_GROUP_CHANGED,
    EVENT_NOTIFICATION_REQUEST,
    EVENT_USER_UPSERTED,
    GROUP_ADMINS,
    GROUP_MASTERS,
    emit_event,
)
from app.core.events.sync import (
    emit_group_changed,
    emit_user_upserted,
    sync_membership_delta,
    user_snapshot,
)

__all__ = [
    "EVENT_GROUP_CHANGED",
    "EVENT_NOTIFICATION_REQUEST",
    "EVENT_USER_UPSERTED",
    "GROUP_ADMINS",
    "GROUP_MASTERS",
    "OutboxEvent",
    "emit_event",
    "emit_group_changed",
    "emit_user_upserted",
    "sync_membership_delta",
    "user_snapshot",
]
