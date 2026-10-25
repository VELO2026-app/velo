# =============================================================================
# VELO Backend -- support service (B34, BE-162)
# =============================================================================
#
# WHAT SUPPORT IS, SINCE BE-162 (owner rulings, the card's table):
#
#   EVERY APPEAL THROUGH THE FORM IS A TICKET -- a new one even when an
#   earlier ticket is open: its own comms thread of kind `ticket` (comms
#   creates a fresh thread on every call; a client key replays the same
#   one), a topic and a category as codes (models.TOPICS), our status. The
#   message goes in as written -- no topic in its text.
#
#   FOR THE PERSON IT IS ONE CONVERSATION: their support threads -- the
#   pre-BE-162 `dm` history and every ticket -- are glued into one feed by
#   time (client_support_messages), read and counted together. A message
#   written in the conversation goes to their latest OPEN ticket, else to
#   their latest ticket, else opens a ticket "other" (send_dialog_message).
#
#   STATUSES ARE OURS, comms KNOWS TWO: an admin moves an OPEN ticket to
#   resolved / rejected / duplicate / spam, and the thread to comms'
#   `resolved`; nothing moves a thread to `closed` (comms would tell the
#   person). A person's message reopens -- comms its thread, we the ticket
#   -- except SPAM, which stays spam, translates nothing and signals nobody.
#
#   THE ADMIN SIGNAL (BE-172, routed here): support.message_received on
#   every message a person sends -- to every admin while the ticket is not
#   taken, to the admin who took it once it is.
#
# Three mechanisms beside it, unchanged: LAZY SECTION RESOLUTION
# (get_support_section_id -- the comms section id for "support" lives in
# process memory only, support-sections-integration.md section 3), the
# translation queue (support/translation.py, BE-166), and the pointer
# tables (support/models.py).
# =============================================================================

import base64
import binascii
import json
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import structlog
from sqlalchemy import case, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.comms import comms_request, message_key, read_comms_page
from app.core.config import settings
from app.core.events import SECTION_SUPPORT_KEY, SECTION_SUPPORT_LABEL
from app.core.exceptions import BadRequestError, ConflictError, NotFoundError
from app.core.i18n import normalize_language
from app.modules.support import translation
from app.modules.support.models import (
    CATEGORIES,
    STATUS_OPEN,
    STATUS_RESOLVED,
    STATUS_SPAM,
    TO_SUPPORT,
    TO_USER,
    TOPIC_OTHER,
    TOPICS,
    SupportThread,
    SupportTicket,
)
from app.modules.users.models import User

logger = structlog.get_logger()

# In-process cache ONLY (binding rule, see module header). Reset on every
# process restart -- the next call simply re-resolves it.
_support_section_id: UUID | None = None

# The rating filter's word for "nobody rated it" (list_admin_tickets).
RATING_NONE = "none"

# A person with more support threads than this is the trigger of the
# glued feed's KNOWN CEILING (client_support_messages).
FEED_THREADS_CEILING = 20


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
        json={"key": SECTION_SUPPORT_KEY, "label": SECTION_SUPPORT_LABEL},
    )
    _support_section_id = UUID(str(payload["id"]))
    return _support_section_id


# ---------------------------------------------------------------------------
# A person's support threads
# ---------------------------------------------------------------------------


async def own_support_threads(
    session: AsyncSession, *, user: User,
) -> list[SupportThread]:
    """Every support thread of this person -- history and tickets -- oldest
    first."""
    return list(
        (
            await session.execute(
                select(SupportThread)
                .where(SupportThread.client_user_id == user.id)
                .order_by(SupportThread.created_at, SupportThread.id)
            )
        ).scalars()
    )


async def own_support_thread(
    session: AsyncSession, *, user: User, thread_id: UUID,
) -> SupportThread | None:
    """One of the caller's OWN support threads, if `thread_id` names one --
    or None.

    The one door through which a person's chat routes reach their support
    conversation (BE-163, chats/router.py): strict equality with a pointer
    of the CALLER, so another person's support thread id answers None
    exactly like an id nobody has. Any of the caller's threads opens the
    whole conversation (BE-162): what a route does with it is decided by
    the conversation, not by the thread the id names.
    """
    return (
        await session.execute(
            select(SupportThread).where(
                SupportThread.client_user_id == user.id,
                SupportThread.comms_thread_id == thread_id,
            )
        )
    ).scalar_one_or_none()


# ---------------------------------------------------------------------------
# Tickets: the form, the conversation
# ---------------------------------------------------------------------------


async def _ticket_now(
    session: AsyncSession, pointer: SupportThread, ticket: SupportTicket,
) -> dict[str, Any]:
    """The ticket as it stands after this transaction's own writes."""
    await session.refresh(ticket)
    return ticket_out(pointer, ticket)


def ticket_out(pointer: SupportThread, ticket: SupportTicket) -> dict[str, Any]:
    """A ticket as velo describes it -- codes, never labels."""
    return {
        "id": str(pointer.comms_thread_id),
        "topic": ticket.topic,
        "category": ticket.category,
        "status": ticket.status,
        "created_at": ticket.created_at.isoformat() if ticket.created_at else None,
        "status_changed_at": ticket.status_changed_at.isoformat(),
    }


