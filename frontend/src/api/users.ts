// =============================================================================
// VELO Frontend -- Users API
// =============================================================================
//
// Typed wrappers over api.get/patch for the current-user profile endpoints.
//
// Backend endpoints:
//   GET    /api/v1/users/me  -- current user profile
//   PATCH  /api/v1/users/me  -- partial profile update
//   DELETE /api/v1/users/me  -- delete account (MVP: resets onboarding)
//   GET    /api/v1/users/timezones -- time zone catalog for the picker (BE-157)
//
// UserResponse / UserUpdate are generated from the backend OpenAPI schema
// (see api/generated.ts, refreshed on `velo update` / `velo gen-types`).
// onboarding_completed is part of both: it lives in the credentials JSONB
// on the backend but is surfaced as a plain bool on UserResponse and is
// settable via UserUpdate. phone / bio follow the same JSONB pattern and are
// likewise surfaced on UserResponse and settable via UserUpdate.
// =============================================================================

import { api } from '@/api/client'
import type { TimezoneCatalogResponse, UserResponse, UserUpdate, UserRole } from '@/api/types'

/**
 * Fetch the authenticated user's profile.
 */
export function getMe(): Promise<UserResponse> {
  return api.get<UserResponse>('/api/v1/users/me')
}

/**
 * Every time zone name the profile accepts, with the other spellings it
 * accepts and Russian CLDR captions -- what the timezone picker is built from
 * (composables/useTimezoneCatalog.ts).
 */
export function getTimezoneCatalog(): Promise<TimezoneCatalogResponse> {
  return api.get<TimezoneCatalogResponse>('/api/v1/users/timezones')
}

/**
 * Partially update the authenticated user's profile.
 * Only the fields present in `body` are changed.
 *
 * Used by the profile screen and by the welcome onboarding flow
 * (which sends { timezone, onboarding_completed: true } on completion).
 */
export function updateMe(body: UserUpdate): Promise<UserResponse> {
  return api.patch<UserResponse>('/api/v1/users/me', body)
}

/**
 * Delete the authenticated user's account.
 *
 * MVP semantics (backend): this resets the onboarding flag rather than
 * erasing data or deactivating the account, so the next login sends the user
 * back through the welcome flow with their old data intact. It also revokes
 * every live MCP token of the user (BE-138). The caller should
 * log the user out afterwards. Returns 204 (no body).
 */
export function deleteMe(): Promise<void> {
  return api.delete('/api/v1/users/me')
}

/**
 * Switch the authenticated user's own role (capability-derived, A1=Б).
 *
 * Backend: POST /api/v1/users/me/role — always on (the ROLE_SWITCH_ENABLED
 * flag is gone, №256). The allowed target set is derived server-side from
 * the caller's role + master capability (verified master ↔ user; admin —
 * all three via the home_role round-trip marker); targets outside the
 * derived set → 403 role_not_allowed. Returns the updated profile.
 */
export function switchRole(role: UserRole): Promise<UserResponse> {
  return api.post<UserResponse>('/api/v1/users/me/role', { role })
}
