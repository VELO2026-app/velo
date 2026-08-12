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
# (claim / status / retag) are section-thread machinery and this proxy has
# no section threads -- there is no queue in a student <-> master DM.
#
# THREAD SHAPE: one eternal DM per (client, operator) pair -- kind "dm", no
# subject_ref. comms dedups on the pair, so opening the chat twice returns
# the same thread, and "a conversation started" is honestly a once-per-pair
# fact (which is what the diary records). The pair is DIRECTED, and the
# direction is a product rule, not a record of who tapped first: the student
# is always `client`, the master always `operator`. Which is exactly why
# POST /chats (student-initiated) and POST /chats/students
# (master-initiated) reach the SAME thread for the same two people --
# neither one keys the pair off the caller.
#
# TWO WAYS TO OPEN ONE, one machine underneath (_create_or_get_thread):
#   POST /chats           -- student -> verified master (the pre-sale channel)
#   POST /chats/students  -- verified master -> student (the reverse, T3)
# MEMBERSHIP has no exceptions: you are one of the two ids on the local
# pointer row, or the thread does not exist as far as you are concerned.
# No role widens it -- a thread neither of whose ids is the caller 404s for
# everyone, admins included.
#
# FAILURE MODEL: inherited from core/comms.py -- comms unreachable/5xx ->
# 502, timeout -> 504, modeled 4xx forwarded. A chat outage never takes velo
# down with it.
# =============================================================================

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.comms import comms_request
from app.core.database import get_db_reader, get_db_session
from app.core.exceptions import (
    BadRequestError,
    ForbiddenError,
    NotFoundError,
)
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


class StudentChatCreate(BaseModel):
    """Open (or reopen) the conversation with one student, master-side.

    A SIBLING of ChatCreate rather than an optional field on it: ChatCreate
    is extra="forbid" and heavily tested, and the two directions differ in
    more than the id (who may call, what the target must be). Widening the
    existing body would have put both rule sets behind one schema.
    """

    model_config = ConfigDict(extra="forbid")

    student_id: UUID = Field(description="User id of the student to write to")


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


def _counterparty_id(thread: ChatThread, viewer_id: UUID) -> UUID:
    """Whoever the viewer is NOT, in this thread.

    A viewer who is the client sees the operator (a student looking at
    their master); the operator sees the client.
    """
    if thread.client_user_id == viewer_id:
        return thread.operator_user_id
    return thread.client_user_id


async def _local_thread_list(
    session: AsyncSession,
    rows: Sequence[ChatThread],
    *,
    viewer_id: UUID,
) -> dict[str, Any]:
    """A thread list built from local pointers, peers resolved in one SELECT.

    Used by the two callers comms' operator-scoped list cannot serve: a
    student (a CLIENT there, invisible to that API) and an admin (who is
    not an operator scope either -- their list is their own threads, on
    whichever side of the pair). P-1: without the bulk peer SELECT the
    frontend would need one public-profile request per row.
    """
    peer_ids = {_counterparty_id(row, viewer_id) for row in rows}
    peers: dict[UUID, User] = {}
    if peer_ids:
        result = await session.execute(
            select(User).where(User.id.in_(peer_ids))
        )
        peers = {u.id: u for u in result.scalars()}

    return {
        "threads": [
            {
                "id": str(row.comms_thread_id),
                "operator_value": str(row.operator_user_id),
                "created_at": row.created_at.isoformat(),
                "peer": _peer_payload(
                    peers.get(_counterparty_id(row, viewer_id))
                ),
            }
            for row in rows
        ],
        "next_cursor": None,
    }


async def _require_participant(
    session: AsyncSession, thread_id: UUID, user: User
) -> ChatThread:
    thread = await _load_thread(session, thread_id)
    if not _is_participant(thread, user):
        raise NotFoundError("Chat not found")
    return thread


