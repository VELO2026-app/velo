# =============================================================================
# VELO Backend -- Comms sync emit helpers (Phase 6 / T0, items 4-5)
# =============================================================================
#
# Thin helpers over emit_event for the two sync-projection events of
# the comms protocol (3.0.0):
#
#   user_upserted  -- full identity SNAPSHOT (contract discipline: ALL
#                     keys present, "no value" is an explicit null), with
#                     its VERSION;
#   group_changed  -- contact-book membership delta.
#
# THE SNAPSHOT VERSION is users.snapshot_version, raised by a database
# trigger whenever a snapshot field changes (migration cm21a1b2c3d4 says
# why a trigger). comms applies a snapshot only when its version is higher
# than the stored one; an equal version with the same content is a replay,
# with other content a conflict. So emit_user_upserted never trusts the ORM
# object: it flushes, then re-reads the version AND the snapshot's fields
# from the row in one SELECT -- the pair always comes from one state of the
# row, and callers never pass (or know) the version.
#
# GROUP SEMANTICS (locked in the T0 plan review):
#   masters = MASTER CAPABILITY (a verified MasterProfile), NOT the
#             bare `role` column -- role is a switchable UI mode and
#             would flap membership on every self-switch;
#   admins  = role == admin OR the switched-away-admin round-trip
#             marker (credentials.role_switch.home_role == "admin") --
#             the same capability-vs-mode reading; an admin who
#             switched into user mode stays addressable.
#   `all` is NOT synced: comms derives it (resolver._resolve_all).
#
# Call sites pass capability BEFORE/AFTER around their status/role
# write and this module emits ONLY on the delta -- so a no-op write
# (re-verify of an already-verified master) emits nothing.
#
# ORDERING BELT: when a membership is ADDED, an identity snapshot is
# emitted first in the same transaction. The contract requires
# user_upserted to precede group_changed for a new user; the snapshot
# is idempotent, so the belt costs one harmless event and removes the
# ordering hazard entirely (e.g. a CLI role change on a seeded user
# that was never backfilled).
#
# The `user` parameter is duck-typed (id / telegram_id / credentials /
# language / timezone / is_active / snapshot_version) -- core does not import
# app.modules.users to stay cycle-free; every caller passes the ORM
# User.
# =============================================================================

from typing import Any, Protocol
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.events.service import (
    EVENT_GROUP_CHANGED,
    EVENT_USER_UPSERTED,
    emit_event,
)


class SyncedUser(Protocol):
    """The identity fields the sync snapshot reads off the User ORM row."""

    id: UUID
    telegram_id: int | None
    credentials: dict[str, Any] | None
    language: str
    timezone: str
    is_active: bool
    snapshot_version: int


def _present(value: Any) -> str | None:
    """A string field of the snapshot, or None where comms wants null.

    comms refuses a blank string on the wire (its check is `not
    value.strip()`), so empty and whitespace-only map to an explicit null
    here -- the one exit every snapshot passes. A non-string is not an
    address either.
    """
    if isinstance(value, str) and value.strip():
        return value
    return None


def user_snapshot(user: SyncedUser) -> dict[str, Any]:
    """Build the user_upserted data document (without "v").

    Snapshot discipline of comms 3.0.0: every key present, "no value"
    is an explicit null -- never a blank string. Field sources:
      recipient_id <- User.id (product user id IS the comms
                      recipient id -- no surrogate, arch decision);
      version      <- User.snapshot_version (database-maintained);
      telegram_id  <- User.telegram_id;
      email        <- credentials["email"] (JSONB; velo has no email
                      column) -- empty string means "cleared" in the
                      velo profile-edit convention and maps to null;
      locale       <- User.language;
      timezone     <- User.timezone (IANA name);
      active       <- User.is_active.
    email, locale and timezone pass _present: blank -> null.

    Pure: it reads what the object holds. Only emit_user_upserted
    guarantees the object holds the row's current state.
    """
    return {
        "recipient_id": str(user.id),
        "version": user.snapshot_version,
        "telegram_id": user.telegram_id,
        "email": _present((user.credentials or {}).get("email")),
        "locale": _present(user.language),
        "timezone": _present(user.timezone),
        "active": user.is_active,
    }


async def emit_user_upserted(session: AsyncSession, user: SyncedUser) -> None:
    """Emit an identity snapshot for the user into the outbox.

    Flushes this session's pending changes -- the trigger raises the
    version only when the UPDATE reaches the row -- and re-reads the row
    by id IN THIS SESSION, version and snapshot fields in one SELECT,
    before building the document.

    By id, not by refreshing `user`: callers do not all hand in an object
    of this session. POST /masters/apply loads the user through the READ
    session (get_current_user) and emits through the write session; the
    object is not persistent here, so it cannot be refreshed, and its
    attributes are not the row this transaction sees. populate_existing
    makes an instance this session already holds (the usual case) take
    the row's current values too.
    """
    await session.flush()
    model = type(user)
    row = (
        await session.execute(
            select(model)
            .where(model.id == user.id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    await emit_event(session, EVENT_USER_UPSERTED, user_snapshot(row))


async def emit_group_changed(
    session: AsyncSession,
    *,
    group_key: str,
    recipient_id: UUID,
    member: bool,
) -> None:
    """Emit one contact-book membership change into the outbox."""
    await emit_event(
        session,
        EVENT_GROUP_CHANGED,
        {
            "group_key": group_key,
            "recipient_id": str(recipient_id),
            "member": member,
        },
    )


async def sync_membership_delta(
    session: AsyncSession,
    user: SyncedUser,
    *,
    group_key: str,
    had: bool,
    has: bool,
) -> None:
    """Emit group_changed iff the capability actually changed.

    On ADD, an identity snapshot is emitted first (ordering belt, see
    module header). On no delta -- silence: re-verifying a verified
    master or re-running an authoritative CLI role set emits nothing.
    """
    if had == has:
        return
    if has:
        await emit_user_upserted(session, user)
    await emit_group_changed(
        session,
        group_key=group_key,
        recipient_id=user.id,
        member=has,
    )
