# =============================================================================
# VELO Backend -- support thread service (B34)
# =============================================================================
#
# THREE responsibilities, deliberately in one file because the second and
# third exist only to serve the first:
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
#   2. THREAD CREATION. One eternal support thread per user (kind="dm",
#      operator_kind="section", no subject_ref) -- see the module docstring
#      on SupportThread for why kind="dm" was chosen over "ticket". Opening
#      signals nobody: a thread nobody has written into is not news.
#
#   3. THE ADMIN SIGNAL (BE-172). support.message_received to group:admins
#      on EVERY message a user sends into their support thread -- through
#      the form and from the conversation alike, claimed thread or not --
#      emitted by send_support_message, the one function both doors reach.
#      The thread is eternal and a claim is forever today, so "only the
#      claimer" would tie a person to one admin; all admins are told
#      (owner ruling, BE-172; routing by claim arrives with BE-162). comms'
#      own msg.support_message ping reaches the roster in-app only, and an
#      admin has no in-app surface -- this signal, over Telegram, is the
#      one an admin sees.
# =============================================================================

from typing import Any
from uuid import UUID

import structlog
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.comms import (
    comms_request,
    message_key,
    new_request_key,
    read_comms_page,
)
from app.core.config import settings
from app.core.events import SECTION_SUPPORT_KEY, SECTION_SUPPORT_LABEL
from app.core.exceptions import NotFoundError
from app.modules.support import translation
from app.modules.support.models import TO_SUPPORT, TO_USER, SupportThread
from app.modules.users.models import User

logger = structlog.get_logger()

# In-process cache ONLY (binding rule, see module header). Reset on every
# process restart -- the next call simply re-resolves it.
_support_section_id: UUID | None = None



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


async def open_support_thread(
    session: AsyncSession, *, user: User, topic: str | None = None,
) -> dict:
    """Open (or return) the caller's one eternal support thread.

    Returns the comms thread payload verbatim except for the `created`
    seam detail (mirrors chats/router.py::_open_response -- `created` is
    comms' answer about this request, not the caller's business).

    Emits nothing (BE-172): the admin signal belongs to a message, not to
    a thread -- send_support_message.

    `topic` (PROMPT №712, owner ruling B): the form's topic-picker value.
    Has no effect on comms' dedup (kind="dm" alone already makes this an
    eternal thread) and does nothing on a reopen -- `title` is only stored
    by comms on the INSERT path (create_or_get_thread_detailed,
    comms/app/messaging/threads.py -- a dedup hit returns the existing row
    untouched). It is one of the topic's three surfaces: comms' own
    `title` field, sent here ONLY, so the admin LIST (`_thread_out`
    already returns `title` verbatim) can show the topic without fetching
    each thread's feed; the other two are the message-text prefix and the
    admin signal's text, both in send_support_message, and neither reaches
    a list view (the prefix needs the feed, an N+1 the list must not pay).
    """
    section_id = await get_support_section_id()

    # KEY PER REQUEST, NEVER A STABLE ONE (comms 3.0.0 requires the header
    # here). A replay of a key answers the FIRST response again, `"created":
    # True` included, whatever the thread's age -- comms' create_thread, the
    # flag belongs to the creating request -- so a key derived from the
    # pair would make comms describe every later open as a creation. The
    # pair itself is deduplicated by comms (create-or-get), which is what
    # makes a fresh key per request safe. velo reads `created` nowhere since
    # BE-172, and the rule does not lean on it: each open is a new request.
    #
    # TWO KEY RULES IN THIS MODULE, ON PURPOSE: opening takes a key per
    # request (above), a message takes the CLIENT's key when it sends one
    # (send_support_message). They answer different questions -- an open
    # is a fresh request every time, while "one intent, one message" lives
    # in the client. Making them one rule breaks one of the two.
    payload = await comms_request(
        "POST",
        "/api/v1/threads",
        json={
            "client": str(user.id),
            "operator_kind": "section",
            "operator_value": str(section_id),
            "kind": "dm",
            "title": topic,
        },
        idempotency_key=new_request_key("support-open"),
    )
    comms_thread_id = UUID(str(payload["id"]))

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

    return {k: v for k, v in payload.items() if k != "created"}


