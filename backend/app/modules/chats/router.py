# =============================================================================
# VELO Backend -- chat proxy (Phase 6 / T2, seam ID-9 + ID-10)
# =============================================================================
#
# The user-facing half of messaging. Same stance as the notifications proxy
# (comms_proxy/router.py), for the same reason: comms authenticates the
# PRODUCT, not the end user, and TRUSTS every actor id we send it. Therefore
# every actor here -- `client`, `sender`, `participant`, `operator`,
# `is_supervisor` -- is derived from the authenticated session and NEVER read
# from client input. A request that tries to supply one is rejected, not
# silently ignored: silence would hide an attempt.
#
# READ AUTHZ, the part comms cannot do for us: its read API is
# operator-scoped, so it has no answer to "is this student in thread T". A
# forged thread id would otherwise read a stranger's conversation. Every
# thread-id route therefore resolves the local ChatThread pointer first
# (chats/models.py) and checks membership against the session.
#
# WHAT IS PROXIED (six of the nine 3b endpoints): create-or-get, list, post
# message, list messages, mark read, unread count. The operator-queue verbs
# (claim / status / retag) are section-thread machinery and wait for the
# support UI -- there is no queue in a student <-> master DM.
#
# THREAD SHAPE: one eternal DM per (student, master) pair -- kind "dm", no
# subject_ref. comms dedups on the pair, so opening the chat twice returns
# the same thread, and "a conversation started" is honestly a once-per-pair
# fact (which is what the diary records).
#
# FAILURE MODEL: inherited from core/comms.py -- comms unreachable/5xx ->
# 502, timeout -> 504, modeled 4xx forwarded. A chat outage never takes velo
# down with it.
# =============================================================================

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.comms import comms_request
from app.core.database import get_db_reader, get_db_session
from app.core.exceptions import BadRequestError, NotFoundError
from app.modules.auth.dependencies import get_current_user
from app.modules.chats.models import ChatThread
from app.modules.diary.projections import upsert_thread_started_event
from app.modules.masters.service import get_master_full_name, is_master_verified
from app.modules.users.models import User, UserRole

logger = structlog.get_logger()

router = APIRouter(prefix="/api/v1/chats", tags=["chats"])

# Actor identifiers a client must never supply: each one is stamped from the
# session. Listed explicitly so the rejection message can name the offender.
_ACTOR_PARAMS = ("client", "sender", "participant", "operator", "is_supervisor")


def _reject_actor_override(request: Request) -> None:
    """Refuse a request that tries to name its own actor.

    Mirrors the notifications proxy: comms trusts these fields, so accepting
    one from the wire would be a full authz bypass -- `is_supervisor=true`
    alone widens the read to every thread on the installation.
    """
    for name in _ACTOR_PARAMS:
        if name in request.query_params:
            raise BadRequestError(
                f"{name} is derived from the session and cannot be supplied",
            )


class ChatCreate(BaseModel):
    """Open (or reopen) the conversation with one master."""

    model_config = ConfigDict(extra="forbid")

    master_id: UUID = Field(description="User id of the master to write to")


class MessageCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    body: str = Field(min_length=1, max_length=4000)


async def _load_thread(
    session: AsyncSession, thread_id: UUID
) -> ChatThread:
    stmt = select(ChatThread).where(ChatThread.comms_thread_id == thread_id)
    result = await session.execute(stmt)
    thread = result.scalar_one_or_none()
    if thread is None:
        # Deliberately 404 and not 403: an id we have no pointer for is
        # indistinguishable from one that does not exist, and saying which
        # would confirm the existence of somebody else's conversation.
        raise NotFoundError("Chat not found")
    return thread


def _is_participant(thread: ChatThread, user: User) -> bool:
    return user.id in (thread.client_user_id, thread.operator_user_id)


def _peer_payload(user: User | None) -> dict[str, Any] | None:
    """The counterparty as a chat row displays it: id + name + avatar (P-1).

    Telegram first/last name -- the same convention as
    masters.service.get_master_full_name, so a master carries one name
    everywhere (diary feed, practice cards, chat list alike);
    MasterProfile.display_name is deliberately not consulted here for the
    same reason it isn't there. `name` may be null (the columns are
    nullable even though Telegram guarantees a first_name) -- the frontend
    owns the role-appropriate fallback wording.
    """
    if user is None:
        return None
    parts = [p for p in (user.first_name, user.last_name) if p]
    return {
        "user_id": str(user.id),
        "name": " ".join(parts) if parts else None,
        "avatar_url": user.avatar_url,
    }


