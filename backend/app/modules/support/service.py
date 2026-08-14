# =============================================================================
# VELO Backend -- support thread service (B34)
# =============================================================================
#
# TWO responsibilities, deliberately in one file because the second exists
# only to serve the first:
#
#   1. LAZY SECTION RESOLUTION (support-sections-integration.md #3, binding).
#      The comms section id for the key "support" is fetched via
#      POST /api/v1/sections every time it is needed and cached ONLY in
#      process memory. It must never survive a teardown -- not in .env, not
#      in a table, not in a migration, not in a frontend constant -- because
#      the section lives in the comms database and a reinstall hands out a
#      DIFFERENT id. A module-level variable is the whole mechanism; there is
#      deliberately no lock, because the endpoint this call sits behind is
#      CREATE-OR-FIND on comms' side (a repeat POST with the same key returns
#      the SAME row, not an error, not a second row) -- a race between two
#      concurrent first callers is comms' problem to arbitrate, not ours to
#      prevent.
#
#   2. THREAD CREATION + THE ADMIN SIGNAL. One eternal support thread per
#      user (kind="dm", operator_kind="section", no subject_ref) -- see the
#      module docstring on SupportThread for why kind="dm" was chosen over
#      "ticket". The admin-group notification fires INLINE, in the SAME
#      transaction as the local pointer write, and ONLY when comms reports
#      `created=True` for THIS call (comms' own docstring: the flag is True
#      exactly once per thread, for the caller that inserted it) -- so a user
#      re-opening their existing support thread never re-notifies admins.
#      Pattern mirrored from masters/service.py::_emit_application_received,
#      which sits inline beside its own session.add() for the same reason:
#      the event must live or die with the domain change it announces.
# =============================================================================

from typing import Any
from uuid import UUID

import structlog
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.comms import comms_request
from app.core.exceptions import NotFoundError
from app.modules.support.models import SupportThread
from app.modules.users.models import User

logger = structlog.get_logger()

# In-process cache ONLY (binding rule, see module header). Reset on every
# process restart -- the next call simply re-resolves it.
_support_section_id: UUID | None = None

_SUPPORT_SECTION_KEY = "support"
# Human label on comms' side (shown to whoever administers comms sections).
# Chosen English per fleet LANGUAGE canon (tracked-file scan target is
# literal zero Cyrillic) -- not shown anywhere in the velo product UI.
_SUPPORT_SECTION_LABEL = "Support"


async def get_support_section_id() -> UUID:
    """Resolve the comms section id for "support", lazily, every call.

    CREATE-OR-FIND on comms' side: a repeat call with the same key returns
    the SAME id (label is not updated on repeat -- not our concern here,
    comms' own contract). Cached in process memory ONLY.
    """
    global _support_section_id
    if _support_section_id is not None:
        return _support_section_id

    payload = await comms_request(
        "POST",
        "/api/v1/sections",
        json={"key": _SUPPORT_SECTION_KEY, "label": _SUPPORT_SECTION_LABEL},
    )
    _support_section_id = UUID(str(payload["id"]))
    return _support_section_id


