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
# READ AUTHZ, the part comms cannot do for us: comms reads any thread id it
# is given -- it has no answer to "is this person in thread T". A forged
# thread id would otherwise read a stranger's conversation. Every thread-id
# route therefore resolves a local pointer first and checks membership
# against the session: the ChatThread pointer of a DM (chats/models.py), or
# -- BE-163 -- one of the caller's OWN support thread pointers
# (support/service.py::own_support_thread), by strict equality. Since
# BE-162 a person has a support thread per ticket, and any of them opens
# their one support conversation.
#
# THE LISTS COME FROM comms (BE-163, comms 3.9.0): a person's
# conversations as a CLIENT (`?client=`) -- their DMs and their support
# conversation (all their support threads as ONE row, BE-162) in one list,
# most recently active first -- and, for a
# master, their operator list on top. Each row carries its last message;
# a support row's is rendered so that a reply in a language the person
# does not read never leaves the process (support/translation.py).
#
# WHAT IS PROXIED (six of the nine 3b endpoints): create-or-get, list, post
# message, list messages, mark read, unread count. The operator-queue verbs
# (claim / status / retag) are section-thread machinery and this proxy has
# no section threads -- there is no queue in a student <-> master DM.
# Plus one AGGREGATE read that is not a 3b mirror: GET /unread-summary, the
# participant-wide unread state behind the master hub's badge (T-51).
#
# BADGES ARE NOT FETCHED PER ROW ANY MORE. The lists carry `unread` inline
# -- comms computes it for the master branch, one batch call covers a local
# page -- and the key is ABSENT, never zero, on a row the caller takes no
# part in. Zero means "your thread, nothing to read"; absent means "not
# yours". A frontend that reads it as required, or defaults it to 0 in the
# type rather than at the render site, throws that distinction away.
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
# pointer row, or the client of the support thread whose pointer is yours,
# or the thread does not exist as far as you are concerned. No role widens
# it -- a thread neither of whose ids is the caller 404s for everyone,
# admins included (an admin reads support threads through
# /api/v1/support, never here).
#
# FAILURE MODEL: inherited from core/comms.py -- comms unreachable/5xx ->
# 502, timeout -> 504, modeled 4xx forwarded. A chat outage never takes velo
# down with it.
# =============================================================================

import base64
import binascii
import json
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.comms import (
    IDEMPOTENCY_HEADER,
    comms_request,
    message_key,
    new_request_key,
    read_comms_page,
)
from app.core.database import get_db_reader, get_db_session
from app.core.exceptions import (
    BadRequestError,
    ForbiddenError,
    NotFoundError,
)
from app.modules.auth.dependencies import get_current_user
from app.modules.chats.models import ChatThread
from app.modules.masters.groups_service import MasterLinkAction, has_master_link
from app.modules.masters.service import is_master_verified
from app.modules.support.models import SupportThread
from app.modules.support.service import (
    client_support_messages,
    mark_support_read,
    own_support_thread,
    own_support_threads,
    send_dialog_message,
    support_unread,
)
from app.modules.support.translation import render_for_client, reply_language
from app.modules.users.models import User, UserRole

logger = structlog.get_logger()

router = APIRouter(prefix="/api/v1/chats", tags=["chats"])

# Actor identifiers a client must never supply: each one is stamped from the
# session. Listed explicitly so the rejection message can name the offender.
_ACTOR_PARAMS = ("client", "sender", "participant", "operator", "is_supervisor")

# The only operator form this proxy deals in. Written by
# _create_or_get_thread and read by _is_user_form_row -- one constant so
# the write side and the privacy checks provably agree on the same string.
# The other form comms knows, "section", belongs to modules/support and
# never to a personal chat list.
_USER_OPERATOR_KIND = "user"

# Stands in for "the row had no operator_kind at all" in the warning
# _attach_peers_from_comms emits. A sentinel rather than None or "": it
# sorts next to the real forms without a special key, and it cannot be
# mistaken for one -- comms' forms are bare identifiers, so the angle
# brackets and the space are unproducible upstream. (`null` inside a JSON
# log line reads as a serialization artifact, which is the opposite of the
# distinctness this marker exists for.)
_FORM_KEY_ABSENT = "<no operator_kind>"

# The form of a support thread (support/service.py opens it). On a CLIENT
# list it is the person's own support conversation -- once its id is
# proven to be their pointer (_client_rows); on an OPERATOR list it is the
# pool, which never passes (_keep_only_user_form_threads).
_SECTION_OPERATOR_KIND = "section"

# What a row of GET /chats is, for the screen (BE-163): a conversation with
# a person, or the caller's own conversation with support.
CHANNEL_CHAT = "chat"
CHANNEL_SUPPORT = "support"

# A master's threads as a CLIENT are read whole, in one call of comms'
# largest page (comms PAGE_LIMIT_MAX) -- see _merge_client_rows.
_CLIENT_LIST_LIMIT = 100


def _is_user_form_row(thread: Any) -> bool:
    """Is this comms row a user-form DM -- the only form this proxy owns?

    THE ONE ALLOWLIST, read from two places on purpose: the outer filter
    (_keep_only_user_form_threads, which decides what reaches the RESPONSE)
    and the inner guard (_attach_peers_from_comms, which decides whose
    names get RESOLVED). Two copies of this predicate would drift on a
    casing or on a new value and would drift silently, which is precisely
    the failure both callers exist to prevent.

    Allowlist, not denylist: anything unforeseen -- a third form, a
    mangled payload, a row that is not a mapping at all -- answers False
    and is handled as foreign. See _keep_only_user_form_threads for the
    full reasoning on why the unknown falls to that side.
    """
    return (
        isinstance(thread, dict)
        and thread.get("operator_kind") == _USER_OPERATOR_KIND
    )


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


