# =============================================================================
# VELO Backend -- support proxy (B34, T-38; admin thread/message/claim
# endpoints added PROMPT №713)
# =============================================================================
#
# Same trust stance as chats/router.py and notifications/router.py: comms
# authenticates the PRODUCT, not the end user, and trusts every actor id
# we send it.
#
# USER-FACING (any authenticated user; unchanged from №712):
#   POST /api/v1/support/threads          -- open (or return) the caller's
#     own eternal support thread. Optional {topic} body, used to enrich
#     the admin-group notification and (PROMPT №713) the comms thread's
#     own `title` on genuine creation -- see service.py::open_support_thread.
#   POST /api/v1/support/threads/messages -- deliver one message into the
#     caller's OWN thread. No thread_id anywhere on the wire -- resolved
#     server-side from the local pointer.
#
# ADMIN-FACING (get_current_admin; PROMPT №713 except the first):
#   GET  /api/v1/support/threads                    -- every support
#     thread, section-scoped (never a DM), opener identity attached.
#   GET  /api/v1/support/threads/{id}/messages       -- a thread's feed.
#     Read access is universal-for-admins (owner ruling: every admin SEES
#     every thread) -- no claim required to READ.
#   POST /api/v1/support/threads/{id}/messages       -- reply. Comms
#     itself enforces write-authz (client or ASSIGNEE only, no supervisor
#     bypass) -- an admin who has not claimed gets comms' own 403 back
#     (forward_403=True on the comms_request call), not a swallowed 502.
#   POST /api/v1/support/threads/{id}/claim          -- claim an
#     unclaimed thread; the act that grants the right to reply.
#
# `is_supervisor` and `operator` are NOT accepted as request parameters
# anywhere on this router -- there is no name a client could supply that
# any handler here would read, which is the point: comms' own handler
# docstring calls forwarding a client-supplied is_supervisor a full
# read-authz bypass, and velo's chats admin branch was already rolled
# back once for exactly that (see list_chats() in chats/router.py and its
# own docstring on why it no longer calls comms with is_supervisor=True
# at all). `{id}` in every admin route is a comms thread id validated
# against the LOCAL support_threads pointer before any comms call
# (service.py::_require_support_thread) -- that is what stops an admin
# from reading a student<->master DM by guessing/passing its thread id
# here; a 404, not a 403, so existence never leaks.
# =============================================================================

from typing import Any
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db_session
from app.core.exceptions import BadRequestError
from app.modules.auth.dependencies import get_current_admin, get_current_user
from app.modules.support.service import (
    claim_admin_support_thread,
    get_admin_support_messages,
    list_admin_support_threads,
    open_support_thread,
    send_admin_support_message,
    send_support_message,
)
from app.modules.users.models import User

router = APIRouter(prefix="/api/v1/support", tags=["support"])


class OpenThreadIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    topic: str | None = Field(default=None, max_length=200)


class SendMessageIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    topic: str | None = Field(default=None, max_length=200)
    body: str = Field(min_length=1, max_length=4000)


class AdminReplyIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    body: str = Field(min_length=1, max_length=4000)


# Named explicitly so the rejection message can name the offender, same
# rationale as chats/router.py::_ACTOR_PARAMS -- kept here even though
# neither name is bound anywhere on list_support_threads below: silence on
# an attempted override would hide the attempt, an explicit 400 does not.
_ACTOR_PARAMS = ("operator", "is_supervisor")


def _reject_actor_override(request: Request) -> None:
    for name in _ACTOR_PARAMS:
        if name in request.query_params:
            raise BadRequestError(
                f"{name} is derived from the session and cannot be supplied",
            )


@router.post("/threads")
async def open_thread(
    body: OpenThreadIn | None = Body(default=None),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> Any:
    """Open the caller's support conversation, or return the existing one.

    `topic` is the only field the body can carry, and it names nothing --
    the RECIPIENT is always the support section, resolved inside
    open_support_thread, never from the wire.
    """
    topic = body.topic if body is not None else None
    return await open_support_thread(session, user=user, topic=topic)


@router.post("/threads/messages")
async def send_message(
    body: SendMessageIn,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> Any:
    """Send one message into the caller's OWN support thread.

    404s if the caller has never opened a support thread -- the form
    calls POST /threads first on every submit, so this should not happen
    in practice, but there is no thread to resolve without it.
    """
    return await send_support_message(
        session, user=user, topic=body.topic, body=body.body,
    )


@router.get("/threads")
async def list_support_threads(
    request: Request,
    limit: int = Query(default=20, ge=1, le=100),
    cursor: str | None = Query(default=None),
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_session),
) -> Any:
    """Every support thread, section-scoped, opener identity attached.

    is_supervisor is hard True and operator is the admin's own id -- both
    stamped in service.py, never read from the request. `operator` is
    functionally inert when is_supervisor=True (comms skips its own scope
    filter entirely in that case), but the param is required on comms'
    side, so the admin's own id is what is sent, same as every other
    authenticated proxy call in this codebase.
    """
    _reject_actor_override(request)
    return await list_admin_support_threads(
        session, admin=admin, limit=limit, cursor=cursor,
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
) -> Any:
    """Reply as this admin. 403s (comms' own, forwarded) if the caller has
    not claimed the thread -- claim it first via POST .../claim."""
    return await send_admin_support_message(
        session, admin=admin, thread_id=thread_id, body=body.body,
    )


@router.post("/threads/{thread_id}/claim")
async def claim_thread(
    thread_id: UUID,
    admin: User = Depends(get_current_admin),
    session: AsyncSession = Depends(get_db_session),
) -> Any:
    """Claim an unclaimed support thread. `{claimed: false, thread: ...}`
    is a normal response (someone else won the race), not an error."""
    return await claim_admin_support_thread(
        session, admin=admin, thread_id=thread_id,
    )