async def open_support_thread(
    session: AsyncSession, *, user: User, topic: str | None = None,
) -> dict:
    """Open (or return) the caller's one eternal support thread.

    Returns the comms thread payload verbatim except for the `created`
    seam detail (mirrors chats/router.py::_open_response -- `created` is
    for this function to act on, not the caller's business).

    `topic` (PROMPT №712, owner ruling B): the form's topic-picker value,
    OPTIONAL and purely for the admin-group notification's text -- it has
    no effect on dedup, is not sent to comms at all, and does nothing on a
    reopen (the notification only fires when `created` is True below). The
    topic's OTHER, more durable surface is the first message itself --
    send_support_message prefixes it there, which is what an admin still
    sees after the creation notification has scrolled away.
    """
    section_id = await get_support_section_id()

    payload = await comms_request(
        "POST",
        "/api/v1/threads",
        json={
            "client": str(user.id),
            "operator_kind": "section",
            "operator_value": str(section_id),
            "kind": "dm",
        },
    )
    comms_thread_id = UUID(str(payload["id"]))
    created = bool(payload.get("created"))

    # Local pointer, keyed by the user (one row per user; see
    # uq_support_threads_client). Mirrors _create_or_get_thread's
    # find-by-pair / re-point-on-id-change / concurrent-insert-race
    # handling in chats/router.py, narrowed to one participant instead of
    # a pair.
    pointer = (
        await session.execute(
            select(SupportThread).where(
                SupportThread.client_user_id == user.id
            )
        )
    ).scalar_one_or_none()

    if pointer is None:
        try:
            async with session.begin_nested():
                session.add(
                    SupportThread(
                        comms_thread_id=comms_thread_id,
                        client_user_id=user.id,
                    )
                )
                await session.flush()
        except IntegrityError:
            pointer = (
                await session.execute(
                    select(SupportThread).where(
                        SupportThread.client_user_id == user.id
                    )
                )
            ).scalar_one_or_none()
            if pointer is None:
                raise
            logger.info(
                "support_thread_insert_race_lost",
                user_id=str(user.id),
                thread_id=str(comms_thread_id),
            )
    elif pointer.comms_thread_id != comms_thread_id:
        logger.warning(
            "support_thread_repointed",
            user_id=str(user.id),
            old_thread_id=str(pointer.comms_thread_id),
            new_thread_id=str(comms_thread_id),
        )
        pointer.comms_thread_id = comms_thread_id
        await session.flush()

    # THE ADMIN SIGNAL. Gated on comms' own `created` flag, not on our
    # local insert: `created` is True exactly once per thread's life
    # (comms' contract), which is precisely "emit once per thread
    # creation, not per message" -- a plain re-open of an existing thread
    # never re-notifies.
    if created:
        await _emit_support_thread_created(session, user, topic=topic)

    return {k: v for k, v in payload.items() if k != "created"}


async def send_support_message(
    session: AsyncSession, *, user: User, topic: str | None, body: str,
) -> dict[str, Any]:
    """Deliver one message into the caller's OWN support thread.

    The thread must already exist (the form calls open_support_thread
    first, on every submit -- cheap, idempotent, matches the chats
    module's own open-then-send split). No thread_id is accepted from the
    wire: the caller's thread is resolved from the local pointer, exactly
    like every other actor field in this codebase.

    `topic` (PROMPT №712): prefixed onto the message text so it survives
    into what an admin actually reads when they open the thread -- the
    durable half of "the topic must survive into something an operator
    can see" (the notification-text half lives in
    _emit_support_thread_created, above).
    """
    pointer = (
        await session.execute(
            select(SupportThread).where(
                SupportThread.client_user_id == user.id
            )
        )
    ).scalar_one_or_none()
    if pointer is None:
        raise NotFoundError("Open a support thread before sending a message")

    text = f"[{topic}] {body}" if topic else body
    return await comms_request(
        "POST",
        f"/api/v1/threads/{pointer.comms_thread_id}/messages",
        json={"sender": str(user.id), "body": text},
    )


async def _emit_support_thread_created(
    session: AsyncSession, user: User, *, topic: str | None = None,
) -> None:
    """Comms (T-38 support build): support.thread_created to group:admins.

    A COMMUNICATION audience (C-boundary ID-4), so it goes as ONE emit and
    comms expands it over its synced admins group -- the same mechanism
    that already carries master.application_received to that group in
    production today. Category-less by design (comms-profile/types.yaml):
    an unclaimed section thread has no assignee and comms notifies nobody
    else, so this broadcast must not be mutable by any single admin.

    `topic`, when given, is the immediate half of "the topic survives into
    something an operator can see" (PROMPT №712) -- the notification text
    itself, before anyone has even opened the thread.
    """
    from app.core.events.notify import (
        TARGET_GROUP_ADMINS,
        emit_notification,
    )

    opener = " ".join(
        part for part in (user.first_name, user.last_name) if part
    ) or "Пользователь"
    topic_clause = f" (тема: {topic})" if topic else ""
    target_type, target_value = TARGET_GROUP_ADMINS
    await emit_notification(
        session,
        type="support.thread_created",
        target_type=target_type,
        target_value=target_value,
        title="Новое обращение в поддержку",
        body=f"{opener} написал(а) в поддержку{topic_clause} -- требуется ответ.",
        action_data={
            "action": "open_admin_support",
            "params": {"user_id": str(user.id)},
            "opener_name": opener,
            "topic": topic,
        },
    )