async def create_ticket(
    session: AsyncSession,
    *,
    user: User,
    topic: str,
    body: str,
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    """One appeal through the support form: a new ticket and its first
    message (owner ruling BE-162, 1-2) -- a new one even when the person
    has an open ticket.

    ONE INTENT, ONE TICKET: the client's Idempotency-Key names the appeal.
    Both comms calls are keyed by it -- the thread (`ticket:` + the message
    key) and the message -- so a repeated submit gets the same thread back
    from comms and the same message; the unique comms_thread_id turns the
    replay into "the ticket exists". Without a client key every submit is
    its own appeal (comms creates a fresh `ticket` thread per call).

    `topic` is a code of models.TOPICS (the router refuses anything else);
    the category follows from it, in that one table.
    """
    key = message_key(user.id, idempotency_key)
    section_id = await get_support_section_id()
    payload = await comms_request(
        "POST",
        "/api/v1/threads",
        json={
            "client": str(user.id),
            "operator_kind": "section",
            "operator_value": str(section_id),
            "kind": "ticket",
        },
        idempotency_key=f"ticket:{key}",
    )
    comms_thread_id = UUID(str(payload["id"]))
    pointer, ticket = await _ticket_by_thread(session, comms_thread_id)
    if pointer is None:
        try:
            async with session.begin_nested():
                pointer = SupportThread(
                    comms_thread_id=comms_thread_id, client_user_id=user.id,
                )
                session.add(pointer)
                await session.flush()
                ticket = SupportTicket(
                    support_thread_id=pointer.id,
                    topic=topic,
                    category=TOPICS[topic].category,
                    status=STATUS_OPEN,
                    status_changed_at=datetime.now(UTC),
                    version=1,
                )
                session.add(ticket)
                await session.flush()
        except IntegrityError:
            # The same appeal, replayed concurrently under the same key:
            # comms answered both with one thread, the other insert won.
            pointer, ticket = await _ticket_by_thread(session, comms_thread_id)
            if pointer is None or ticket is None:
                raise
            logger.info(
                "support_ticket_insert_race_lost", thread_id=str(comms_thread_id),
            )
    assert ticket is not None  # a thread born in create_ticket has its ticket
    message = await _post_and_route(
        session, user=user, pointer=pointer, ticket=ticket, body=body, key=key,
    )
    return {"ticket": await _ticket_now(session, pointer, ticket), "message": message}


async def _ticket_by_thread(
    session: AsyncSession, comms_thread_id: UUID,
) -> tuple[SupportThread | None, SupportTicket | None]:
    row = (
        await session.execute(
            select(SupportThread, SupportTicket)
            .outerjoin(
                SupportTicket,
                SupportTicket.support_thread_id == SupportThread.id,
            )
            .where(SupportThread.comms_thread_id == comms_thread_id)
        )
    ).first()
    if row is None:
        return None, None
    return row[0], row[1]


async def send_dialog_message(
    session: AsyncSession,
    *,
    user: User,
    body: str,
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    """A message the person writes in their support conversation, not
    through the form (owner ruling BE-162, 3): it belongs to their latest
    OPEN ticket; with none open, to their latest ticket (comms reopens its
    thread, _post_and_route the ticket); with no ticket at all -- only the
    pre-BE-162 history, or nothing -- it opens a ticket "other".

    "Latest" is by creation: the ticket the person opened last.
    """
    rows = (
        await session.execute(
            select(SupportThread, SupportTicket)
            .join(SupportTicket, SupportTicket.support_thread_id == SupportThread.id)
            .where(SupportThread.client_user_id == user.id)
            .order_by(
                (SupportTicket.status == STATUS_OPEN).desc(),
                SupportTicket.created_at.desc(),
                SupportThread.id.desc(),
            )
            .limit(1)
        )
    ).first()
    if rows is None:
        created = await create_ticket(
            session,
            user=user,
            topic=TOPIC_OTHER,
            body=body,
            idempotency_key=idempotency_key,
        )
        return created["message"]
    pointer, ticket = rows
    return await _post_and_route(
        session,
        user=user,
        pointer=pointer,
        ticket=ticket,
        body=body,
        key=message_key(user.id, idempotency_key),
    )


async def _post_and_route(
    session: AsyncSession,
    *,
    user: User,
    pointer: SupportThread,
    ticket: SupportTicket,
    body: str,
    key: str,
) -> dict[str, Any]:
    """Post the person's message into the ticket's thread, as written, and
    do what a person's message does to a ticket -- the one place it is done,
    for the form and the conversation alike:

      the ticket is not spam -> back to OPEN (owner ruling 5; comms has
        reopened the thread itself), `version` bumped -- an admin's status
        change in flight sees it and refuses (set_ticket_status); the
        message queued for translation into the support language (BE-166);
        the admin signal, routed by who took the ticket (owner ruling 6).
      the ticket is spam -> the message is in the thread and that is all:
        no status change, no translation job (no paid model call on spam;
        the admin feed's catch-up queues one if an admin opens it), no
        signal (owner ruling, BE-162 gate).

    The decision is the UPDATE's own: a ticket turned spam by an admin a
    moment ago matches nothing, so the message is treated as spam's.
    """
    message = await comms_request(
        "POST",
        f"/api/v1/threads/{pointer.comms_thread_id}/messages",
        json={"sender": str(user.id), "body": body},
        idempotency_key=key,
    )
    message_id = message.get("id") if isinstance(message, dict) else None
    if message_id is None:
        return message
    reopened = (
        await session.execute(
            update(SupportTicket)
            .where(
                SupportTicket.support_thread_id == ticket.support_thread_id,
                SupportTicket.status != STATUS_SPAM,
            )
            .values(
                status=STATUS_OPEN,
                version=SupportTicket.version + 1,
                status_changed_at=case(
                    (SupportTicket.status != STATUS_OPEN, func.now()),
                    else_=SupportTicket.status_changed_at,
                ),
            )
            .returning(SupportTicket.claimed_by_user_id)
        )
    ).first()
    if reopened is None:
        return message
    await translation.enqueue(
        session,
        pointer=pointer,
        message_id=UUID(str(message_id)),
        direction=TO_SUPPORT,
        locale=settings.support_language,
        text=body,
    )
    # KNOWN CEILING (a message without its admin signal):
    #   1. Mechanics: the message is written by the comms POST above,
    #      outside this transaction; the signal is an outbox row of this
    #      transaction. When comms accepted the POST and this transaction
    #      then fails to commit, the message is in the thread and no admin
    #      is told. The translation queued above shares the window but has
    #      a catch-up (the admin feed queues a missing translation when it
    #      is read); the signal has no reader to catch it up from.
    #   2. Status: acknowledged by design.
    #   3. Backlog ref: none -- the window is the commit itself failing
    #      after a successful POST; nothing observed has hit it.
    #   4. Promotion trigger: a person's message in comms with no outbox
    #      row keyed `support-message:<its id>` behind it.
    #   5. Agreed fix: velo mints the message's identity before the POST,
    #      sends it to comms as the message's Idempotency-Key and writes
    #      the outbox row under the same identity first -- the signal then
    #      exists whenever the message can.
    #   6. Rejected for now: that fix replaces the message key rule (the
    #      client's key is the message's identity, BE-163, core/comms.py
    #      message_key), and emitting before the POST without it has no
    #      message id to key the signal by.
    await _emit_support_message_received(
        session,
        user,
        thread_id=pointer.comms_thread_id,
        message_id=UUID(str(message_id)),
        topic=ticket.topic,
        claimed_by=reopened[0],
    )
    return message


# ---------------------------------------------------------------------------
# The person's one conversation (BE-162 over BE-163)
# ---------------------------------------------------------------------------


def _message_key_of(row: Any) -> tuple[datetime, UUID] | None:
    """A message's place in the glued feed: (created_at, id), newest first
    -- comms' own order inside a thread."""
    if not isinstance(row, dict):
        return None
    try:
        when = datetime.fromisoformat(str(row.get("created_at")))
        mid = UUID(str(row.get("id")))
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        return None
    return when, mid


def _encode_feed_cursor(
    anchors: dict[UUID, str | None], boundary: tuple[datetime, UUID],
) -> str:
    raw = json.dumps(
        {
            "t": {str(k): v for k, v in anchors.items()},
            "a": boundary[0].isoformat(),
            "i": str(boundary[1]),
        },
        separators=(",", ":"),
    )
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def _decode_feed_cursor(
    token: str,
) -> tuple[dict[UUID, str | None], tuple[datetime, UUID]]:
    try:
        doc = json.loads(base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)))
        anchors = {UUID(k): v for k, v in doc["t"].items()}
        boundary = (datetime.fromisoformat(doc["a"]), UUID(doc["i"]))
    except (binascii.Error, ValueError, KeyError, TypeError, AttributeError):
        raise BadRequestError("Malformed cursor") from None
    if boundary[0].tzinfo is None or not all(
        v is None or isinstance(v, str) for v in anchors.values()
    ):
        raise BadRequestError("Malformed cursor")
    return anchors, boundary


