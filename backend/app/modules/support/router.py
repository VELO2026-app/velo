# =============================================================================
# VELO Backend -- support proxy (B34, T-38, PROMPT №713, BE-162)
# =============================================================================
#
# Same trust stance as chats/router.py and notifications/router.py: comms
# authenticates the PRODUCT, not the end user, and trusts every actor id
# we send it.
#
# USER-FACING (any authenticated user):
#   POST /api/v1/support/tickets {topic, body} -- an appeal through the
#     support form: a NEW ticket and its first message (BE-162). `topic`
#     is a code (models.TOPICS); the category follows from it. The
#     client's Idempotency-Key names the appeal: a repeat is the same
#     ticket. No thread or recipient on the wire -- the recipient is the
#     support section, resolved server-side.
#
# THE PERSON'S CONVERSATION IS NOT ON THIS ROUTER (BE-163, BE-162): they
# read, mark read and answer it through the chat routes (chats/router.py,
# /api/v1/chats/{id}/...), where all their support threads are one row and
# one glued feed; those routes resolve the id only against the caller's
# own pointers (service.py::own_support_thread) and render each message by
# translation.render_for_client -- never the original of a reply in a
# language the person does not read.
#
# ADMIN-FACING (get_current_admin):
#   GET  /api/v1/support/tickets                 -- tickets, newest appeal
#     first, from velo's table: filters category / status / created_from /
#     created_to; without `status` every ticket but spam.
#   GET  /api/v1/support/tickets/{id}            -- one ticket, the list's
#     own row (BE-162 fix: the card opened from a signal); spam included;
#     a history thread or any other id -> 404.
#   POST /api/v1/support/tickets/{id}/status     -- an OPEN ticket to
#     resolved / rejected / duplicate / spam; comms' thread to `resolved`.
#   GET  /api/v1/support/threads/{id}/messages   -- a support thread's feed
#     (a ticket, or a person's pre-BE-162 history). Every admin reads every
#     thread -- no claim required to READ.
#   POST /api/v1/support/threads/{id}/messages   -- reply, in a ticket.
#     comms enforces write-authz (client or ASSIGNEE): an admin who has not
#     claimed gets comms' 403 back (forward_403=True).
#   POST /api/v1/support/threads/{id}/claim      -- take a ticket: the
#     right to reply, and the person's signals to this admin alone. Yours
#     -> {claimed: true}, also on a repeat; held by another admin -> 409.
#   POST /api/v1/support/threads/{id}/messages/{mid}/translation/retry
#     -- BE-166: ask again for a message whose translation's job failed.
#   A person's history thread is read-only: claim / reply / status -> 409.
#
# BE-166: every message goes into the thread as written; its translation is
# a comms VARIANT next to it -- support/translation.py. The admin feed
# carries the variant and the author's `original`.
#
# `is_supervisor` and `operator` are NOT accepted as request parameters
# anywhere on this router, and since BE-162 velo never sends comms
# is_supervisor=True at all: the admin list is velo's own table. `{id}` in
# every admin route is a comms thread id validated against the LOCAL
# support_threads pointer before any comms call
# (service.py::_require_support_thread) -- that is what stops an admin from
# reading a student<->master DM through this door; a 404, not a 403, so
# existence never leaks.
# =============================================================================

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.comms import IDEMPOTENCY_HEADER
from app.core.database import get_db_session
from app.core.exceptions import BadRequestError
from app.modules.auth.dependencies import get_current_admin, get_current_user
from app.modules.support.service import (
    claim_admin_support_thread,
    create_ticket,
    get_admin_support_messages,
    get_admin_ticket,
    list_admin_tickets,
    retry_support_translation,
    send_admin_support_message,
    set_ticket_status,
)
from app.modules.users.models import User

router = APIRouter(prefix="/api/v1/support", tags=["support"])

# The closed sets the wire accepts -- literal copies checked equal to
# models.TOPICS / CATEGORIES / STATUSES / CLOSING_STATUSES by
# tests/test_support_tickets_be162.py (a Literal needs the values spelled).
TopicCode = Literal[
    "payment",
    "complaint_master",
    "practice",
    "withdrawal",
    "practices",
    "add_direction",
    "complaint_user",
    "technical",
    "other",
]
CategoryCode = Literal[
    "tech",
    "practices",
    "payments",
    "complaint_master",
    "complaint_user",
    "other",
]
StatusCode = Literal["open", "resolved", "rejected", "duplicate", "spam"]
ClosingStatus = Literal["resolved", "rejected", "duplicate", "spam"]


class TicketIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    topic: TopicCode
    body: str = Field(min_length=1, max_length=4000)


class StatusIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: ClosingStatus


class AdminReplyIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    body: str = Field(min_length=1, max_length=4000)


