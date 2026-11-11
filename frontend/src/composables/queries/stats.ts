// =============================================================================
// VELO Frontend -- the signed-in user's stats for Pinia Colada (FE-166 step 2)
// =============================================================================
//
// Attended practices, hours and the unread-messages dot (`GET
// /bookings/me/stats`), read by the dashboard and the profile and warmed by
// the idle prefetch (router/dataPrefetch.ts). One definition, so the prefetch
// fills exactly the entry the screens read. Persisted: a reload renders the
// last known numbers at once instead of 0 -> N, then revalidates.
// =============================================================================

import { defineQueryOptions } from '@pinia/colada'
import { getMyStats } from '@/api/bookings'
import { keys } from '@/composables/queries/keys'

/** Stats change only after an attended practice: cached for minutes. */
export const STATS_STALE_MS = 5 * 60_000

/**
 * Query options for the attended-practice stats of the signed-in user.
 *
 * @param staleTime - the profile passes 0: it shows the unread dot, which
 *   must be current on every visit.
 */
export const myStatsQuery = defineQueryOptions((staleTime: number = STATS_STALE_MS) => ({
  key: keys.bookings.myStats(),
  query: () => getMyStats(),
  staleTime,
  meta: { persist: true },
}))