def _keep_only_user_form_threads(payload: dict[str, Any]) -> None:
    """Drop every thread from a list page that is not a user-form DM.

    `payload` is velo's OWN page, `{"threads": [...], "next_cursor": ...}`,
    built by list_chats from what core/comms.py read_comms_page accepted --
    never comms' response itself. Anything else is a programming error and
    raises: an unexpected shape here must close the door, not open it (it
    used to `return`, and a renamed key upstream sent the whole unfiltered
    page out).

    WHY THIS EXISTS -- A PRIVACY LEAK, not tidying. comms' operator-scoped
    read returns `assignee == me` OR `(section thread AND assignee IS
    NULL)`: the UNCLAIMED SUPPORT QUEUE reaches every operator, with no
    supervisor involved. A master is not support staff, so those
    rows were a stranger's support request sitting in a master's personal
    chat list -- carrying the opener's real name, avatar and velo uuid via
    the peer block, plus `title`, which is the topic text the opener typed
    -- and 404ing when tapped, because a section thread has no row in the
    chat_threads projection. A privacy exposure stitched to a dead end.

    This is a RECURRENCE. The admin branch of list_chats was cured of the
    same shape (see its "This used to be `is_supervisor=True`" note): every
    conversation on the installation, every row named and avatared, every
    one 404ing on open. The master branch was not revisited then because
    its is_supervisor is already False -- but it never leaked through the
    supervisor flag, it leaks through the pool.

    ALLOWLIST, NOT DENYLIST, and the difference is where the unknown
    falls. comms' OperatorKind is closed today (user / section), so both
    predicates behave identically right now. They differ on what has not
    happened yet: a denylist admits any form nobody thought about -- a
    third kind if comms adds one, and a row whose `operator_kind` key is
    missing or mangled -- straight into a master's personal list, named
    and avatared. The failure costs are asymmetric: an allowlist mistake
    hides a row (visible, reported, nothing escapes); a denylist mistake
    shows an unforeseen row (invisible to us, discovered from outside).
    In a privacy-class predicate that choice only goes one way.

    A CLAIMED section thread (assignee == the caller) is dropped by the
    same predicate, deliberately. It is dead in both directions anyway --
    no projection row, so _require_participant 404s it -- and the rule
    this module lives by is that listed and openable must be the same set.

    A MASTER'S OWN SUPPORT CONVERSATION IS NOT LOST HERE (BE-163): it is a
    pool row on the operator list too, and is dropped with the pool -- it
    reaches the master's list from the CLIENT list instead, where it is
    admitted only as the master's own (_client_rows). This filter stays the
    guard of the operator list, whatever the client list brings.

    REJECTED: filtering by the local projection ("keep rows that have a
    chat_threads row"), which is tempting because it literally mirrors the
    admin branch. The admin branch BUILDS its list from the projection;
    this branch receives the list from comms, where the projection is a
    lookup table, not the source. The projection can legitimately lack a
    row for a live DM -- _create_or_get_thread re-points on an id change,
    and `velo resync-comms` truncates it outright -- and in that window a
    projection filter would delete a master's OWN conversations from the
    screen. That trades a leak for data loss. Thread FORM does not depend
    on projection state.

    ORDER MATTERS: this runs BEFORE _attach_peers_from_comms. Names and
    avatars we are about to discard must not be resolved at all -- the
    leak is not created even momentarily inside the process -- and the
    discarded rows stay out of the bulk SELECT.

    THE GUARD INSIDE _attach_peers_from_comms DOES NOT REPLACE THIS ONE,
    and removing this one because that one exists would put the leak back.
    They answer different questions. That guard decides whose names get
    RESOLVED; this filter decides what reaches the RESPONSE. A section row
    carries more than a name: `client` is the opener's velo uuid and
    `title` is the topic text they typed. Drop this filter and both go
    back on the wire -- quieter, without a name attached, but still a
    stranger's id and a stranger's words in someone's personal chat list.
    The two are a pair; neither is redundant.

    `next_cursor` is left exactly as comms sent it: the filter must not
    quietly change what pagination means. Same stance as the mirror-image
    filter on the admin support list (support/service.py), which keeps
    section threads and drops the rest on the page it already fetched.

    # KNOWN CEILING (a filtered page is shorter than the requested limit;
    # acknowledged by design):
    #   1. Mechanics: comms fills a page up to `limit` and we remove rows
    #      from it, so the caller can receive fewer than `limit` threads
    #      while next_cursor still points at more. A page can even filter
    #      to zero and still have a successor.
    #   2. Status: acknowledged by design.
    #   3. Backlog ref: none -- the condition is invisible today, see the
    #      trigger.
    #   4. Promotion trigger: the master's list gains paged loading, i.e.
    #      the frontend starts using next_cursor. Today MasterMessagesView
    #      calls listChats() once with no cursor and has no infinite
    #      scroll, so a short page is never read as "the end".
    #   5. Agreed fix: top the page back up to `limit` -- over-fetch from
    #      comms, or walk to the next page -- inside this proxy.
    #   6. Rejected: making comms narrow the result instead. The pool is
    #      visible to an operator CORRECTLY; comms does not know that this
    #      product has no support screen, and must not be taught to.
    """
    threads = payload.get("threads") if isinstance(payload, dict) else None
    if not isinstance(threads, list):
        raise TypeError(
            "_keep_only_user_form_threads takes velo's list page "
            "{'threads': [...]}, not a raw comms response"
        )
    payload["threads"] = [t for t in threads if _is_user_form_row(t)]