# Named explicitly so the rejection message can name the offender, same
# rationale as chats/router.py::_ACTOR_PARAMS: silence on an attempted
# override would hide the attempt, an explicit 400 does not.
_ACTOR_PARAMS = ("operator", "is_supervisor")


def _reject_actor_override(request: Request) -> None:
    for name in _ACTOR_PARAMS:
        if name in request.query_params:
            raise BadRequestError(
                f"{name} is derived from the session and cannot be supplied",
            )


@router.post("/tickets")
async def open_ticket(
    body: TicketIn,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
    idempotency_key: str | None = Header(
        default=None, alias=IDEMPOTENCY_HEADER,
    ),
) -> Any:
    """An appeal through the support form: `{ticket, message}`. An unknown
    topic code is a 422 before anything is called."""
    return await create_ticket(
        session,
        user=user,
        topic=body.topic,
        body=body.body,
        idempotency_key=idempotency_key,
    )


@router.get("/tickets")
async def list_tickets(
    request: Request,
    category: CategoryCode | None = Query(default=None),
    status: StatusCode | None = Query(default=None),
    created_from: datetime | None = Query(default=None),
    created_to: datetime | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    cursor: str | None = Query(default=None),
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_session),
) -> Any:
    """Tickets, newest appeal first -- see service.list_admin_tickets.
    `created_from` / `created_to` must carry a time zone."""
    _reject_actor_override(request)
    for name, value in (("created_from", created_from), ("created_to", created_to)):
        if value is not None and value.tzinfo is None:
            raise BadRequestError(f"{name} must carry a time zone")
    return await list_admin_tickets(
        session,
        category=category,
        status=status,
        created_from=created_from,
        created_to=created_to,
        limit=limit,
        cursor=cursor,
    )


@router.get("/tickets/{thread_id}")
async def get_ticket(
    thread_id: UUID,
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_session),
) -> Any:
    """One ticket, exactly as a row of GET /tickets -- see
    service.get_admin_ticket. 404 unless `thread_id` is a ticket's."""
    return await get_admin_ticket(session, thread_id=thread_id)


@router.post("/tickets/{thread_id}/status")
async def change_ticket_status(
    thread_id: UUID,
    body: StatusIn,
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_session),
) -> Any:
    """An OPEN ticket to resolved / rejected / duplicate / spam. 409 -- the
    ticket is not open, it changed meanwhile, or it is a history thread."""
    return await set_ticket_status(
        session, admin=admin, thread_id=thread_id, status=body.status,
    )


@router.get("/threads/{thread_id}/messages")
async def get_thread_messages(
    thread_id: UUID,
    limit: int = Query(default=20, ge=1, le=100),
    cursor: str | None = Query(default=None),
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_session),
) -> Any:
    """A support thread's feed. 404s if `thread_id` does not name a known
    support thread (never a DM, never a bare "not found vs not yours"
    distinction that would leak existence)."""
    return await get_admin_support_messages(
        session, thread_id=thread_id, limit=limit, cursor=cursor,
    )


@router.post("/threads/{thread_id}/messages")
async def reply_to_thread(
    thread_id: UUID,
    body: AdminReplyIn,
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_session),
    idempotency_key: str | None = Header(
        default=None, alias=IDEMPOTENCY_HEADER,
    ),
) -> Any:
    """Reply as this admin, in a ticket. 403s (comms' own, forwarded) if
    the caller has not claimed it -- claim it first via POST .../claim;
    409 on a person's history thread."""
    return await send_admin_support_message(
        session,
        admin=admin,
        thread_id=thread_id,
        body=body.body,
        idempotency_key=idempotency_key,
    )


@router.post("/threads/{thread_id}/claim")
async def claim_thread(
    thread_id: UUID,
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_session),
) -> Any:
    """Take a ticket: 200 `{claimed: true, thread}` when it is yours (a
    repeat of your own claim included), 409 when another admin holds it or
    it is a history thread -- see service.claim_admin_support_thread."""
    return await claim_admin_support_thread(
        session, admin=admin, thread_id=thread_id,
    )


@router.post("/threads/{thread_id}/messages/{message_id}/translation/retry")
async def retry_translation(
    thread_id: UUID,
    message_id: UUID,
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_session),
) -> Any:
    """Ask again for a message whose translation's job failed (BE-166). Any
    admin: nothing is posted as anyone. 200 `{message_id, locale, attempt,
    state: "preparing"}`; 409 -- nothing to retry (in progress, translated,
    declined -- a variant is final in comms -- or a reply that needs no
    translation); 404 -- not a support thread, or the message is not within
    the pages a retry searches (translation.find_message)."""
    return await retry_support_translation(
        session, thread_id=thread_id, message_id=message_id,
    )