async def _thread_page(
    thread_id: UUID,
    *,
    anchor: str | None,
    limit: int,
    user_locale: str | None,
) -> tuple[list[Any], str | None]:
    params: dict[str, Any] = {"limit": limit}
    if user_locale is not None:
        params["locale"] = user_locale
    if anchor is not None:
        params["cursor"] = anchor
    payload = await comms_request(
        "GET", f"/api/v1/threads/{thread_id}/messages", params=params,
    )
    return read_comms_page(payload, path="/api/v1/threads/{thread_id}/messages")


async def client_support_messages(
    session: AsyncSession,
    *,
    client: User,
    limit: int,
    cursor: str | None,
) -> dict[str, Any]:
    """The person's support conversation, as they read it: all their
    support threads glued into one feed, newest first (BE-162, 5).

    Each message is rendered by translation.client_feed, thread by thread
    -- the catch-up of a reply whose translation was lost included (it
    needs its thread's pointer) -- and put in its place by (created_at, id).

    THE CURSOR IS velo's: where each thread stands (comms' own cursor, or
    null for its top) and the place of the last message given out (the
    boundary). A page reads one comms page per thread, keeps what is older
    than the boundary, takes the newest `limit` of all of them, and moves
    each thread to just after its last message taken -- a thread taken
    from only in part is re-read up to that message to get comms' cursor
    there (one more call). Messages never move, so this is exact; a thread
    born after the first page has only newer messages and is not in the
    cursor.

    # KNOWN CEILING (the glued feed reads every thread of the person;
    # acknowledged by design):
    #   1. Mechanics: one comms call per support thread per page, plus one
    #      per thread taken from in part, and a cursor that grows with the
    #      thread count -- a ticket per appeal makes the count grow with
    #      the person's history.
    #   2. Status: acknowledged by design.
    #   3. Task: none -- the trigger says when it is needed.
    #   4. Trigger: support_feed_threads_many in the app log (a person with
    #      more than FEED_THREADS_CEILING support threads opened the feed).
    #   5. Fix form: read only the threads whose activity reaches into the
    #      page -- their last_message_at, from comms' client list -- and
    #      drop the rest from the cursor.
    #   6. Rejected: gluing only the latest K threads -- it hides the
    #      person's own history from them.
    """
    threads = await own_support_threads(session, user=client)
    by_id = {t.comms_thread_id: t for t in threads}
    if len(by_id) > FEED_THREADS_CEILING:
        logger.warning("support_feed_threads_many", threads=len(by_id))
    boundary: tuple[datetime, UUID] | None = None
    if cursor is None:
        anchors: dict[UUID, str | None] = dict.fromkeys(by_id)
    else:
        anchors, boundary = _decode_feed_cursor(cursor)
        anchors = {tid: a for tid, a in anchors.items() if tid in by_id}
    user_locale = translation.reply_language(client)

    # What each thread offers below the boundary: (the anchor its page was
    # read from, that page as comms gave it, its keyed rows below the
    # boundary, comms' next cursor).
    offers: dict[
        UUID, tuple[str | None, list[Any], list[tuple[Any, dict]], str | None]
    ] = {}
    for tid, anchor in anchors.items():
        while True:
            items, next_cursor = await _thread_page(
                tid, anchor=anchor, limit=limit, user_locale=user_locale,
            )
            below = [
                (k, row)
                for row in items
                if (k := _message_key_of(row)) is not None
                and (boundary is None or k < boundary)
            ]
            if below or next_cursor is None:
                break
            anchor = next_cursor  # a whole page newer than the boundary
        offers[tid] = (anchor, items, below, next_cursor)

    candidates = sorted(
        ((k, tid, row) for tid, (_, _, below, _) in offers.items() for k, row in below),
        key=lambda c: c[0],
        reverse=True,
    )[:limit]
    taken: dict[UUID, list[dict]] = {}
    for _, tid, row in candidates:
        taken.setdefault(tid, []).append(row)

    new_anchors: dict[UUID, str | None] = {}
    for tid, (anchor, items, below, next_cursor) in offers.items():
        mine = taken.get(tid, [])
        if len(mine) == len(below):
            if next_cursor is not None:
                new_anchors[tid] = next_cursor
            continue  # read to its end
        if not mine:
            new_anchors[tid] = anchor
            continue
        # Taken in part: re-read the same page up to the last message taken
        # -- its position in what comms gave, whatever else that held --
        # and stand on comms' cursor there.
        last = next(i for i, row in enumerate(items) if row is mine[-1])
        _, reanchored = await _thread_page(
            tid, anchor=anchor, limit=last + 1, user_locale=user_locale,
        )
        new_anchors[tid] = reanchored

    rendered: dict[UUID, list[dict]] = {}
    for tid in sorted(taken, key=str):
        rendered[tid] = await translation.client_feed(
            session,
            pointer=by_id[tid],
            user_locale=user_locale,
            messages=taken[tid],
        )
    position = dict.fromkeys(rendered, 0)
    messages: list[dict] = []
    for _, tid, _ in candidates:
        messages.append(rendered[tid][position[tid]])
        position[tid] += 1

    next_page = None
    if candidates and new_anchors:
        next_page = _encode_feed_cursor(new_anchors, candidates[-1][0])
    return {"messages": messages, "next_cursor": next_page}