async def _attach_peers_from_comms(payload: Any, session: AsyncSession) -> None:
    """Stamp a `peer` display block onto every thread comms listed (P-1).

    The comms list names the counterparty only as a bare `client` uuid:
    display identity is deliberately NOT comms' knowledge (ID-4 -- domain
    facts live in the product), and the chat is a pre-sale channel, so the
    client may well not be anybody's student -- there is no other endpoint
    a master could resolve the name through. The referenced users are
    velo's own rows (identity sync T0), so ONE bulk SELECT resolves the
    whole page and nothing goes back to comms.

    Defensive on purpose: an id that does not parse or does not resolve
    gets `peer: null` instead of an exception -- a cosmetic block must
    never take the list down with it.
    """
    if not isinstance(payload, dict):
        return
    threads = payload.get("threads")
    if not isinstance(threads, list):
        return

    def _client_uuid(thread: Any) -> UUID | None:
        if not isinstance(thread, dict):
            return None
        try:
            return UUID(str(thread.get("client")))
        except (TypeError, ValueError):
            return None

    ids = {cid for t in threads if (cid := _client_uuid(t)) is not None}
    users: dict[UUID, User] = {}
    if ids:
        result = await session.execute(select(User).where(User.id.in_(ids)))
        users = {u.id: u for u in result.scalars()}
    for thread in threads:
        if isinstance(thread, dict):
            thread["peer"] = _peer_payload(users.get(_client_uuid(thread)))


async def _require_participant(
    session: AsyncSession, thread_id: UUID, user: User
) -> ChatThread:
    thread = await _load_thread(session, thread_id)
    if not _is_participant(thread, user):
        raise NotFoundError("Chat not found")
    return thread