async def send_support_message(
    session: AsyncSession,
    *,
    user: User,
    topic: str | None,
    body: str,
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    """Deliver one message into the caller's OWN support thread.

    The thread must already exist (the form calls open_support_thread
    first, on every submit -- cheap, idempotent, matches the chats
    module's own open-then-send split). No thread_id is accepted from the
    wire: the caller's thread is resolved from the local pointer, exactly
    like every other actor field in this codebase.

    TWO DOORS, ONE FUNCTION: the support form (support/router.py, with a
    topic) and the conversation itself (BE-163: POST /chats/{id}/messages
    on the caller's own support thread, no topic). Both land here, so a
    reply from the conversation is queued for translation exactly like the
    form's message.

    `topic` (PROMPT №712): prefixed onto the message text so it survives
    into what an admin actually reads when they open the thread -- the
    durable half of "the topic must survive into something an operator
    can see"; the immediate half is the admin signal's text below. Only
    the form carries one: a message from the conversation has no topic,
    and the thread's comms `title` (the topic of its first opening) is
    not this message's topic (BE-172).

    THE ADMIN SIGNAL (BE-172): support.message_received to group:admins,
    one per comms message (the key is the message id), emitted after the
    message is in comms -- see _emit_support_message_received and the
    KNOWN CEILING at the call.
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
    message = await comms_request(
        "POST",
        f"/api/v1/threads/{pointer.comms_thread_id}/messages",
        json={"sender": str(user.id), "body": text},
        idempotency_key=message_key(user.id, idempotency_key),
    )
    # BE-166: the message is in the thread already, as written -- the user
    # does not wait for a model. Its translation into the support language
    # is ALWAYS queued (owner ruling: the interface language does not say
    # what the user types in), in this transaction; if the transaction is
    # lost, the admin feed's catch-up queues it when the thread is read
    # (translation.admin_feed). A replayed client key returns the same
    # comms message, and the queue is idempotent on it.
    message_id = message.get("id") if isinstance(message, dict) else None
    if message_id is not None:
        await translation.enqueue(
            session,
            pointer=pointer,
            message_id=UUID(str(message_id)),
            direction=TO_SUPPORT,
            locale=settings.support_language,
            text=text,
        )
        # KNOWN CEILING (a message without its admin signal):
        #   1. Mechanics: the message is written by the comms POST above,
        #      outside this transaction; the signal is an outbox row of
        #      this transaction. When comms accepted the POST and this
        #      transaction then fails to commit, the message is in the
        #      thread and no admin is told. The translation queued above
        #      shares the window but has a catch-up (the admin feed queues
        #      a missing translation when it is read); the signal has no
        #      reader to catch it up from.
        #   2. Status: acknowledged by design.
        #   3. Backlog ref: none -- the window is the commit itself failing
        #      after a successful POST; nothing observed has hit it.
        #   4. Promotion trigger: a user message in comms with no outbox row
        #      keyed `support-message:<its id>` behind it.
        #   5. Agreed fix: velo mints the message's identity before the
        #      POST, sends it to comms as the message's Idempotency-Key and
        #      writes the outbox row under the same identity first -- the
        #      signal then exists whenever the message can.
        #   6. Rejected for now: that fix replaces the message key rule
        #      (the client's key is the message's identity, BE-163,
        #      core/comms.py message_key), and emitting before the POST
        #      without it has no message id to key the signal by.
        await _emit_support_message_received(
            session, user, message_id=UUID(str(message_id)), topic=topic,
        )
    return message


async def own_support_thread(
    session: AsyncSession, *, user: User, thread_id: UUID,
) -> SupportThread | None:
    """The caller's OWN support thread, if `thread_id` names it -- or None.

    The one door through which a person's chat routes reach their support
    conversation (BE-163, chats/router.py): strict equality with the
    pointer of the CALLER, so another person's support thread id answers
    None exactly like an id nobody has. No role widens it.
    """
    return (
        await session.execute(
            select(SupportThread).where(
                SupportThread.client_user_id == user.id,
                SupportThread.comms_thread_id == thread_id,
            )
        )
    ).scalar_one_or_none()


async def client_support_messages(
    session: AsyncSession,
    *,
    pointer: SupportThread,
    client: User,
    limit: int,
    cursor: str | None,
) -> dict[str, Any]:
    """The user's own support thread, as they read it (BE-163).

    Read in the user's language when it is not the support language: only
    that read says what became of an admin's reply for them
    (translation.render_for_client), and it drives the catch-up of a reply
    whose job was lost (translation.client_feed). A user who reads the
    support language reads the thread as it is.
    """
    user_locale = translation.reply_language(client)
    params: dict[str, Any] = {"limit": limit}
    if user_locale is not None:
        params["locale"] = user_locale
    if cursor is not None:
        params["cursor"] = cursor
    payload = await comms_request(
        "GET",
        f"/api/v1/threads/{pointer.comms_thread_id}/messages",
        params=params,
    )
    messages, next_cursor = read_comms_page(
        payload, path="/api/v1/threads/{thread_id}/messages",
    )
    return {
        "messages": await translation.client_feed(
            session,
            pointer=pointer,
            user_locale=user_locale,
            messages=messages,
        ),
        "next_cursor": next_cursor,
    }


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


async def list_admin_support_threads(
    session: AsyncSession,
    *,
    admin: User,
    limit: int,
    cursor: str | None,
) -> dict[str, Any]:
    """Every support (section) thread, enriched with the opener's display
    identity. is_supervisor is hard True, operator is the admin's own id
    -- both stamped here, never accepted from a caller (support/router.py
    never binds either name as a request parameter at all).
    """
    params: dict[str, Any] = {
        "operator": str(admin.id),
        "is_supervisor": True,
        "limit": limit,
    }
    if cursor is not None:
        params["cursor"] = cursor

    payload = await comms_request("GET", "/api/v1/threads", params=params)
    # is_supervisor=True above means this page is EVERY thread on the
    # installation -- private DMs included -- so an unknown shape must not
    # be forwarded: it used to be (`return payload` when a `threads` key
    # was missing, and comms 3.0.0 names it `items`), and the admin list
    # carried every conversation of every master. read_comms_page refuses
    # instead (502), logging the shape and never the rows.
    threads, next_cursor = read_comms_page(payload, path="/api/v1/threads")

    # SECTION-only scoping (unchanged from №711): comms' list has no
    # operator_kind filter, so the DM/section split happens on the page
    # we already fetched, never widening what next_cursor means -- it is
    # forwarded verbatim below, so a page that filters to zero threads
    # still advances correctly on the next call.
    section_threads = [
        t
        for t in threads
        if isinstance(t, dict) and t.get("operator_kind") == "section"
    ]

    def _client_uuid(thread: dict[str, Any]) -> UUID | None:
        try:
            return UUID(str(thread.get("client")))
        except (TypeError, ValueError):
            return None

    client_ids = {
        cid for t in section_threads if (cid := _client_uuid(t)) is not None
    }
    users: dict[UUID, User] = {}
    if client_ids:
        result = await session.execute(
            select(User).where(User.id.in_(client_ids))
        )
        users = {u.id: u for u in result.scalars()}
    for thread in section_threads:
        thread["opener"] = _peer_payload(users.get(_client_uuid(thread)))

    # Built, not spread: `{**payload, ...}` would carry comms' own `items`
    # -- the unfiltered page -- out next to the filtered one.
    return {"threads": section_threads, "next_cursor": next_cursor}


async def _require_support_thread(
    session: AsyncSession, thread_id: UUID,
) -> SupportThread:
    """Resolve a comms thread id to a KNOWN support thread, or 404.

    THE section-vs-DM boundary for every admin thread/message/claim call
    below: support_threads is written ONLY by open_support_thread (one
    row per genuine comms thread create), so a row existing here is proof
    the id names a real support thread and not a student<->master DM the
    admin has no business reading through this door. Deliberately 404,
    not 403 -- existence must not leak (chats/router.py::_require_participant's
    own stance, same reasoning).
    """
    pointer = (
        await session.execute(
            select(SupportThread).where(
                SupportThread.comms_thread_id == thread_id
            )
        )
    ).scalar_one_or_none()
    if pointer is None:
        raise NotFoundError("Support thread not found")
    return pointer


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
    pointer = await _require_support_thread(session, thread_id)
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
    """
    pointer = await _require_support_thread(session, thread_id)
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
    pointer = await _require_support_thread(session, thread_id)
    return await translation.retry(
        session, pointer=pointer, message_id=message_id,
    )


async def claim_admin_support_thread(
    session: AsyncSession, *, admin: User, thread_id: UUID,
) -> dict[str, Any]:
    """Claim an unclaimed thread -- the act that grants the right to
    reply (comms' can_post_message admits the assignee; claiming is how
    an admin becomes it). Returns comms' own {claimed, thread} verbatim.

    comms 3.0.0 claims IDEMPOTENTLY BY OUTCOME (its messaging.py claim):
    `claimed` is always true and means "the thread is yours now" -- a
    repeated claim of your own thread is true again, not an error. A
    thread held by ANOTHER operator is a 409, class `conflict`, which
    core/comms.py forwards with comms' message as the detail. There is no
    `claimed: false` any more; nothing here branches on one.
    """
    await _require_support_thread(session, thread_id)
    return await comms_request(
        "POST",
        f"/api/v1/threads/{thread_id}/claim",
        json={"operator": str(admin.id)},
    )


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


def _topic_line(topic: str | None) -> str:
    """The topic as its own line of the signal, or "" when there is none.

    A template cannot say "if": comms fills it with str.format, where a
    null variable prints "None" and a missing one drops the whole sheet to
    the stored text. So the optional part is a variable that is either a
    whole line or empty, marked by a sign rather than a word, which reads
    the same in every profile language. A blank topic is no topic.
    """
    if topic is None or not topic.strip():
        return ""
    return f"\n🏷 {topic.strip()}"


async def _emit_support_message_received(
    session: AsyncSession,
    user: User,
    *,
    message_id: UUID,
    topic: str | None,
) -> None:
    """support.message_received to group:admins -- one per user message.

    A COMMUNICATION audience (C-boundary ID-4), so it goes as ONE emit and
    comms expands it over its synced admins group -- the mechanism that
    carries master.application_received to that group too. Category-less
    by design (comms-profile/types.yaml): no admin can mute it.

    The idempotency key names the comms MESSAGE: one message, one signal.
    A client replay that comms answers with the same message emits the
    same key again, and comms collapses it on the key.

    Texts live in the profile's sheets (ru, en), filled from two template
    variables, `sender_name` and `topic_line`; the stored title and body
    below are neutral English and are read only when rendering fails.
    """
    from app.core.events.notify import (
        TARGET_GROUP_ADMINS,
        emit_notification,
    )

    sender_name = _sender_name(user)
    topic_line = _topic_line(topic)
    target_type, target_value = TARGET_GROUP_ADMINS
    await emit_notification(
        session,
        idempotency_key=f"support-message:{message_id}",
        type=MESSAGE_RECEIVED_TYPE,
        target_type=target_type,
        target_value=target_value,
        title="New message to support",
        body=f"{sender_name}{topic_line}",
        action_data={
            "action": "open_admin_support",
            "params": {"user_id": str(user.id)},
            "sender_name": sender_name,
            "topic_line": topic_line,
        },
    )