async def mark_support_read(*, user: User, threads: list[SupportThread]) -> dict:
    """Read up to now in every support thread of the person: one call per
    thread (comms keeps a read pointer per thread). The sum of what each
    leaves unread -- 0 unless a message arrived meanwhile."""
    unread = 0
    for thread in threads:
        answer = await comms_request(
            "POST",
            f"/api/v1/threads/{thread.comms_thread_id}/read",
            json={"participant": str(user.id)},
        )
        if isinstance(answer, dict) and isinstance(answer.get("unread"), int):
            unread += answer["unread"]
    return {"unread": unread}


async def support_unread(*, user: User, threads: list[SupportThread]) -> int:
    """What the person has not read in all their support threads -- one
    batch call."""
    if not threads:
        return 0
    answer = await comms_request(
        "POST",
        "/api/v1/threads/unread-counts",
        json={
            "participant": str(user.id),
            "thread_ids": [str(t.comms_thread_id) for t in threads],
        },
    )
    counts = answer.get("counts") if isinstance(answer, dict) else None
    if not isinstance(counts, dict):
        return 0
    return sum(n for n in counts.values() if isinstance(n, int))


def _peer_payload(user: User | None) -> dict[str, Any] | None:
    """The thread opener as a display block -- P-1, same shape and reason
    as chats/router.py::_peer_payload: a raw client uuid tells an admin
    nothing, and support has no other endpoint to resolve a name through.
    """
    if user is None:
        return None
    parts = [p for p in (user.first_name, user.last_name) if p]
    return {
        "user_id": str(user.id),
        "name": " ".join(parts) if parts else None,
        "avatar_url": user.avatar_url,
    }


async def get_admin_support_messages(
    session: AsyncSession,
    *,
    thread_id: UUID,
    limit: int,
    cursor: str | None,
) -> dict[str, Any]:
    """A support thread's feed. Read access is universal-for-admins by
    the owner's own ruling (option A: every admin SEES every thread) --
    comms' get_thread_feed has no gate of its own either (the product
    proxy is the sole owner of that check, per comms' trust model), so
    the ONLY authz this function performs is the section/DM boundary
    above; there is no per-admin claim requirement to READ.
    """
    pointer, _ = await _require_support_thread(session, thread_id)
    # BE-166: read in the support language -- and the SAME page again in
    # the user's language when it differs: only that read says what became
    # of an admin's reply for the user (translation.admin_feed). The feed
    # pages exactly alike with any locale.
    client = await session.get(User, pointer.client_user_id)
    user_locale = translation.reply_language(client) if client is not None else None

    async def _page(locale: str) -> tuple[list[Any], str | None]:
        params: dict[str, Any] = {"limit": limit, "locale": locale}
        if cursor is not None:
            params["cursor"] = cursor
        payload = await comms_request(
            "GET", f"/api/v1/threads/{thread_id}/messages", params=params,
        )
        # READ, not forwarded -- see chats/router.py list_messages: comms
        # pages as {"items", ...}, the frontend reads {"messages", ...}
        # (frontend/src/api/support.ts); an unknown shape is a 502.
        return read_comms_page(
            payload, path="/api/v1/threads/{thread_id}/messages",
        )

    messages, next_cursor = await _page(settings.support_language)
    user_items: list[Any] = []
    if user_locale is not None:
        user_items, _ = await _page(user_locale)
    return {
        "messages": await translation.admin_feed(
            session,
            pointer=pointer,
            messages=messages,
            user_locale=user_locale,
            user_items=user_items,
        ),
        "next_cursor": next_cursor,
    }


async def send_admin_support_message(
    session: AsyncSession,
    *,
    admin: User,
    thread_id: UUID,
    body: str,
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    """Reply as this admin. Unlike reading, WRITE-authz is not ours to
    grant: comms' can_post_message admits only the thread's client or its
    ASSIGNEE, no supervisor bypass (messaging/operators.py, comms
    `9474751`) -- an admin who has not claimed the thread gets comms' own
    403 back, forwarded verbatim (forward_403=True) instead of the
    default infra-fault mapping, so the caller can distinguish "you must
    claim this first" from "comms is down".

    BE-166: the reply goes into the thread at once, as written. When the
    user reads another language than support's, its translation into
    theirs is queued in this transaction -- it becomes the message's
    variant (translation.py); nothing is queued for a user who reads the
    support language.

    BE-162: a ticket only -- a person's history thread is read-only (409),
    and a reply in a ticket of any status is allowed (comms' write-authz
    does not look at the status).
    """
    pointer, _ = await _require_ticket(session, thread_id)
    message = await comms_request(
        "POST",
        f"/api/v1/threads/{thread_id}/messages",
        json={"sender": str(admin.id), "body": body},
        forward_403=True,
        idempotency_key=message_key(admin.id, idempotency_key),
    )
    client = await session.get(User, pointer.client_user_id)
    target = translation.reply_language(client) if client is not None else None
    message_id = message.get("id") if isinstance(message, dict) else None
    if target is not None and message_id is not None:
        await translation.enqueue(
            session,
            pointer=pointer,
            message_id=UUID(str(message_id)),
            direction=TO_USER,
            locale=target,
            text=body,
        )
    return message


async def retry_support_translation(
    session: AsyncSession, *, thread_id: UUID, message_id: UUID,
) -> dict[str, Any]:
    """Ask again for a message whose translation's job failed (BE-166);
    any admin -- nothing is posted as anyone. 409 when there is nothing to
    retry (in progress, translated, or declined -- final in comms)."""
    pointer, _ = await _require_support_thread(session, thread_id)
    return await translation.retry(
        session, pointer=pointer, message_id=message_id,
    )


# ---------------------------------------------------------------------------
# Admins
# ---------------------------------------------------------------------------


def _encode_list_cursor(created_at: datetime, thread_row_id: UUID) -> str:
    raw = json.dumps(
        {"a": created_at.isoformat(), "i": str(thread_row_id)},
        separators=(",", ":"),
    )
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def _decode_list_cursor(token: str) -> tuple[datetime, UUID]:
    try:
        doc = json.loads(base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)))
        when = datetime.fromisoformat(doc["a"])
        row_id = UUID(doc["i"])
    except (binascii.Error, ValueError, KeyError, TypeError):
        raise BadRequestError("Malformed cursor") from None
    if when.tzinfo is None:
        raise BadRequestError("Malformed cursor")
    return when, row_id


