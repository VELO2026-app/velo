# =============================================================================
# VELO Backend -- MCP token endpoints for the app (BE-138)
# =============================================================================
#
#   POST /api/v1/users/me/mcp-tokens                  -- mint; the token, once
#   GET  /api/v1/users/me/mcp-tokens                  -- list, never the secret
#   POST /api/v1/users/me/mcp-tokens/{token_id}/revoke -- revoke own; idempotent
#
# Any signed-in user mints tokens for themselves (owner ruling: what /mcp
# serves is the student's scenarios, whoever holds the account). A deactivated
# user gets get_current_user's 403 here, as everywhere.
#
# Someone else's token is a 404 on revoke, the same 404 as no token at all,
# and never appears in the list: existence is not disclosed.
# =============================================================================

from uuid import UUID

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db_reader, get_db_session
from app.core.exceptions import NotFoundError
from app.modules.auth.dependencies import get_current_user, get_current_user_write
from app.modules.mcp.schemas import (
    McpTokenCreate,
    McpTokenCreated,
    McpTokenItem,
    McpTokenListResponse,
)
from app.modules.mcp.service import (
    create_mcp_token,
    list_mcp_tokens,
    revoke_mcp_token,
)
from app.modules.users.models import User


def _require_mcp_enabled() -> None:
    """The MCP killswitch on this router (settings.mcp_enabled).

    Same shape as _require_curator_groups_enabled in
    curator_groups/router.py, for the reasons written there: a router-level
    dependency so no endpoint can forget it; 404 with no machine code, so a
    client cannot tell "switched off" from "never existed"; it runs before
    the path dependencies, so an unauthenticated caller gets 404 too.
    """
    if not settings.mcp_enabled:
        raise NotFoundError("Not found")


router = APIRouter(
    prefix="/api/v1/users/me/mcp-tokens",
    tags=["mcp"],
    dependencies=[Depends(_require_mcp_enabled)],
)


@router.post(
    "",
    response_model=McpTokenCreated,
    status_code=status.HTTP_201_CREATED,
)
async def create_mcp_token_endpoint(
    body: McpTokenCreate,
    user: User = Depends(get_current_user_write),
    session: AsyncSession = Depends(get_db_session),
) -> McpTokenCreated:
    """Mint a personal token. The response is the only place it ever appears.

    409 mcp_token_limit_reached: the student already holds the maximum of
    live tokens (settings.mcp_tokens_max_active_per_user).
    409 mcp_token_name_taken: a live token of the student already has this
    name, ignoring case (BE-139).
    """
    token, row = await create_mcp_token(user, body, session)
    return McpTokenCreated(token=token, item=McpTokenItem.model_validate(row))


@router.get("", response_model=McpTokenListResponse)
async def list_mcp_tokens_endpoint(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_reader),
) -> McpTokenListResponse:
    """The student's tokens, revoked included, newest first; no secret."""
    rows = await list_mcp_tokens(user, session)
    return McpTokenListResponse(items=[McpTokenItem.model_validate(r) for r in rows])


@router.post("/{token_id}/revoke", response_model=McpTokenItem)
async def revoke_mcp_token_endpoint(
    token_id: UUID,
    user: User = Depends(get_current_user_write),
    session: AsyncSession = Depends(get_db_session),
) -> McpTokenItem:
    """Revoke one of the student's own tokens.

    Repeating it is not an error: an already revoked own token comes back as
    it stands, with its original revoked_at. 404 mcp_token_not_found for
    anything else.
    """
    row = await revoke_mcp_token(user, token_id, session)
    return McpTokenItem.model_validate(row)
