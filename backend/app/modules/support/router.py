# =============================================================================
# VELO Backend -- support proxy (B34, T-38)
# =============================================================================
#
# Two endpoints only, BACKEND-ONLY per this task -- no message/read/claim
# proxy exists here yet (deliberately out of scope; see support/service.py
# for the creation seam a future prompt would extend). Same trust stance as
# chats/router.py and notifications/router.py: comms authenticates the
# PRODUCT, not the end user, and trusts every actor id we send it.
#
#   POST /api/v1/support/threads  -- open (or return) the caller's own
#     eternal support thread. Any authenticated user; the RECIPIENT is
#     always the support section, resolved server-side, never from the
#     wire (there is nothing in the request body TO override -- there is
#     no body).
#
#   GET  /api/v1/support/threads  -- admin-only. Proxies comms' operator-
#     scoped list with is_supervisor FORCED server-side, then filters the
#     page to SECTION threads only, so the student<->master DM traffic
#     that same comms endpoint also carries never reaches an admin through
#     this door. `is_supervisor` and `operator` are NOT accepted as request
#     parameters anywhere on this route -- there is no name a client could
#     supply that this handler would read, which is the point: comms' own
#     handler docstring calls forwarding a client-supplied is_supervisor a
#     full read-authz bypass, and velo's chats admin branch was already
#     rolled back once for exactly that (see list_chats() in
#     chats/router.py and its own docstring on why it no longer calls
#     comms with is_supervisor=True at all).
# =============================================================================

from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.comms import comms_request
from app.core.database import get_db_session
from app.core.exceptions import BadRequestError
from app.modules.auth.dependencies import get_current_admin, get_current_user
from app.modules.support.service import open_support_thread
from app.modules.users.models import User

router = APIRouter(prefix="/api/v1/support", tags=["support"])

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
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> Any:
    """Open the caller's support conversation, or return the existing one.

    No request body: the only possible recipient is the support section,
    and it is resolved inside open_support_thread, never from the wire.
    """
    return await open_support_thread(session, user=user)


@router.get("/threads")
async def list_support_threads(
    request: Request,
    limit: int = Query(default=20, ge=1, le=100),
    cursor: str | None = Query(default=None),
    admin: User = Depends(get_current_admin),
) -> Any:
    """Every support thread, section-scoped, read-only (option A + amend).

    is_supervisor is hard True and operator is the admin's own id -- both
    stamped here, never read from the request. `operator` is functionally
    inert when is_supervisor=True (comms skips its own scope filter
    entirely in that case), but the param is required on comms' side, so
    the admin's own id is what is sent, same as every other authenticated
    proxy call in this codebase.
    """
    _reject_actor_override(request)

    params: dict[str, Any] = {
        "operator": str(admin.id),
        "is_supervisor": True,
        "limit": limit,
    }
    if cursor is not None:
        params["cursor"] = cursor

    payload = await comms_request("GET", "/api/v1/threads", params=params)

    # SECTION-only scoping. comms' /api/v1/threads has no operator_kind
    # filter (confirmed by reading comms/app/api/messaging.py in full --
    # list_threads takes operator/is_supervisor/limit/cursor only), so the
    # scoping has to happen here, on the page comms already returned. Never
    # widens next_cursor's meaning: it is forwarded verbatim, so a page
    # that filters down to zero section threads still advances correctly
    # on the next call.
    if isinstance(payload, dict) and isinstance(payload.get("threads"), list):
        payload["threads"] = [
            thread
            for thread in payload["threads"]
            if isinstance(thread, dict)
            and thread.get("operator_kind") == "section"
        ]

    return payload