async def _admin_ticket_rows(
    session: AsyncSession, rows: list[Any],
) -> list[dict[str, Any]]:
    """Tickets as an admin reads them -- THE row of the list and of the one
    ticket (BE-162 fix: the card opened from a signal, without the list):
    the ticket's codes and dates, who opened it, who took it, and the
    person's history thread. `rows` are (SupportTicket, SupportThread)
    pairs; one query per kind of fact, whatever their number."""
    people = {p.client_user_id for _, p in rows} | {
        uid
        for t, _ in rows
        for uid in (
            t.claimed_by_user_id,
            t.resolved_by_user_id,
            t.rated_resolver_user_id,
        )
        if uid is not None
    }
    users: dict[UUID, User] = {}
    if people:
        users = {
            u.id: u
            for u in (
                await session.execute(select(User).where(User.id.in_(people)))
            ).scalars()
        }
    # The person's history -- their support thread without a ticket, the
    # pre-BE-162 conversation -- for the ticket card (read-only).
    history: dict[UUID, UUID] = {}
    openers = {p.client_user_id for _, p in rows}
    if openers:
        history = {
            client: thread_id
            for client, thread_id in (
                await session.execute(
                    select(SupportThread.client_user_id, SupportThread.comms_thread_id)
                    .outerjoin(
                        SupportTicket,
                        SupportTicket.support_thread_id == SupportThread.id,
                    )
                    .where(
                        SupportThread.client_user_id.in_(openers),
                        SupportTicket.support_thread_id.is_(None),
                    )
                )
            ).all()
        }
    return [
        {
            **ticket_out(pointer, ticket),
            "opener": _peer_payload(users.get(pointer.client_user_id)),
            "claimed_by": (
                _peer_payload(users.get(ticket.claimed_by_user_id))
                if ticket.claimed_by_user_id is not None
                else None
            ),
            "history_thread_id": (
                str(history[pointer.client_user_id])
                if pointer.client_user_id in history
                else None
            ),
            # BE-162 delivery 3: the last admin to resolve it, and the
            # person's rating with whom it rated.
            "resolved_by": _peer_or_none(users, ticket.resolved_by_user_id),
            "rating": _rating_out(ticket, users.get(pointer.client_user_id), users),
        }
        for ticket, pointer in rows
    ]


def _peer_or_none(users: dict[UUID, User], user_id: UUID | None) -> dict | None:
    return _peer_payload(users.get(user_id)) if user_id is not None else None


def _rating_out(
    ticket: SupportTicket, opener: User | None, users: dict[UUID, User],
) -> dict[str, Any] | None:
    """The person's rating as an admin reads it: the stars, the comment AS
    WRITTEN -- not translated (owner ruling, BE-162 delivery 3) -- and the
    language it is most likely written in (the person's interface
    language), so a screen can say so; when; and the admin it rated."""
    if ticket.rating is None:
        return None
    return {
        "stars": ticket.rating,
        "comment": ticket.rating_comment,
        "comment_locale": normalize_language(opener.language) if opener else None,
        "rated_at": ticket.rated_at.isoformat() if ticket.rated_at else None,
        "rated_resolver": _peer_or_none(users, ticket.rated_resolver_user_id),
    }


async def list_admin_tickets(
    session: AsyncSession,
    *,
    categories: set[str] | None,
    ratings: set[str] | None = None,
    status: str | None,
    created_from: datetime | None,
    created_to: datetime | None,
    limit: int,
    cursor: str | None,
) -> dict[str, Any]:
    """Tickets, newest appeal first (BE-162, 6) -- from velo's own table:
    the filters and, later, the statistics are ours.

    `categories` is "any of these" (BE-162 fix 2); none -- every category.
    `ratings` likewise (BE-162 delivery 3): stars "1".."5", and "none" for
    a ticket nobody has rated.
    Without `status` the list is every ticket but SPAM (owner ruling 8: spam
    leaves the common list); `status=spam` is the spam tab. `created_from`
    is inclusive, `created_to` exclusive.

    comms is not asked anything: the list needed comms' supervisor read
    before (every thread of the installation, private DMs included) and
    that read is gone. A row carries no last message -- comms reads one
    thread's feed per call, and the list does not pay N+1 for a preview.
    """
    stmt = (
        select(SupportTicket, SupportThread)
        .join(SupportThread, SupportThread.id == SupportTicket.support_thread_id)
        .order_by(
            SupportTicket.created_at.desc(),
            SupportTicket.support_thread_id.desc(),
        )
        .limit(limit + 1)
    )
    if status is not None:
        stmt = stmt.where(SupportTicket.status == status)
    else:
        stmt = stmt.where(SupportTicket.status != STATUS_SPAM)
    if categories:
        stmt = stmt.where(SupportTicket.category.in_(sorted(categories)))
    if ratings:
        stars = sorted(int(r) for r in ratings if r != RATING_NONE)
        any_of = [SupportTicket.rating.in_(stars)] if stars else []
        if RATING_NONE in ratings:
            any_of.append(SupportTicket.rating.is_(None))
        stmt = stmt.where(or_(*any_of))
    if created_from is not None:
        stmt = stmt.where(SupportTicket.created_at >= created_from)
    if created_to is not None:
        stmt = stmt.where(SupportTicket.created_at < created_to)
    if cursor is not None:
        when, row_id = _decode_list_cursor(cursor)
        stmt = stmt.where(
            (SupportTicket.created_at < when)
            | (
                (SupportTicket.created_at == when)
                & (SupportTicket.support_thread_id < row_id)
            )
        )
    rows = list((await session.execute(stmt)).all())
    has_more = len(rows) > limit
    rows = rows[:limit]

    tickets = await _admin_ticket_rows(session, rows)
    next_cursor = None
    if has_more:
        last_ticket = rows[-1][0]
        next_cursor = _encode_list_cursor(
            last_ticket.created_at, last_ticket.support_thread_id,
        )
    return {"tickets": tickets, "next_cursor": next_cursor}