@router.post("")
async def open_chat(
    body: ChatCreate,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> Any:
    """Open the conversation with a master, or return the existing one.

    Create-or-get: comms dedups on the (client, operator) pair, so this is
    the idempotent entry point the UI calls every time the chat is opened --
    which is precisely what makes the diary self-healing possible (see
    upsert_thread_started_event).
    """
    _reject_actor_override(request)

    if body.master_id == user.id:
        raise BadRequestError("Cannot open a chat with yourself")

    # The target must be a VERIFIED master: the chat is a pre-sale channel
    # into the master zone, not a general user-to-user messenger. Reuses the
    # same predicate the public master profile uses, so an unverified
    # application stays invisible here too (404, not 403 -- confirming that
    # a pending application exists would leak it).
    if not await is_master_verified(body.master_id, session):
        raise NotFoundError("Master not found")
    master = await session.get(User, body.master_id)
    if master is None:
        raise NotFoundError("Master not found")

    payload = await comms_request(
        "POST",
        "/api/v1/threads",
        json={
            "client": str(user.id),
            "operator_kind": "user",
            "operator_value": str(body.master_id),
            "kind": "dm",
        },
    )

    comms_thread_id = UUID(str(payload["id"]))

    # Local pointer, keyed by the PAIR rather than by the thread id, because
    # the thread id is not stable for the lifetime of a pair: comms can be
    # rebuilt underneath us (the test contour's projection resync truncates
    # recipients CASCADE, which takes threads with it), and the next
    # create-or-get then answers with a brand-new id for the same two people.
    # Keyed by thread id, that case would try to INSERT a second row for the
    # pair, hit uq_chat_threads_pair, and 500 -- permanently, since every
    # retry repeats it. So: find by pair, re-point when the id moved.
    pointer = (
        await session.execute(
            select(ChatThread).where(
                ChatThread.client_user_id == user.id,
                ChatThread.operator_user_id == body.master_id,
            )
        )
    ).scalar_one_or_none()

    repointed = False
    if pointer is None:
        # Concurrent first-open (a double tap on "Write" is enough): both
        # requests find no pointer, both insert, and the loser hits
        # uq_chat_threads_pair. Caught rather than prevented with a lock:
        # comms has already deduped the THREAD itself, so the winner's row
        # is the right one and the loser only needs to find it. A SAVEPOINT
        # keeps the failed INSERT from poisoning the surrounding
        # transaction -- the diary write still has to happen after this.
        try:
            async with session.begin_nested():
                session.add(
                    ChatThread(
                        comms_thread_id=comms_thread_id,
                        client_user_id=user.id,
                        operator_user_id=body.master_id,
                    )
                )
                await session.flush()
        except IntegrityError:
            pointer = (
                await session.execute(
                    select(ChatThread).where(
                        ChatThread.client_user_id == user.id,
                        ChatThread.operator_user_id == body.master_id,
                    )
                )
            ).scalar_one_or_none()
            if pointer is None:
                # The constraint fired but no row is visible: not our race,
                # and nothing here knows how to recover from it.
                raise
            logger.info(
                "chat_thread_insert_race_lost",
                client_user_id=str(user.id),
                operator_user_id=str(body.master_id),
                thread_id=str(comms_thread_id),
            )
    elif pointer.comms_thread_id != comms_thread_id:
        # An anomaly, not a normal path: comms lost the thread it had told
        # us about. Loud on purpose -- outside the test contour this means
        # the two sides genuinely diverged and somebody should know.
        logger.warning(
            "chat_thread_repointed",
            client_user_id=str(user.id),
            operator_user_id=str(body.master_id),
            old_thread_id=str(pointer.comms_thread_id),
            new_thread_id=str(comms_thread_id),
        )
        pointer.comms_thread_id = comms_thread_id
        repointed = True
        await session.flush()

    # The diary entry belongs to the student's own timeline (ID-5: the diary
    # is velo's, and it is the student's personal space -- the master gets
    # nothing). occurred_at comes from the thread, not from now().
    #
    # NOT written on a re-point: the conversation with this master already
    # has its "started" card. comms handed out a new thread id, but nothing
    # started again in the student's life, and a second card would say
    # otherwise.
    if not repointed:
        await upsert_thread_started_event(
            session,
            user_id=user.id,
            thread_id=comms_thread_id,
            occurred_at=_parsed_created_at(payload),
            master_id=body.master_id,
            master_name=await get_master_full_name(body.master_id, session),
        )

    # `created` is a seam detail (it exists so this handler can act on it);
    # the frontend gets the thread, plus the counterparty's display block
    # (P-1): who you are talking to is velo's knowledge, not comms' (ID-4),
    # and stamping it here saves the UI a second request per screen.
    return {
        **{k: v for k, v in payload.items() if k != "created"},
        "peer": _peer_payload(master),
    }


def _parsed_created_at(payload: dict[str, Any]) -> datetime:
    """The thread's own creation instant, as comms reported it.

    Never now(): a diary row written late (a heal after a lost response)
    must land where the conversation actually started.
    """
    raw = payload.get("created_at")
    if not raw:
        # Cannot happen against the frozen 3b shape; keeping the chat working
        # beats refusing it over a timeline that is a few seconds off.
        return datetime.now(UTC)
    return datetime.fromisoformat(str(raw))


@router.get("")
async def list_chats(
    request: Request,
    limit: int = Query(default=20, ge=1, le=100),
    cursor: str | None = Query(default=None),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_reader),
) -> Any:
    """The caller's conversations.

    Two different lists, because comms only knows one of them: a master (or
    an admin) is an OPERATOR there and gets the authoritative, activity-
    ordered, paginated list straight from comms. A student is a CLIENT --
    invisible to that API -- so their list is built from local pointers.
    """
    _reject_actor_override(request)

    if user.role in (UserRole.MASTER, UserRole.ADMIN):
        params: dict[str, Any] = {
            "operator": str(user.id),
            # Read-widening flag, stamped from the role and never from the
            # wire: an admin oversees every thread, a master sees their own.
            "is_supervisor": user.role == UserRole.ADMIN,
            "limit": limit,
        }
        if cursor is not None:
            params["cursor"] = cursor
        payload = await comms_request("GET", "/api/v1/threads", params=params)
        await _attach_peers_from_comms(payload, session)
        return payload

    rows = (
        await session.execute(
            select(ChatThread)
            .where(ChatThread.client_user_id == user.id)
            .order_by(ChatThread.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()

    # P-1: the masters' display blocks, one bulk SELECT for the page --
    # without this the frontend would need a public-profile request per row.
    master_ids = {row.operator_user_id for row in rows}
    masters: dict[UUID, User] = {}
    if master_ids:
        result = await session.execute(
            select(User).where(User.id.in_(master_ids))
        )
        masters = {u.id: u for u in result.scalars()}

    return {
        "threads": [
            {
                "id": str(row.comms_thread_id),
                "operator_value": str(row.operator_user_id),
                "created_at": row.created_at.isoformat(),
                "peer": _peer_payload(masters.get(row.operator_user_id)),
            }
            for row in rows
        ],
        "next_cursor": None,
    }


@router.post("/{thread_id}/messages")
async def post_message(
    thread_id: UUID,
    body: MessageCreate,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_reader),
) -> Any:
    """Send a message. `sender` is the session's user, always."""
    _reject_actor_override(request)
    await _require_participant(session, thread_id, user)
    return await comms_request(
        "POST",
        f"/api/v1/threads/{thread_id}/messages",
        json={"sender": str(user.id), "body": body.body},
    )


@router.get("/{thread_id}/messages")
async def list_messages(
    thread_id: UUID,
    request: Request,
    limit: int = Query(default=20, ge=1, le=100),
    cursor: str | None = Query(default=None),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_reader),
) -> Any:
    _reject_actor_override(request)
    await _require_participant(session, thread_id, user)
    params: dict[str, Any] = {"limit": limit}
    if cursor is not None:
        params["cursor"] = cursor
    return await comms_request(
        "GET", f"/api/v1/threads/{thread_id}/messages", params=params,
    )


@router.post("/{thread_id}/read")
async def mark_read(
    thread_id: UUID,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_reader),
) -> Any:
    """Mark the thread read up to now for the CALLER (never for the peer)."""
    _reject_actor_override(request)
    await _require_participant(session, thread_id, user)
    return await comms_request(
        "POST",
        f"/api/v1/threads/{thread_id}/read",
        json={"participant": str(user.id)},
    )


@router.get("/{thread_id}/unread-count")
async def unread_count(
    thread_id: UUID,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_reader),
) -> Any:
    _reject_actor_override(request)
    await _require_participant(session, thread_id, user)
    return await comms_request(
        "GET",
        f"/api/v1/threads/{thread_id}/unread-count",
        params={"participant": str(user.id)},
    )