async def _create_or_get_thread(
    session: AsyncSession,
    *,
    client_id: UUID,
    operator_id: UUID,
) -> tuple[dict[str, Any], UUID, bool]:
    """The create-or-get machine shared by both open endpoints.

    Lifted verbatim out of open_chat when the master-initiated route
    arrived: the comms call, the PAIR-keyed pointer lookup, the
    re-point-on-id-change branch and the concurrent-first-open SAVEPOINT
    are the parts that must not drift between them. The pair is passed in
    (client, operator) rather than (caller, target) precisely so that
    calling it from the master side lands on the SAME row and the SAME
    comms thread as the student side.

    Returns (comms payload, thread id, repointed) -- `repointed` is what
    tells a caller not to write a diary card for a thread that only
    changed its id.
    """
    payload = await comms_request(
        "POST",
        "/api/v1/threads",
        json={
            "client": str(client_id),
            "operator_kind": "user",
            "operator_value": str(operator_id),
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
                ChatThread.client_user_id == client_id,
                ChatThread.operator_user_id == operator_id,
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
                        client_user_id=client_id,
                        operator_user_id=operator_id,
                    )
                )
                await session.flush()
        except IntegrityError:
            pointer = (
                await session.execute(
                    select(ChatThread).where(
                        ChatThread.client_user_id == client_id,
                        ChatThread.operator_user_id == operator_id,
                    )
                )
            ).scalar_one_or_none()
            if pointer is None:
                # The constraint fired but no row is visible: not our race,
                # and nothing here knows how to recover from it.
                raise
            logger.info(
                "chat_thread_insert_race_lost",
                client_user_id=str(client_id),
                operator_user_id=str(operator_id),
                thread_id=str(comms_thread_id),
            )
    elif pointer.comms_thread_id != comms_thread_id:
        # An anomaly, not a normal path: comms lost the thread it had told
        # us about. Loud on purpose -- outside the test contour this means
        # the two sides genuinely diverged and somebody should know.
        logger.warning(
            "chat_thread_repointed",
            client_user_id=str(client_id),
            operator_user_id=str(operator_id),
            old_thread_id=str(pointer.comms_thread_id),
            new_thread_id=str(comms_thread_id),
        )
        pointer.comms_thread_id = comms_thread_id
        repointed = True
        await session.flush()

    return payload, comms_thread_id, repointed


def _open_response(payload: dict[str, Any], peer: User | None) -> dict[str, Any]:
    """The open-a-chat response: the comms thread, minus the seam detail.

    `created` exists so the handler can act on it and is not the
    frontend's business; `peer` is added because who you are talking to is
    velo's knowledge, not comms' (ID-4), and stamping it here saves the UI
    a second request per screen.
    """
    return {
        **{k: v for k, v in payload.items() if k != "created"},
        "peer": _peer_payload(peer),
    }


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

    payload, comms_thread_id, repointed = await _create_or_get_thread(
        session, client_id=user.id, operator_id=body.master_id,
    )

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

    return _open_response(payload, master)