async def get_admin_ticket(
    session: AsyncSession, *, thread_id: UUID,
) -> dict[str, Any]:
    """One ticket by its thread id, as the list shows it (BE-162 fix): the
    card an admin opens from the Telegram signal, which carries only the
    thread id. Any status, spam included -- a spam ticket's card opens.

    404 for anything that is not a ticket: a person's history thread (no
    ticket row -- it has no card), a DM, an id nobody has. One answer for
    all, as everywhere on this router: existence does not leak.
    """
    row = (
        await session.execute(
            select(SupportTicket, SupportThread)
            .join(SupportThread, SupportThread.id == SupportTicket.support_thread_id)
            .where(SupportThread.comms_thread_id == thread_id)
        )
    ).first()
    if row is None:
        raise NotFoundError("Ticket not found")
    (ticket,) = await _admin_ticket_rows(session, [row])
    return ticket


async def _require_support_thread(
    session: AsyncSession, thread_id: UUID,
) -> tuple[SupportThread, SupportTicket | None]:
    """Resolve a comms thread id to a KNOWN support thread, or 404 -- and
    its ticket, None for a person's history.

    THE section-vs-DM boundary for every admin call: support_threads is
    written ONLY by create_ticket (and held the pre-BE-162 threads), so a
    row here is proof the id names a support thread and not a
    student<->master DM. Deliberately 404, not 403 -- existence must not
    leak (chats/router.py::_require_participant's own stance).
    """
    pointer, ticket = await _ticket_by_thread(session, thread_id)
    if pointer is None:
        raise NotFoundError("Support thread not found")
    return pointer, ticket


async def _require_ticket(
    session: AsyncSession, thread_id: UUID,
) -> tuple[SupportThread, SupportTicket]:
    """A support thread that is a TICKET. A person's history (no ticket) is
    read-only (BE-162, 5): no claim, no reply, no status -- 409."""
    pointer, ticket = await _require_support_thread(session, thread_id)
    if ticket is None:
        raise ConflictError("A support history thread is read-only")
    return pointer, ticket


async def claim_admin_support_thread(
    session: AsyncSession, *, admin: User, thread_id: UUID,
) -> dict[str, Any]:
    """Take a ticket -- the act that grants the right to reply (comms'
    can_post_message admits the assignee) and, since BE-162, routes the
    person's messages to this admin alone. Returns comms' {claimed, thread}.

    comms ARBITRATES: it claims idempotently by outcome, and a ticket held
    by another admin is its 409, forwarded. The taker is written here only
    after comms said yes. If this transaction is then lost, comms has an
    assignee and the ticket has none: the person's messages go to every
    admin (the old behaviour) until the taker claims again -- comms
    answers yes again, and this writes it.
    """
    _, ticket = await _require_ticket(session, thread_id)
    answer = await comms_request(
        "POST",
        f"/api/v1/threads/{thread_id}/claim",
        json={"operator": str(admin.id)},
    )
    await session.execute(
        update(SupportTicket)
        .where(SupportTicket.support_thread_id == ticket.support_thread_id)
        .values(claimed_by_user_id=admin.id)
    )
    return answer


async def set_ticket_status(
    session: AsyncSession, *, admin: User, thread_id: UUID, status: str,
) -> dict[str, Any]:
    """Move an OPEN ticket to resolved / rejected / duplicate / spam
    (BE-162, 7), and its thread to comms' `resolved` -- never `closed`.

    THE ORDER: the ticket is read (its version), comms is told, then the
    ticket is written by compare-and-set on (OPEN, version). Nothing is
    locked across the comms call. A second admin's change, or a message of
    the person, in between bumps the version: this change is refused (409)
    and the ticket stays as they left it.

    # KNOWN CEILING (comms' thread status may disagree with the ticket's;
    # acknowledged by design):
    #   1. Mechanics: comms is told before the ticket is written. When the
    #      person's message lands between the two -- comms reopens the
    #      thread, then this call resolves it -- the compare-and-set fails
    #      and the ticket is OPEN while comms says `resolved`. And a
    #      person's message into a SPAM ticket: comms reopens the thread,
    #      the ticket stays spam (owner ruling) -- comms says `open`.
    #   2. Status: acknowledged by design.
    #   3. Task: none -- the ticket's status is the truth every velo
    #      screen and signal reads; comms' status changes nothing for the
    #      person (comms auto-close is off, THREAD_AUTO_CLOSE_DAYS=0) and
    #      does not stop anyone writing.
    #   4. Trigger: support_ticket_status_drift in the app log (a status
    #      change refused after comms was told); and the owner turning
    #      comms' auto-close back on -- a `resolved`/`open` mismatch would
    #      then close threads on comms' own schedule.
    #   5. Fix form: read comms' thread status back after a refused
    #      change and align it -- needs comms to allow `resolved -> open`
    #      by an operator (it does not: only a client message reopens),
    #      or move the ticket only after comms by a status comms returns.
    #   6. Rejected: holding the ticket row locked across the comms call
    #      -- an HTTP call inside a lock, which blocks the person's message
    #      for as long as comms takes.
    """
    pointer, ticket = await _require_ticket(session, thread_id)
    if ticket.status != STATUS_OPEN:
        raise ConflictError("Only an open ticket changes its status")
    seen = ticket.version
    await comms_request(
        "POST",
        f"/api/v1/threads/{thread_id}/status",
        json={"operator": str(admin.id), "status": "resolved"},
    )
    changed = (
        await session.execute(
            update(SupportTicket)
            .where(
                SupportTicket.support_thread_id == ticket.support_thread_id,
                SupportTicket.status == STATUS_OPEN,
                SupportTicket.version == seen,
            )
            .values(
                status=status,
                status_changed_at=func.now(),
                version=SupportTicket.version + 1,
                # BE-162 delivery 3: who resolved it -- the last to do so.
                resolved_by_user_id=(
                    admin.id
                    if status == STATUS_RESOLVED
                    else SupportTicket.resolved_by_user_id
                ),
            )
            .returning(SupportTicket.version, SupportTicket.rating)
        )
    ).first()
    if changed is None:
        logger.warning("support_ticket_status_drift", thread_id=str(thread_id))
        raise ConflictError("The ticket changed meanwhile -- read it again")
    version, rating = changed
    if status == STATUS_RESOLVED and rating is None:
        await _emit_rating_request(session, pointer=pointer, version=version)
    return await _ticket_now(session, pointer, ticket)


