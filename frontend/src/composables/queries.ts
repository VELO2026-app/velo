// =============================================================================
// VELO Frontend -- shared screen queries (useQuery options)
// =============================================================================
// Query options used by a screen AND by the idle data prefetch
// (router/dataPrefetch.ts): one definition, so the prefetch fills exactly the
// entry the screen reads.
// =============================================================================

import { getCuratorGroups, getMyCuratorGroups } from '@/api/curatorGroups'
import { getMyStats } from '@/api/bookings'
import { queryKeys } from '@/composables/queryKeys'
import type { QueryOptions } from '@/composables/useQuery'
import type { CuratorGroupMineItem, UserStatsResponse } from '@/api/types'

export interface UserSchools {
  schools: CuratorGroupMineItem[]
  canCreate: boolean
}

/** «Школы» tab (SchoolsView): the schools I participate in + the create right. */
export function userSchoolsQuery(role: string): QueryOptions<UserSchools> {
  return {
    key: ['curatorGroups', 'mine', 'participant', role],
    query: async () => {
      // Two parallel calls, one payload split -- the MasterCuratorGroupsView
      // recipe verbatim: /mine feeds the rows (relation + transfer_offered ride
      // only here), the curator list carries the create right. allSettled,
      // because the two calls are NOT equal: /mine failing means there is no
      // screen, while the flag call failing only means no «+». The flag lives
      // on the master surface, which answers 403 outside master mode (FE-93),
      // so it is only dialed there -- anywhere else false is the honest «+».
      const [mineRes, listRes] = await Promise.allSettled([
        getMyCuratorGroups(),
        role === 'master' ? getCuratorGroups() : Promise.resolve(null),
      ])
      if (mineRes.status === 'rejected') throw mineRes.reason
      // FE-93: this zone lists the schools I PARTICIPATE in. The curated rows
      // /mine still returns (relation is role-independent) are the master
      // list's «Я куратор» section -- and each would 403 its way through this
      // zone's screens.
      return {
        schools: mineRes.value.items.filter((g) => g.relation !== 'curator'),
        canCreate:
          listRes.status === 'fulfilled' && listRes.value
            ? (listRes.value.can_create_groups ?? false)
            : false,
      }
    },
    staleTime: 0,
    persist: true,
  }
}

/** Attended practices + hours (dashboard, profile). Cached for minutes:
 * they change only after an attended practice. */
export const STATS_STALE_MS = 5 * 60_000

export function myStatsQuery(staleTime = STATS_STALE_MS): QueryOptions<UserStatsResponse> {
  return { key: queryKeys.myStats(), query: getMyStats, staleTime, persist: true }
}