@router.post("/students")
async def open_student_chat(
    body: StudentChatCreate,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> Any:
    """Open the conversation with a student, master-side, or return it.

    THE SAME THREAD as the student-initiated direction, not a mirror of
    it: the pair handed to _create_or_get_thread is (student=client,
    master=operator) regardless of who pressed the button, so this hits
    uq_chat_threads_pair's existing row and comms' own (client, operator)
    dedup when the student had already written first. Reversing the roles
    for the master's convenience would have manufactured a second
    conversation between the same two people.

    OPEN BY DESIGN, no relationship required: the student-initiated
    direction is deliberately a pre-sale channel (see open_chat), and
    nothing in the model says the reverse must be narrower. Whether a
    master should be able to cold-message a user who is not their student
    is a PRODUCT question, flagged rather than decided here.
    """
    _reject_actor_override(request)

    # Role first: this endpoint exists for the master zone. 403 and not
    # 404 -- nothing about the caller's own role is a secret from the
    # caller.
    if user.role != UserRole.MASTER:
        raise ForbiddenError("Only a master can open a chat with a student")

    if body.student_id == user.id:
        raise BadRequestError("Cannot open a chat with yourself")

    # The same VERIFIED predicate the other direction applies to the
    # target, applied here to the CALLER: an unverified application must
    # not gain a cold-message channel into the user base. Normally implied
    # by role=master (verification precedes the self-switch), checked
    # anyway because "normally" is not an authz argument.
    if not await is_master_verified(user.id, session):
        raise ForbiddenError("Only a verified master can open this chat")

    # A real, existing velo user -- and not only as a product rule: comms
    # knows recipients identity sync shipped it, so an id with no user
    # behind it would 404 at the create call with an opaque message.
    student = await session.get(User, body.student_id)
    if student is None:
        raise NotFoundError("User not found")

    payload, comms_thread_id, repointed = await _create_or_get_thread(
        session, client_id=body.student_id, operator_id=user.id,
    )

    # Same card, same owner as the other direction: the fact recorded is
    # "a conversation with master X began" and it belongs to the STUDENT's
    # timeline (ID-5), whoever opened it. Idempotent across the two
    # directions -- the projection keys on the thread id, and the partial
    # unique index uq_diary_events_thread_started makes that a database
    # fact rather than a convention.
    if not repointed:
        await upsert_thread_started_event(
            session,
            user_id=body.student_id,
            thread_id=comms_thread_id,
            occurred_at=_parsed_created_at(payload),
            master_id=user.id,
            master_name=await get_master_full_name(user.id, session),
        )

    return _open_response(payload, student)


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

    THREE lists, because comms knows only one of them:

      MASTER  -- an OPERATOR in comms, so the authoritative, activity-
        ordered, paginated list comes straight from comms. is_supervisor
        is hard False: a master sees their own threads and never anyone
        else's.

      ADMIN   -- their own threads and nothing else (either side of the
        pair), i.e. EXACTLY the set _require_participant will let them
        open. Local, because an admin is not an operator scope and comms
        cannot express it.
        This used to be `is_supervisor=True`, which handed an admin every
        conversation on the installation -- each row enriched with the
        counterparty's real name and avatar, and each row 404ing the
        moment it was opened. A privacy exposure attached to a dead end;
        the widening is gone rather than narrowed.

      everyone else -- a CLIENT, invisible to the operator-scoped comms
        API, so their list is built from local pointers.

    COST OF THE ADMIN CHANGE, stated plainly: the admin list loses comms'
    activity ordering and its cursor (created_at desc, next_cursor null --
    the same deal the student list has always had). Ordering a page by
    "who wrote last" needs comms, and comms cannot be asked this question.
    """
    _reject_actor_override(request)

    if user.role == UserRole.MASTER:
        params: dict[str, Any] = {
            "operator": str(user.id),
            # Stamped from the role and never from the wire. Constant now
            # that the admin branch no longer routes through here: nothing
            # this proxy sends comms ever widens the read.
            "is_supervisor": False,
            "limit": limit,
        }
        if cursor is not None:
            params["cursor"] = cursor
        payload = await comms_request("GET", "/api/v1/threads", params=params)
        await _attach_peers_from_comms(payload, session)
        return payload

    if user.role == UserRole.ADMIN:
        # Mirrors _is_participant exactly -- listed and openable must be
        # the same set, or the list is either a tease or a leak. Both
        # columns are indexed (ix_chat_threads_client_user_id /
        # ix_chat_threads_operator_user_id, migration t2a1b2c3d4e5).
        visible = or_(
            ChatThread.client_user_id == user.id,
            ChatThread.operator_user_id == user.id,
        )
        admin_rows = (
            await session.execute(
                select(ChatThread)
                .where(visible)
                .order_by(ChatThread.created_at.desc())
                .limit(limit)
            )
        ).scalars().all()
        return await _local_thread_list(
            session, admin_rows, viewer_id=user.id,
        )

    rows = (
        await session.execute(
            select(ChatThread)
            .where(ChatThread.client_user_id == user.id)
            .order_by(ChatThread.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    return await _local_thread_list(session, rows, viewer_id=user.id)


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