# The person's request to rate a resolved ticket (BE-162 delivery 3;
# comms-profile/types.yaml declares it under `reminders`).
RATING_REQUEST_TYPE = "prompt.rate_support"


async def _emit_rating_request(
    session: AsyncSession, *, pointer: SupportThread, version: int,
) -> None:
    """Ask the person to rate the ticket just RESOLVED -- at once, in the
    same transaction as the status (owner: right away, no delay of ours;
    the person's own quiet hours are kept -- comms' default `respect`, the
    request has no expiry to miss).

    One request per move to RESOLVED: the key names the ticket's version
    after that move, so a repeat of the same move is the same document and
    a later RESOLVED (after a reopen) is a new one -- sent only while the
    ticket is still unrated (owner ruling: one rating per ticket).

    The button opens the rating of THIS ticket: `open_support_rating` with
    its comms thread id -- the id the rating routes take."""
    from app.core.events.notify import emit_notification

    await emit_notification(
        session,
        idempotency_key=f"support-rating:{pointer.comms_thread_id}:{version}",
        type=RATING_REQUEST_TYPE,
        target_type="user",
        target_value=str(pointer.client_user_id),
        title="How did we do?",
        body="Your support request is resolved. Rate our help: it takes a second.",
        action_data={
            "action": "open_support_rating",
            "params": {"thread_id": str(pointer.comms_thread_id)},
        },
    )


# ---------------------------------------------------------------------------
# The person's rating (BE-162 delivery 3)
# ---------------------------------------------------------------------------


async def rate_ticket(
    session: AsyncSession,
    *,
    user: User,
    thread_id: UUID,
    stars: int,
    comment: str | None,
) -> dict[str, Any]:
    """The person rates their RESOLVED ticket: 1..5 stars and, if they
    like, a comment -- one rating per ticket (owner ruling).

    404 unless the ticket is the caller's own: another person's ticket, a
    history thread, an id nobody has -- one answer, existence does not
    leak. 409 when the ticket is not RESOLVED (a reopen beat the rating)
    or is rated already.

    ONE WRITE DECIDES, under the row's lock: RESOLVED and still unrated.
    A person's message reopening the ticket, or a second rating, in the
    same instant takes the lock first or second -- never both through.
    The rating keeps the admin who resolved the ticket at this moment
    (rated_resolver_user_id): a later reopen and another admin's RESOLVED
    do not move it.
    """
    pointer, ticket = await _ticket_by_thread(session, thread_id)
    if pointer is None or ticket is None or pointer.client_user_id != user.id:
        raise NotFoundError("Ticket not found")
    text = (comment or "").strip() or None
    rated = (
        await session.execute(
            update(SupportTicket)
            .where(
                SupportTicket.support_thread_id == ticket.support_thread_id,
                SupportTicket.status == STATUS_RESOLVED,
                SupportTicket.rating.is_(None),
            )
            .values(
                rating=stars,
                rating_comment=text,
                rated_at=func.now(),
                rated_resolver_user_id=SupportTicket.resolved_by_user_id,
            )
            .returning(SupportTicket.rated_at)
        )
    ).first()
    if rated is None:
        raise ConflictError("Only a resolved ticket not rated yet is rated")
    return {
        "id": str(thread_id),
        "stars": stars,
        "comment": text,
        "rated_at": rated[0].isoformat(),
    }


async def pending_ratings(
    session: AsyncSession, *, user: User,
) -> list[dict[str, Any]]:
    """The caller's tickets waiting for their rating: RESOLVED and not
    rated -- most recently resolved first. A ticket reopened since is not
    waiting any more; it will be asked again when it is resolved again."""
    rows = (
        await session.execute(
            select(SupportTicket, SupportThread)
            .join(SupportThread, SupportThread.id == SupportTicket.support_thread_id)
            .where(
                SupportThread.client_user_id == user.id,
                SupportTicket.status == STATUS_RESOLVED,
                SupportTicket.rating.is_(None),
            )
            .order_by(
                SupportTicket.status_changed_at.desc(),
                SupportTicket.support_thread_id.desc(),
            )
        )
    ).all()
    return [
        {
            "id": str(pointer.comms_thread_id),
            "topic": ticket.topic,
            "category": ticket.category,
            "status_changed_at": ticket.status_changed_at.isoformat(),
        }
        for ticket, pointer in rows
    ]


# ---------------------------------------------------------------------------
# Statistics (BE-162 delivery 3)
# ---------------------------------------------------------------------------


def _rating_figures(count: int, total: int | None, top: int | None) -> dict:
    """The rating columns of a statistics row: how many rated, the average
    (two decimals) and the share of 4-5 (0..1, three decimals); null when
    nothing was rated -- no rating is not a zero."""
    if not count:
        return {"rated": 0, "average": None, "share_4_5": None}
    return {
        "rated": count,
        "average": round((total or 0) / count, 2),
        "share_4_5": round((top or 0) / count, 3),
    }


