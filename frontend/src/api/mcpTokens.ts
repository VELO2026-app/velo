// =============================================================================
// VELO Frontend -- MCP personal tokens API (BE-138)
// =============================================================================
//
// Backend endpoints (app/modules/mcp/router.py):
//   POST /api/v1/users/me/mcp-tokens                   -- mint; the token, once
//   GET  /api/v1/users/me/mcp-tokens                   -- list, never the secret
//   POST /api/v1/users/me/mcp-tokens/{id}/revoke       -- revoke own; idempotent
//
// THE TOKEN STRING IS NEVER STORED BY THE APP: createMcpToken's result goes
// to the caller, which shows it once and drops it (AiConnectionsView). Not a
// store, not localStorage/sessionStorage.
//
// With the MCP killswitch off every endpoint answers 404 (code not_found);
// the screen shows "unavailable" for that.
// =============================================================================

import { api } from '@/api/client'
import type { McpScope, McpTokenCreated, McpTokenItem, McpTokenListResponse } from '@/api/types'

const BASE = '/api/v1/users/me/mcp-tokens'

/** Mint a token. `scopes` omitted -> the backend grants all three. */
export function createMcpToken(name: string, scopes?: McpScope[]): Promise<McpTokenCreated> {
  return api.post<McpTokenCreated>(BASE, scopes ? { name, scopes } : { name })
}

/** The user's tokens, revoked included, newest first. */
export function listMcpTokens(): Promise<McpTokenListResponse> {
  return api.get<McpTokenListResponse>(BASE)
}

/** Revoke one of the user's own tokens; repeating it is not an error. */
export function revokeMcpToken(tokenId: string): Promise<McpTokenItem> {
  return api.post<McpTokenItem>(`${BASE}/${tokenId}/revoke`)
}