async def _attach_peers_from_comms(
    payload: dict[str, Any], session: AsyncSession,
) -> None:
    """Stamp a `peer` display block onto every thread comms listed (P-1).

    `payload` is velo's own page `{"threads": [...], ...}` (see
    _keep_only_user_form_threads); any other shape raises instead of
    silently enriching nothing.

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

    ONLY USER-FORM ROWS ARE RESOLVED (T-56), and this guard lives HERE
    rather than only in the caller because this function has twice been
    the instrument of a privacy leak and both cures were applied to the
    caller instead: the admin branch reading with is_supervisor=True, and
    the master branch receiving the unclaimed support queue. Each time it
    stayed willing to name whoever it was handed. A third caller written
    without a filter would reproduce the defect whole, so the willingness
    is what had to go.

    A foreign row is NOT resolved and NOT counted into the bulk SELECT,
    and it comes back WITHOUT a `peer` key at all -- distinct from the
    `peer: null` a user-form row gets when its client does not resolve.
    Absent means "not ours, never attempted"; null means "attempted, not
    found". Those are different facts and they stay different values.

    THIS GUARD DOES NOT DECIDE THE COMPOSITION OF THE RESPONSE, and must
    not start: foreign rows are left in the list, not dropped, and nothing
    is raised. Deciding what the caller returns is the caller's job --
    _keep_only_user_form_threads does it for the one caller there is, and
    for a reason this guard cannot cover (see its docstring: `client` and
    `title` ride out in the row itself, with or without a name).

    # KNOWN CEILING (the guard here is incomplete by construction;
    # acknowledged by design):
    #   1. Mechanics: this function enriches whatever it is handed. It can
    #      refuse to NAME a foreign row, but it cannot keep that row out
    #      of a caller's response without taking over a decision that is
    #      not its own -- so a caller that skips the outer filter still
    #      returns the row, uuid and title included.
    #   2. Status: acknowledged by design.
    #   3. Backlog ref: none. This is the agreed split of responsibility,
    #      not deferred work.
    #   4. Promotion trigger: a SECOND caller appears. One caller means
    #      the split is bookkeeping; two means it is a contract, and the
    #      division should be revisited deliberately at that point rather
    #      than inherited.
    #   5. Agreed fix, when that happens: make the filtered projection the
    #      only way to obtain rows -- a function that RETURNS the enriched
    #      user-form rows, leaving no unfiltered path to call at all.
    #   6. Rejected: raising on a foreign row -- a cosmetic block would
    #      then take the whole list down, which contradicts the paragraph
    #      above it. Also rejected: dropping foreign rows here. It reads
    #      like the stronger fix and is the more dangerous one: this
    #      function would start deciding response composition, the outer
    #      filter would look redundant to the next reviewer, and removing
    #      it would silently put `client` and `title` back on the wire.
    """
    threads = payload.get("threads") if isinstance(payload, dict) else None
    if not isinstance(threads, list):
        raise TypeError(
            "_attach_peers_from_comms takes velo's list page "
            "{'threads': [...]}, not a raw comms response"
        )

    def _client_uuid(thread: Any) -> UUID | None:
        if not isinstance(thread, dict):
            return None
        try:
            return UUID(str(thread.get("client")))
        except (TypeError, ValueError):
            return None

    # A row that is not a mapping at all is skipped in silence, as it
    # always has been: that is a malformed comms payload, a different
    # diagnosis with a different owner. The warning below is addressed to
    # the CALLER of this function, and only well-formed rows of the wrong
    # FORM are evidence about the caller.
    foreign = [
        t
        for t in threads
        if isinstance(t, dict) and not _is_user_form_row(t)
    ]
    if foreign:
        logger.warning(
            "chat_peer_enrichment_skipped_foreign_rows",
            skipped=len(foreign),
            forms=sorted(
                {
                    str(t.get("operator_kind"))
                    if "operator_kind" in t
                    else _FORM_KEY_ABSENT
                    for t in foreign
                }
            ),
            hint=(
                "caller passed rows this proxy does not own; filter them "
                "before enrichment (see _keep_only_user_form_threads)"
            ),
        )

    ids = {
        cid
        for t in threads
        if _is_user_form_row(t) and (cid := _client_uuid(t)) is not None
    }
    users: dict[UUID, User] = {}
    if ids:
        result = await session.execute(select(User).where(User.id.in_(ids)))
        users = {u.id: u for u in result.scalars()}
    for thread in threads:
        if _is_user_form_row(thread):
            thread["peer"] = _peer_payload(users.get(_client_uuid(thread)))


def _counterparty_id(thread: ChatThread, viewer_id: UUID) -> UUID:
    """Whoever the viewer is NOT, in this thread.

    A viewer who is the client sees the operator (a student looking at
    their master); the operator sees the client.
    """
    if thread.client_user_id == viewer_id:
        return thread.operator_user_id
    return thread.client_user_id


async def _unread_by_thread(
    thread_ids: Sequence[UUID], *, participant: UUID,
) -> dict[str, int]:
    """Unread counts for a page of local rows, in ONE comms call.

    ABSENCE IS AN ANSWER, and this function passes it through untouched.
    comms OMITS a thread the participant takes no part in -- and, by the
    same single rule, an id that matches no thread at all. A zero would
    mean "your thread, nothing to read"; an absent key means "not yours"
    (or "your pointer row is out of sync with comms", which is the same
    signal and the reason a silent zero was rejected upstream). Callers
    must therefore attach the key only where comms returned one.

    Degrades to {} on any comms failure: the list is local and must
    render without badges rather than 502 on a chat outage.
    """
    if not thread_ids:
        # comms would answer {} -- no reason to spend the round trip.
        return {}
    try:
        payload = await comms_request(
            "POST",
            "/api/v1/threads/unread-counts",
            json={
                "participant": str(participant),
                "thread_ids": [str(t) for t in thread_ids],
            },
        )
    except Exception:
        logger.warning(
            "chat_list_unread_failed", participant=str(participant),
        )
        return {}
    counts = payload.get("counts") if isinstance(payload, dict) else None
    return counts if isinstance(counts, dict) else {}


async def _local_thread_list(
    session: AsyncSession,
    rows: Sequence[ChatThread],
    *,
    viewer_id: UUID,
) -> dict[str, Any]:
    """Local-pointer rows, peers in one SELECT, unread in one comms call.

    Used by the one caller comms' lists cannot serve: an admin, whose list
    is their own DM threads on whichever side of the pair -- neither one
    operator scope nor one client scope. (A student's list used to come
    from here too; since BE-163 it is comms' client list.) P-1: without the
    bulk peer SELECT the frontend would need one public-profile request
    per row.

    UNREAD RIDES ALONG (T-51), in one comms call for the whole page, so
    the frontend needs none of its own. `participant` is the SESSION's
    viewer, never anything off the wire. The page limit is 1..100 and
    comms' batch takes 100, so a page always fits and never needs
    splitting. A row whose id comms omitted carries NO `unread` key --
    see _unread_by_thread.
    """
    peer_ids = {_counterparty_id(row, viewer_id) for row in rows}
    peers: dict[UUID, User] = {}
    if peer_ids:
        result = await session.execute(
            select(User).where(User.id.in_(peer_ids))
        )
        peers = {u.id: u for u in result.scalars()}

    unread = await _unread_by_thread(
        [row.comms_thread_id for row in rows], participant=viewer_id,
    )

    threads: list[dict[str, Any]] = []
    for row in rows:
        thread: dict[str, Any] = {
            "id": str(row.comms_thread_id),
            "operator_value": str(row.operator_user_id),
            "created_at": row.created_at.isoformat(),
            "peer": _peer_payload(peers.get(_counterparty_id(row, viewer_id))),
        }
        count = unread.get(str(row.comms_thread_id))
        if count is not None:
            thread["unread"] = int(count)
        threads.append(thread)

    return {"threads": threads, "next_cursor": None}