async def support_stats(
    session: AsyncSession, *, created_from: datetime, created_to: datetime,
) -> dict[str, Any]:
    """Support over a period of APPEALS -- tickets created in
    [created_from, created_to), the list's own date filter, so the
    categories add up to the list without spam for the same period
    (owner acceptance check 4).

      categories -- all six, zeros included: tickets, and the ratings of
                    them (rated, average, share of 4-5); spam left out,
                    its rating too.
      total      -- the sum of the categories.
      spam       -- the spam tickets of the period, one figure.
      resolvers  -- per admin a rating is about (rated_resolver), the same
                    rating figures, spam left out.

    History threads have no ticket and are not here (owner: statistics
    start with tickets).

    # KNOWN CEILING (spam is counted from the tickets that still exist;
    # acknowledged by design):
    #   1. Mechanics: every figure here is a count over live support_tickets
    #      rows. Delivery 2 deletes spam after 30 days; a deleted ticket
    #      would leave the count with it, and the owner wants its date and
    #      category to stay in the statistics.
    #   2. Status: acknowledged by design.
    #   3. Task: BE-162 delivery 2 -- it brings the deletion and, with it,
    #      the tombstone (date, category) this count then adds.
    #   4. Trigger: tests/test_support_rating_be162.py
    #      test_no_code_path_deletes_a_ticket goes red -- the first path in
    #      app/ that deletes support_tickets rows.
    #   5. Fix form: in the transaction that deletes a spam ticket, write
    #      (created_at, category) to a tombstone table; `spam` here counts
    #      live spam plus the period's tombstones.
    #   6. Rejected: the tombstone table now, empty -- nothing writes it
    #      before delivery 2, and a test building its rows by hand would
    #      describe a state no code reaches.
    """
    in_period = (
        SupportTicket.created_at >= created_from,
        SupportTicket.created_at < created_to,
    )
    not_spam = SupportTicket.status != STATUS_SPAM
    top = case((SupportTicket.rating >= 4, 1), else_=0)
    per_category = {
        category: (tickets, rated, total, best)
        for category, tickets, rated, total, best in (
            await session.execute(
                select(
                    SupportTicket.category,
                    func.count(),
                    func.count(SupportTicket.rating),
                    func.sum(SupportTicket.rating),
                    func.sum(top),
                )
                .where(*in_period, not_spam)
                .group_by(SupportTicket.category)
            )
        ).all()
    }
    categories = [
        {
            "category": category,
            "tickets": per_category.get(category, (0,))[0],
            **_rating_figures(*per_category.get(category, (0, 0, None, None))[1:]),
        }
        for category in CATEGORIES
    ]
    spam = (
        await session.execute(
            select(func.count()).where(*in_period, SupportTicket.status == STATUS_SPAM)
        )
    ).scalar_one()
    by_resolver = (
        await session.execute(
            select(
                SupportTicket.rated_resolver_user_id,
                func.count(SupportTicket.rating),
                func.sum(SupportTicket.rating),
                func.sum(top),
            )
            .where(
                *in_period,
                not_spam,
                SupportTicket.rating.is_not(None),
                SupportTicket.rated_resolver_user_id.is_not(None),
            )
            .group_by(SupportTicket.rated_resolver_user_id)
        )
    ).all()
    admins: dict[UUID, User] = {}
    if by_resolver:
        admins = {
            u.id: u
            for u in (
                await session.execute(
                    select(User).where(User.id.in_([r[0] for r in by_resolver]))
                )
            ).scalars()
        }
    resolvers = sorted(
        (
            {
                "admin": _peer_payload(admins.get(admin_id)),
                **_rating_figures(count, total, best),
            }
            for admin_id, count, total, best in by_resolver
        ),
        key=lambda r: (-r["rated"], str((r["admin"] or {}).get("user_id"))),
    )
    return {
        "period": {
            "created_from": created_from.isoformat(),
            "created_to": created_to.isoformat(),
        },
        "categories": categories,
        "total": sum(c["tickets"] for c in categories),
        "spam": spam,
        "resolvers": resolvers,
    }


# The admin signal's type (BE-172; comms-profile/types.yaml declares it,
# templates/ru.yaml and en.yaml carry its sheets).
MESSAGE_RECEIVED_TYPE = "support.message_received"

# Last rung of the sender-name chain: language-neutral, because this text
# is built here and read by admins in either profile language.
_NO_NAME = "—"


def _sender_name(user: User) -> str:
    """Who wrote, for the admin signal: the name, else @username, else a dash.

    Never empty -- the stored body is built on it, and comms refuses an
    empty body. Language-neutral on every rung: the signal goes to all
    admins at once, whatever language each one reads.
    """
    name = " ".join(
        part.strip()
        for part in (user.first_name, user.last_name)
        if part and part.strip()
    )
    if name:
        return name
    username = (user.credentials or {}).get("telegram_username")
    if isinstance(username, str) and username.strip():
        return f"@{username.strip()}"
    return _NO_NAME


def _topic_lines(topic: str) -> tuple[str, str]:
    """The ticket's topic as its own line of the signal, in Russian and in
    English -- one variable per profile sheet (topic_line_ru in ru.yaml,
    topic_line_en in en.yaml), so the sheet and the topic are always in one
    language. A template cannot look a code up: comms fills it with
    str.format. Marked by a sign rather than a word."""
    label = TOPICS[topic]
    return f"\n🏷 {label.ru}", f"\n🏷 {label.en}"


async def _emit_support_message_received(
    session: AsyncSession,
    user: User,
    *,
    thread_id: UUID,
    message_id: UUID,
    topic: str,
    claimed_by: UUID | None,
) -> None:
    """support.message_received -- one per message of a person.

    ROUTED BY WHO TOOK THE TICKET (owner ruling BE-162, 6): nobody yet --
    group:admins, ONE emit that comms expands over its synced admins group
    (C-boundary ID-4); taken -- the taker alone. Category-less by design
    (comms-profile/types.yaml): no admin can mute it.

    The idempotency key names the comms MESSAGE: one message, one signal.

    The button opens the THREAD: `open_admin_support` carries the comms
    thread id of the ticket, the id the admin's thread screen is opened by
    (BE-172 fix).

    Texts live in the profile's sheets (ru, en), filled from
    `sender_name` and the topic line of the sheet's own language; the
    stored title and body below are neutral English and are read only when
    rendering fails.
    """
    from app.core.events.notify import (
        TARGET_GROUP_ADMINS,
        emit_notification,
    )

    sender_name = _sender_name(user)
    topic_line_ru, topic_line_en = _topic_lines(topic)
    if claimed_by is not None:
        target_type, target_value = "user", str(claimed_by)
    else:
        target_type, target_value = TARGET_GROUP_ADMINS
    await emit_notification(
        session,
        idempotency_key=f"support-message:{message_id}",
        type=MESSAGE_RECEIVED_TYPE,
        target_type=target_type,
        target_value=target_value,
        title="New message to support",
        body=f"{sender_name}{topic_line_en}",
        action_data={
            "action": "open_admin_support",
            "params": {"thread_id": str(thread_id)},
            "sender_name": sender_name,
            "topic_line_ru": topic_line_ru,
            "topic_line_en": topic_line_en,
        },
    )
