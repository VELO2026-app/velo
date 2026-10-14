// =============================================================================
// The MCP server's address, as the "AI connections" screen shows it (BE-150)
// =============================================================================
//
// <API base>/mcp -- the same base the app's own API client talks to
// (VITE_API_BASE_URL), so the address is the one this app is served by.
//
// FAILS CLOSED, like zoomStartRedirectUrl (api/practices.ts): no base, no
// address. Falling back to window.location.origin would hand the student
// the FRONTEND's address, which serves no /mcp at all -- a connector that
// looks configured and never connects.
// =============================================================================

export const MCP_PATH = '/mcp'

/** `base` without any trailing slash, plus /mcp; null when there is no base. */
export function mcpServerUrl(base: string | undefined | null): string | null {
  const trimmed = (base ?? '').trim().replace(/\/+$/, '')
  return trimmed ? `${trimmed}${MCP_PATH}` : null
}

/** The value of an `Authorization` header for a personal token: exactly one
 * "Bearer " in front, for clients that take the header value whole. */
export function bearerHeaderValue(token: string): string {
  return `Bearer ${token}`
}
