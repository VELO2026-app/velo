# =============================================================================
# VELO Backend -- MCP token schemas (BE-138)
# =============================================================================
#
# THE SECRET CROSSES THE API EXACTLY ONCE: McpTokenCreated.token, in the
# response to the create call. McpTokenItem -- the list row, the revoke
# response and the `item` of the create response -- has no field that could
# carry it, and no field for the hash either. Adding one would be the leak.
# =============================================================================

from datetime import datetime
from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from app.modules.mcp.models import McpScope, McpTokenKind

# Stripped BEFORE min_length (the CuratorGroupNameStr reasoning): a name of
# spaces is a 422, not a token labelled " ".
McpTokenNameStr = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)
]


class McpTokenCreate(BaseModel):
    """Body of POST /api/v1/users/me/mcp-tokens.

    scopes omitted -> all three (owner ruling). An explicit list must be
    non-empty and must not repeat a scope: an empty list would mint a token
    that can do nothing, and a repeat means the client built the list wrong
    -- both are refused rather than silently "fixed".
    """

    name: McpTokenNameStr
    scopes: list[McpScope] | None = Field(default=None, min_length=1)

    @field_validator("scopes")
    @classmethod
    def _no_repeated_scope(cls, value: list[McpScope] | None) -> list[McpScope] | None:
        if value is not None and len(set(value)) != len(value):
            raise ValueError("scopes must not repeat")
        return value


class McpTokenItem(BaseModel):
    """One token as the student sees it in the list -- never the secret.

    kind (BE-141): a personal token, or a connection an AI client obtained
    through OAuth. For an OAuth connection `prefix` is that of its current
    refresh token -- it changes on every refresh and means nothing to the
    student, so the screen shows it for personal tokens only.
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    kind: McpTokenKind
    name: str
    prefix: str
    scopes: list[McpScope]
    created_at: datetime
    last_used_at: datetime | None
    revoked_at: datetime | None


class McpTokenCreated(BaseModel):
    """Response of the create call: the token, shown this once, and its row."""

    token: str
    item: McpTokenItem


class McpScopeLabel(BaseModel):
    """A scope and its description (BE-148), from SCOPE_ACTIONS -- the one
    place it is written; the screen keeps no copy."""

    scope: McpScope
    label: str


class McpTokenListResponse(BaseModel):
    """All of the student's tokens, revoked ones included, newest first --
    plus what the "AI connections" screen needs around them (BE-150).

    oauth_connect_available: this server lets an AI client connect with the
        button (OAuth configured). When false the screen does not promise
        that way and points at a personal token.
    scope_labels: every scope with its description, in the canonical order
        -- the screen's checkboxes and each row's summary.
    """

    items: list[McpTokenItem]
    oauth_connect_available: bool
    scope_labels: list[McpScopeLabel]
