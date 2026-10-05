// =============================================================================
// VELO Frontend -- Waitlist API (Links, 3 October)
// =============================================================================
//
// The «Освободилось место» notification (waitlist.spot_available) carries
// confirm_waitlist with waitlist_id. Until now nothing on the front could
// confirm it; WaitlistConfirmView does, through these two calls.
// =============================================================================

import { api } from '@/api/client'
import { buildQuery } from '@/api/utils'
import type { PaginatedWaitlistResponse, WaitlistConfirmResponse } from '@/api/types'

/** GET /waitlist/me -- my entries with their practice (newest first). */
export function getMyWaitlist(
  query: { limit?: number; offset?: number } = {},
): Promise<PaginatedWaitlistResponse> {
  const qs = buildQuery({ limit: query.limit, offset: query.offset })
  return api.get<PaginatedWaitlistResponse>(`/api/v1/waitlist/me${qs}`)
}

/** POST /waitlist/{id}/confirm -- 201 + booking on success. 400 when the
 *  hold expired (entry -> expired) or the spot was taken meanwhile (entry ->
 *  waiting again), or the entry is not a notified one; 404 for an entry that
 *  is not mine. The 400 body does not say WHICH -- re-read the entry. */
export function confirmWaitlist(id: string): Promise<WaitlistConfirmResponse> {
  return api.post<WaitlistConfirmResponse>(`/api/v1/waitlist/${id}/confirm`)
}