async def _require_participant(
    session: AsyncSession, thread_id: UUID, user: User
) -> ChatThread | SupportThread:
    """The conversation `thread_id` names, if the caller takes part in it.

    Two kinds, one door (BE-163): a DM whose pointer names the caller on
    either side, or one of the caller's OWN support threads -- the id
    equal to one of their SupportThread pointers, nothing looser (since
    BE-162 a person has one per ticket, and each stands for their whole
    support conversation). Everything else is the
    same 404, before any comms call: a stranger's DM, another person's
    support thread, an id nobody has. The answer never says which.
    """
    stmt = select(ChatThread).where(ChatThread.comms_thread_id == thread_id)
    dm = (await session.execute(stmt)).scalar_one_or_none()
    if dm is not None and _is_participant(dm, user):
        return dm
    support = await own_support_thread(session, user=user, thread_id=thread_id)
    if support is not None:
        return support
    # Deliberately 404 and not 403: an id we have no pointer for is
    # indistinguishable from one that does not exist, and saying which
    # would confirm the existence of somebody else's conversation.
    raise NotFoundError("Chat not found")


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
    # KEY PER REQUEST, NEVER A STABLE ONE (comms 3.0.0 requires the header
    # here). A replay of a key answers `"created": True` whatever the
    # thread's age -- comms' create_thread, the flag belongs to the
    # creating request -- so a key derived from the pair would make every
    # later open of the same conversation a "conversation started" and
    # write a second diary card. The pair itself is deduplicated by comms
    # (create-or-get), which is what makes a fresh key per request safe.
    payload = await comms_request(
        "POST",
        "/api/v1/threads",
        json={
            "client": str(client_id),
            "operator_kind": _USER_OPERATOR_KIND,
            "operator_value": str(operator_id),
            "kind": "dm",
        },
        idempotency_key=new_request_key("thread-open"),
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
    the idempotent entry point the UI calls every time the chat is opened.

    B41 (owner-ruled 2026-08-15, D=C): this used to also write a
    THREAD_STARTED diary event on first open (see upsert_thread_started_event,
    projections.py:588 -- kept, now uncalled, see the note there). That write
    is REMOVED here, not merely gated: no new event, ever. Existing rows are
    NOT deleted -- they are excluded at the diary feed's own read path
    instead (feed_service.py:list_diary_feed), which is reversible and does
    not touch the DiaryEvent schema or its unique index.
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

    # B41: `comms_thread_id`/`repointed` used to gate + feed the removed
    # THREAD_STARTED write below (see the docstring above); neither is
    # consulted by anything else in this function now.
    payload, _comms_thread_id, _repointed = await _create_or_get_thread(
        session, client_id=user.id, operator_id=body.master_id,
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

    ONLY WITH A LINK (BE-46, owner 2026-10-31): the master may open a
    conversation with someone who did something toward him (a booking, a
    waitlist entry, membership of his group), with someone he already has
    this conversation with -- whoever opened it -- or with a member of a
    school where he is a master or the curator (BE-76, BE-78). The rule
    lives in masters/groups_service.has_master_link (OPEN_CHAT). Without
    it, the answer is the same 404 a missing user gets: this route used to
    tell an existing account from a missing one and hand back the person's
    name, and the thread it created made the stranger a "student" -- a
    contact in "Ученики" whose dossier then opened. The student-initiated
    direction (open_chat) stays an open pre-sale channel and is not
    touched.
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

    # BE-46: a link to this master, or the same 404 a missing user gets --
    # one query for both, so neither the answer nor the query count tells
    # them apart. A link implies an existing user (every source row
    # references users.id), which comms also needs: an id with no user
    # behind it would 404 at the create call with an opaque message.
    if not await has_master_link(
        user.id, body.student_id, session, action=MasterLinkAction.OPEN_CHAT,
    ):
        raise NotFoundError("User not found")
    student = await session.get_one(User, body.student_id)

    # B41: the THREAD_STARTED diary write that used to happen here (keyed on
    # `repointed`/`comms_thread_id`) is removed -- see open_chat's docstring.
    payload, _comms_thread_id, _repointed = await _create_or_get_thread(
        session, client_id=body.student_id, operator_id=user.id,
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


def _uuid_of(value: Any) -> UUID | None:
    try:
        return UUID(str(value))
    except (TypeError, ValueError):
        return None


def _activity_key(row: Any) -> tuple[datetime, UUID] | None:
    """A row's place in comms' list order, as comms computes it:
    (COALESCE(last_message_at, created_at), id), both descending
    (comms app/messaging/operators.py _activity_page). None when the row
    does not carry a readable one -- it then has no place to be put in."""
    if not isinstance(row, dict):
        return None
    raw = row.get("last_message_at") or row.get("created_at")
    thread_id = _uuid_of(row.get("id"))
    try:
        when = datetime.fromisoformat(str(raw))
    except (TypeError, ValueError):
        return None
    if thread_id is None or when.tzinfo is None:
        return None
    return when, thread_id


def _dm_last_message(raw: Any) -> dict[str, Any] | None:
    """A DM row's last message, as the list shows it: the text as written
    -- nothing is translated between people (handoffer BE-163, section 4)
    -- and nothing of comms' beyond the four fields of the preview."""
    if not isinstance(raw, dict):
        return None
    out = {k: raw[k] for k in ("id", "sender", "created_at") if k in raw}
    return {**out, "body": raw.get("body"), "translation": None}


async def _read_client_list(
    user: User,
    *,
    limit: int,
    cursor: str | None,
    user_locale: str | None,
) -> tuple[list[Any], str | None]:
    """One page of comms' CLIENT list for the session's user (comms 3.9.0,
    INTEGRATION.md section 13): the threads in which they are the client
    -- their DMs and their support conversation -- most recently active
    first, each with its unread count and its last message; with
    `user_locale` the last message also says what became of it in the
    user's language. `client` is the session's id, never the wire's.
    """
    params: dict[str, Any] = {
        "client": str(user.id),
        "with_unread": True,
        "with_last_message": True,
        "limit": limit,
    }
    if user_locale is not None:
        params["locale"] = user_locale
    if cursor is not None:
        params["cursor"] = cursor
    payload = await comms_request("GET", "/api/v1/threads", params=params)
    return read_comms_page(payload, path="/api/v1/threads")


async def _client_rows(
    session: AsyncSession,
    items: list[Any],
    *,
    viewer: User,
    user_locale: str | None,
    support_given: bool = False,
) -> tuple[list[dict[str, Any]], bool]:
    """The rows of a CLIENT list page the viewer may see and open --
    built, enriched and returned; nothing else of the page goes out. Also
    returns whether the support row has been given out by now.

    ALLOWLIST, the same stance as _keep_only_user_form_threads, and for the
    same reason -- listed and openable are one set, and the unforeseen
    falls to the hidden side:

      user form, a ChatThread pointer naming this id with the viewer as
        its client                     -> a chat row; peer = the master
                                          (operator_value), last message as
                                          written
      section form, the id is ONE OF the viewer's own SupportThread
        pointers, with a last message, and no support row given yet
                                       -> THE support row: id = this thread
                                          (the most recently active one),
                                          thread_ids = all of the viewer's
                                          support threads, unread = their
                                          sum, last message rendered by
                                          render_for_client
      the same, the support row already given, or no last message yet
                                       -> no row: the person's support
                                          threads are ONE conversation
                                          (BE-162), shown once, from the
                                          first message on (owner)
      anything else -- a user-form row with no pointer, a section row that
        is not the viewer's, another form, no form, not a mapping
                                       -> dropped, counted into one warning

    `support_given` carries "already given" across the pages of a paged
    list (the user's -- see list_chats); a master's client list is read
    whole, so it starts false there and the row lands in its window.

    A dropped DM or section row is EMPTY by construction: comms can hold a
    thread velo has no pointer for only when the transaction that wrote the
    pointer was lost after comms answered, and nobody can post into such a
    thread -- every send resolves the pointer first. So the filter hides
    nothing anybody wrote.

    This is a SECOND list source next to _attach_peers_from_comms, not a
    second caller of it: that function names a row's `client`, which on a
    client list is the viewer. It keeps its one caller (see its marker).
    """
    ids = {tid for t in items if isinstance(t, dict) and (tid := _uuid_of(t.get("id")))}
    own_dms: set[UUID] = set()
    if ids:
        own_dms = set(
            (
                await session.execute(
                    select(ChatThread.comms_thread_id).where(
                        ChatThread.comms_thread_id.in_(ids),
                        ChatThread.client_user_id == viewer.id,
                    )
                )
            ).scalars()
        )
    own_support = await own_support_threads(session, user=viewer)
    own_support_ids = {t.comms_thread_id for t in own_support}

    peer_ids = {
        pid
        for t in items
        if isinstance(t, dict)
        and t.get("operator_kind") == _USER_OPERATOR_KIND
        and _uuid_of(t.get("id")) in own_dms
        and (pid := _uuid_of(t.get("operator_value"))) is not None
    }
    peers: dict[UUID, User] = {}
    if peer_ids:
        result = await session.execute(select(User).where(User.id.in_(peer_ids)))
        peers = {u.id: u for u in result.scalars()}

    viewer_id = str(viewer.id)
    rows: list[dict[str, Any]] = []
    dropped: dict[str, int] = {}
    for t in items:
        if not isinstance(t, dict):
            dropped["<not a mapping>"] = dropped.get("<not a mapping>", 0) + 1
            continue
        tid = _uuid_of(t.get("id"))
        form = t.get("operator_kind")
        if form == _USER_OPERATOR_KIND and tid is not None and tid in own_dms:
            row = {k: v for k, v in t.items() if k != "last_message"}
            row["channel"] = CHANNEL_CHAT
            peer_id = _uuid_of(t.get("operator_value"))
            row["peer"] = _peer_payload(
                peers.get(peer_id) if peer_id is not None else None
            )
            row["last_message"] = _dm_last_message(t.get("last_message"))
            rows.append(row)
            continue
        if (
            form == _SECTION_OPERATOR_KIND
            and tid is not None
            and tid in own_support_ids
        ):
            last = t.get("last_message")
            if support_given or not isinstance(last, dict):
                continue  # one conversation, given once, from a message on
            rows.append(
                {
                    "id": str(tid),
                    "channel": CHANNEL_SUPPORT,
                    "thread_ids": [str(x.comms_thread_id) for x in own_support],
                    "peer": None,
                    "created_at": t.get("created_at"),
                    "last_message_at": t.get("last_message_at"),
                    "unread": await support_unread(user=viewer, threads=own_support),
                    "last_message": render_for_client(
                        last, client_id=viewer_id, user_locale=user_locale,
                    ),
                }
            )
            support_given = True
            continue
        key = str(form) if "operator_kind" in t else _FORM_KEY_ABSENT
        dropped[key] = dropped.get(key, 0) + 1
    if dropped:
        # Counts and forms only -- never an id, a client or a title.
        logger.warning("chat_client_rows_dropped", dropped=dropped)
    return rows, support_given


def _encode_client_cursor(comms_cursor: str, support_given: bool) -> str:
    """velo's cursor for a client's list: comms' own cursor, and whether
    the support row is already behind (_client_rows)."""
    raw = json.dumps({"c": comms_cursor, "s": support_given}, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def _decode_client_cursor(token: str) -> tuple[str, bool]:
    try:
        doc = json.loads(base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)))
        comms_cursor, support_given = doc["c"], doc["s"]
    except (binascii.Error, ValueError, KeyError, TypeError):
        raise BadRequestError("Malformed cursor") from None
    if not isinstance(comms_cursor, str) or not isinstance(support_given, bool):
        raise BadRequestError("Malformed cursor")
    return comms_cursor, support_given


def _encode_master_cursor(
    comms_cursor: str, bound: tuple[datetime, UUID],
) -> str:
    """velo's cursor for a master's list: comms' own cursor for the
    operator list, and the place in the list order where this page ended
    -- the upper edge of the next page's window for client rows."""
    raw = json.dumps(
        {"c": comms_cursor, "a": bound[0].isoformat(), "i": str(bound[1])},
        separators=(",", ":"),
    )
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def _decode_master_cursor(token: str) -> tuple[str, tuple[datetime, UUID]]:
    try:
        raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
        doc = json.loads(raw)
        comms_cursor = doc["c"]
        when = datetime.fromisoformat(doc["a"])
        thread_id = UUID(doc["i"])
    except (binascii.Error, ValueError, KeyError, TypeError):
        raise BadRequestError("Malformed cursor") from None
    if not isinstance(comms_cursor, str) or when.tzinfo is None:
        raise BadRequestError("Malformed cursor")
    return comms_cursor, (when, thread_id)


def _merge_client_rows(
    operator_rows: list[dict[str, Any]],
    client_rows: list[dict[str, Any]],
    *,
    upper: tuple[datetime, UUID] | None,
    lower: tuple[datetime, UUID] | None,
) -> list[dict[str, Any]]:
    """A master's page: the operator page, with the client rows that fall
    between its edges put in their places in the one list order.

    The page's window is (lower, upper): `upper` is where the previous page
    ended (none on the first page), `lower` is the last row comms returned
    on this one, before any filter (none on the last page -- every client
    row older than `upper` belongs here). comms orders both lists by the
    same key (_activity_key), so the merge is exact inside the window.

    # KNOWN CEILING (a master's client threads are read as one page of
    # _CLIENT_LIST_LIMIT; acknowledged by design):
    #   1. Mechanics: the client list is read whole in ONE call of comms'
    #      largest page, and its rows are spread over the operator pages
    #      by the window. A master who is the client of more than
    #      _CLIENT_LIST_LIMIT threads loses the oldest of them from his
    #      list.
    #   2. Status: acknowledged by design.
    #   3. Task: none -- a master is the client of his support thread and
    #      of the DMs he opened with other masters; a hundred is not in
    #      sight, and the trigger says when it is.
    #   4. Trigger: chat_list_client_threads_truncated in the app log
    #      (comms answered the client list with a next_cursor).
    #   5. Fix form: page the client list too -- velo's cursor then
    #      carries the client list's own cursor next to the operator
    #      list's, and the page takes the newer rows of the two.
    #   6. Rejected: decoding comms' cursor to place rows -- it is opaque
    #      (INTEGRATION.md section 5); and walking both lists by two
    #      cursors with a count of rows to skip -- a thread that gets a
    #      message between two pages moves up and shifts the count, and a
    #      row is skipped silently.
    """
    placed = [
        (key, row)
        for row in client_rows
        if (key := _activity_key(row)) is not None
        and (upper is None or key < upper)
        and (lower is None or key > lower)
    ]
    placed.sort(key=lambda pair: pair[0], reverse=True)
    pending = [row for _, row in placed]
    keys = [key for key, _ in placed]
    merged: list[dict[str, Any]] = []
    for row in operator_rows:
        key = _activity_key(row)
        while pending and key is not None and keys[0] > key:
            merged.append(pending.pop(0))
            keys.pop(0)
        merged.append(row)
    merged.extend(pending)
    return merged


@router.get("")
async def list_chats(
    request: Request,
    limit: int = Query(default=20, ge=1, le=100),
    cursor: str | None = Query(default=None),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_reader),
) -> Any:
    """The caller's conversations, most recently active first (BE-163).

    Every row carries `channel` -- "chat" (a person) or "support" (the
    caller's own conversation with support) -- and `last_message`: {id,
    sender, created_at, body, translation} or null. In a chat the body is
    as written and `translation` is null; in the support row an admin's
    reply in a language the caller does not read is its translation, or
    body null and `translation` "translating" / "unavailable"
    (support/translation.py render_for_client). The support row appears
    with the first message in it, ONCE, however many support threads the
    caller has (BE-162): `id` is the most recently active of them,
    `thread_ids` all of them -- any of them opens the conversation --,
    `unread` their sum.

    THREE LISTS:

      everyone but a master and an admin -- a CLIENT: comms' client list
        (comms 3.9.0) in its order; rows filtered and built by
        _client_rows. The cursor is velo's own (_encode_client_cursor):
        comms' cursor, and whether the support row is already given.

      MASTER  -- an OPERATOR in comms (is_supervisor hard False: their own
        threads, never anyone else's), filtered by
        _keep_only_user_form_threads, PLUS their threads as a client --
        their own support conversation and the DMs they opened with other
        masters -- put into the same order by _merge_client_rows. The
        cursor is velo's own (_encode_master_cursor).

      ADMIN   -- their own DM threads and nothing else (either side of the
        pair), i.e. EXACTLY the set _require_participant will let them
        open through a DM pointer. Local, because an admin is neither one
        operator scope nor one client scope, and so ordered by creation,
        with no cursor and no last message.
        This used to be `is_supervisor=True`, which handed an admin every
        conversation on the installation -- each row enriched with the
        counterparty's real name and avatar, and each row 404ing the
        moment it was opened. A privacy exposure attached to a dead end;
        the widening is gone rather than narrowed.

    UNREAD IN EVERY BRANCH, no per-row calls anywhere (T-51). comms counts
    it inline on both of its lists (with_unread); the admin branch gets it
    in one batch call inside _local_thread_list. A row the caller takes no
    part in carries NO `unread` key -- reachable in the admin branch, where
    a comms_thread_id in the projection may be stale or foreign, and there
    the missing key is the drift detector it was built to be. On comms'
    lists every row left is the caller's own, so the key is there.

    THE SUPPORT QUEUE IS NOT IN THIS LIST (T-53). comms hands every
    operator the unclaimed section pool; _keep_only_user_form_threads
    drops it before anything is resolved -- a privacy filter, not a
    cosmetic one. A support row comes ONLY from the client list, and only
    as one of the caller's own pointers.

    comms DOWN IS A 502 on both comms branches: the list IS comms' list,
    and an empty or local stand-in on a chat outage is a product decision
    nobody made. Only the admin branch, local, still answers without
    badges.
    """
    _reject_actor_override(request)
    user_locale = reply_language(user)

    if user.role == UserRole.MASTER:
        comms_cursor: str | None = None
        upper: tuple[datetime, UUID] | None = None
        if cursor is not None:
            comms_cursor, upper = _decode_master_cursor(cursor)
        params: dict[str, Any] = {
            "operator": str(user.id),
            # Stamped from the role and never from the wire. Constant now
            # that the admin branch no longer routes through here: nothing
            # this proxy sends comms ever widens the read.
            "is_supervisor": False,
            # Opt-in additive keys: comms' list shape is frozen and
            # unchanged without them.
            "with_unread": True,
            "with_last_message": True,
            "limit": limit,
        }
        if comms_cursor is not None:
            params["cursor"] = comms_cursor
        payload = await comms_request("GET", "/api/v1/threads", params=params)
        # comms' page is READ, not forwarded: the response is velo's own
        # page, built from the two things read_comms_page accepted, so no
        # key of comms' reaches the caller unparsed -- and an unknown shape
        # is a 502, not an unfiltered pass-through (see read_comms_page).
        items, next_cursor = read_comms_page(payload, path="/api/v1/threads")
        # Where this page ends in the list order: the last row comms
        # returned, BEFORE the privacy filter drops anything -- the next
        # operator page starts right after it.
        lower: tuple[datetime, UUID] | None = None
        if next_cursor is not None:
            lower = _activity_key(items[-1]) if items else None
            if lower is None:
                logger.error("chat_list_page_end_unreadable")
                raise HTTPException(status_code=502, detail="Chats unavailable")
        page: dict[str, Any] = {"threads": items, "next_cursor": next_cursor}
        # Privacy filter FIRST -- see _keep_only_user_form_threads. The
        # unclaimed support queue reaches every operator, and nothing about
        # it may be resolved, enriched or returned here.
        _keep_only_user_form_threads(page)
        await _attach_peers_from_comms(page, session)
        operator_rows = [
            {
                **{k: v for k, v in t.items() if k != "last_message"},
                "channel": CHANNEL_CHAT,
                "last_message": _dm_last_message(t.get("last_message")),
            }
            for t in page["threads"]
        ]

        client_items, client_next = await _read_client_list(
            user, limit=_CLIENT_LIST_LIMIT, cursor=None, user_locale=user_locale,
        )
        if client_next is not None:
            # The KNOWN CEILING's trigger -- see _merge_client_rows.
            logger.warning(
                "chat_list_client_threads_truncated",
                limit=_CLIENT_LIST_LIMIT,
            )
        client_rows, _ = await _client_rows(
            session, client_items, viewer=user, user_locale=user_locale,
        )
        return {
            "threads": _merge_client_rows(
                operator_rows, client_rows, upper=upper, lower=lower,
            ),
            "next_cursor": (
                _encode_master_cursor(next_cursor, lower)
                if next_cursor is not None and lower is not None
                else None
            ),
        }

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

    comms_cursor, support_given = (
        _decode_client_cursor(cursor) if cursor is not None else (None, False)
    )
    items, next_cursor = await _read_client_list(
        user, limit=limit, cursor=comms_cursor, user_locale=user_locale,
    )
    rows, support_given = await _client_rows(
        session,
        items,
        viewer=user,
        user_locale=user_locale,
        support_given=support_given,
    )
    return {
        "threads": rows,
        "next_cursor": (
            _encode_client_cursor(next_cursor, support_given)
            if next_cursor is not None
            else None
        ),
    }


# Declared ABOVE every /{thread_id} route: a literal segment must not be
# reachable as a thread id.
@router.get("/unread-summary")
async def unread_summary(
    request: Request,
    user: User = Depends(get_current_user),
) -> Any:
    """The caller's unread state across all their conversations.

    One call, three numbers: has_unread for a dot, threads_with_unread and
    unread_messages for a badge. `participant` is the SESSION's user and
    nothing else -- comms trusts whatever we send, so this proxy is the
    only thing standing between a forged id and someone else's unread
    state.

    Serves the master hub's «Сообщения» badge, which used to list every
    thread and ask for each one's count (T-51: the third and most
    expensive N+1 in the product, paid on every hub open).

    WHAT THE NUMBER MEANS CHANGED, deliberately and with owner sign-off.
    It is now "my unread, in whatever role I hold": unclaimed support
    threads drop out (a master takes no part in them, and they were only
    ever in the sum because the pool is visible to operators), while
    threads where the master is himself the client come in (a master can
    open a chat with another master). For a row on one's OWN profile that
    is the right meaning.

    WHERE THAT LEAVES THIS NUMBER AND THE CHAT LIST (T-53, BE-163). The
    support pool is gone from BOTH: out of this aggregate because there is
    no participation in it, and out of GET /chats because the master
    branch filters it. And since BE-163 the two cover the same threads:
    a thread where the master is himself the CLIENT -- his own support
    conversation, a DM he opened with another master -- counts HERE and is
    in that list too, merged in from comms' client list. "Mine, in
    whatever role" is now the meaning of both. They can still differ in
    what one screen shows: the list is paged and its client part is read
    as one page (see the KNOWN CEILING on _merge_client_rows), the sum is
    not.

    # KNOWN CEILING (velo answers "do I have unread" on TWO surfaces;
    # acknowledged by design):
    #   1. Mechanics: this endpoint returns a COUNT for the master hub,
    #      while GET /api/v1/bookings/me/stats carries a BOOLEAN
    #      (has_unread_messages) inline for the student profile. Two
    #      surfaces, one underlying question, both reading the same comms
    #      summary.
    #   2. Status: acknowledged by design.
    #   3. Backlog ref: none. This is not a deferred cleanup -- it is what
    #      the B52 ruling costs, and the cost was accepted when the ruling
    #      was made.
    #   4. Promotion trigger: the owner revokes B52, i.e. the student
    #      profile is allowed a SECOND request for its dot. Nothing
    #      observable at runtime will ever signal this -- both surfaces
    #      read one aggregate and cannot disagree -- so there is no
    #      metric to watch and none is invented here.
    #   5. Agreed fix: once B52 is revoked, the profile screen calls this
    #      endpoint too and the boolean leaves UserStatsResponse entirely
    #      (deleted, not deprecated).
    #   6. Rejected: unifying the two NOW by dropping
    #      has_unread_messages and having the profile call this endpoint.
    #      B52 (owner-ruled 2026-08-15) says the student profile makes
    #      exactly ONE request; that unification adds a second one, so it
    #      does not tidy the contract -- it breaks a ruling. Also
    #      rejected: adding the count to UserStatsResponse instead, which
    #      keeps one request but puts a master's number in the student
    #      screen's schema.
    """
    _reject_actor_override(request)
    return await comms_request(
        "GET",
        f"/api/v1/participants/{user.id}/unread-summary",
    )


@router.post("/{thread_id}/messages")
async def post_message(
    thread_id: UUID,
    body: MessageCreate,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
    idempotency_key: str | None = Header(
        default=None, alias=IDEMPOTENCY_HEADER,
    ),
) -> Any:
    """Send a message. `sender` is the session's user, always.

    An optional `Idempotency-Key` from the client names ONE intent to send:
    repeated with the same key, it is one message and one ping (see
    core/comms.py message_key). Without it, each request is its own.

    Any of the caller's own support threads (BE-163) names their ONE
    support conversation, and the message goes where the conversation
    sends it -- support/service.py::send_dialog_message: their latest open
    ticket, else their latest ticket, else a new ticket "other" (BE-162),
    not necessarily the thread the id names. It is queued for translation
    in this transaction; that write is why the session here commits.
    """
    _reject_actor_override(request)
    key = message_key(user.id, idempotency_key)
    conversation = await _require_participant(session, thread_id, user)
    if isinstance(conversation, SupportThread):
        return await send_dialog_message(
            session,
            user=user,
            body=body.body,
            idempotency_key=idempotency_key,
        )
    return await comms_request(
        "POST",
        f"/api/v1/threads/{thread_id}/messages",
        json={"sender": str(user.id), "body": body.body},
        idempotency_key=key,
    )


@router.get("/{thread_id}/messages")
async def list_messages(
    thread_id: UUID,
    request: Request,
    limit: int = Query(default=20, ge=1, le=100),
    cursor: str | None = Query(default=None),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> Any:
    """A page of a conversation, newest first.

    Any of the caller's own support threads opens their WHOLE support
    conversation (BE-162): all their support threads glued by time, read as
    their client reads it -- support/service.py::client_support_messages,
    with velo's own cursor. An admin's reply in
    a language the caller does not read comes as its translation or as no
    text and a state, never as the original; a reply whose translation was
    never asked for is queued here, which is why the session commits.
    """
    _reject_actor_override(request)
    conversation = await _require_participant(session, thread_id, user)
    if isinstance(conversation, SupportThread):
        return await client_support_messages(
            session, client=user, limit=limit, cursor=cursor,
        )
    params: dict[str, Any] = {"limit": limit}
    if cursor is not None:
        params["cursor"] = cursor
    payload = await comms_request(
        "GET", f"/api/v1/threads/{thread_id}/messages", params=params,
    )
    # READ, not forwarded (same form as list_chats): comms 3.0.0 pages the
    # feed as {"items", "next_cursor"}; velo's contract with the frontend
    # is {"messages", "next_cursor"} (frontend/src/api/chats.ts). Forwarding
    # left the key renamed under the frontend and every open chat empty.
    # An unknown shape is a 502 (read_comms_page), never a pass-through.
    messages, next_cursor = read_comms_page(
        payload, path="/api/v1/threads/{thread_id}/messages",
    )
    return {"messages": messages, "next_cursor": next_cursor}


@router.post("/{thread_id}/read")
async def mark_read(
    thread_id: UUID,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_reader),
) -> Any:
    """Mark the thread read up to now for the CALLER (never for the peer).

    For any of the caller's own support threads, their whole support
    conversation is read (BE-162): every support thread of theirs, one comms
    call each (support/service.py::mark_support_read) -- comms keeps a read
    pointer per thread, the client of a support thread included.
    """
    _reject_actor_override(request)
    conversation = await _require_participant(session, thread_id, user)
    if isinstance(conversation, SupportThread):
        return await mark_support_read(
            user=user, threads=await own_support_threads(session, user=user),
        )
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
    """One thread's unread count for the caller.

    # KNOWN CEILING (route with no frontend caller since T-51;
    # acknowledged by design):
    #   1. Mechanics: the lists now carry `unread` inline, so no screen
    #      calls this route any more. Its TypeScript wrapper was deleted
    #      with the callers; the route itself was not.
    #   2. Status: acknowledged by design.
    #   3. Backlog ref: none -- it is kept for two active reasons, below.
    #   4. Promotion trigger: BOTH of its two jobs disappear -- the
    #      stranger-404 matrix stops covering this verb (tests
    #      test_chats_t2.py / test_chats_t3_students.py), AND the owner
    #      gains another sanctioned way to query comms directly from the
    #      server.
    #   5. Agreed fix: delete the route together with its row in the
    #      failure matrix, in one change, once both jobs are gone.
    #   6. Rejected: deleting it now as "a route with no callers". It is
    #      (a) a member of the four-verb failure matrix -- post /
    #      messages / read / unread-count all 404 for a stranger BEFORE
    #      reaching comms, and dropping a verb narrows what that matrix
    #      proves while the surface itself stays exposed; and (b) the
    #      ONLY sanctioned end-to-end probe the owner has: comms has no
    #      public port and no nginx route, and the server permits only
    #      install_velo.sh and velo commands, so `curl` into comms is not
    #      available. Verifying "the list shows the same numbers as the
    #      per-thread count" is possible through this proxy and nowhere
    #      else.
    """
    _reject_actor_override(request)
    conversation = await _require_participant(session, thread_id, user)
    if isinstance(conversation, SupportThread):
        # The whole support conversation (BE-162), as the list counts it.
        return {
            "unread": await support_unread(
                user=user, threads=await own_support_threads(session, user=user),
            )
        }
    return await comms_request(
        "GET",
        f"/api/v1/threads/{thread_id}/unread-count",
        params={"participant": str(user.id)},
    )
