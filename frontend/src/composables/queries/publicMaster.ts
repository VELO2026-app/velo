// =============================================================================
// VELO Frontend -- a master's public page on Pinia Colada (FE-166 step 6)
// =============================================================================
//
// MasterPublicView reads two independent entries: the master's public
// profile and their next scheduled practices. Each master id has its own
// entries, so after a route reuse (master A's page -> master B's) a slow
// answer for A lands in A's entry and never on B's screen -- the guard the
// screen used to keep by hand (loadEpoch).
//
// staleTime: the profile 0 -- it revalidates on every visit, the cached copy
// only removes the loader (a master's methods and counts change outside this
// app). The practices take the default window: every booking made in this
// app invalidates `keys.practices.root()` (./invalidation.ts).
// =============================================================================

import { defineQueryOptions } from '@pinia/colada'
import { getPublicMaster } from '@/api/masters'
import { getPractices } from '@/api/practices'
import type { PracticeResponse } from '@/api/types'
import { keys } from '@/composables/queries/keys'

/** At most this many upcoming practices on a master's public page (owner 2026-09-30). */
export const MASTER_UPCOMING_LIMIT = 5

/** Query options for a master's public profile (`GET /masters/{id}`). */
export const publicMasterQuery = defineQueryOptions((masterId: string) => ({
  key: keys.masters.public(masterId),
  query: () => getPublicMaster(masterId),
  staleTime: 0,
}))

/**
 * Query options for a master's next scheduled practices, nearest first, at
 * most MASTER_UPCOMING_LIMIT.
 *
 * @remarks
 * Owner 2026-10-03: in the curator's school context (`schoolId` set) only the
 * master's practices in THAT school are listed. The public feed has no
 * school parameter, so a larger page is fetched and filtered by the
 * practices' own `school_id` (null on personal practices, a foreign school's
 * id otherwise). The cap is enforced here too: the spec is "up to 5 cards",
 * whatever the server's limit does.
 */
export const masterUpcomingQuery = defineQueryOptions(
  ({ masterId, schoolId }: { masterId: string; schoolId: string }) => ({
    key: keys.practices.masterUpcoming(masterId, schoolId),
    query: async (): Promise<PracticeResponse[]> => {
      const res = await getPractices(
        { master_id: masterId, status: 'scheduled', sort_by: 'scheduled_at', sort_order: 'asc' },
        schoolId ? 50 : MASTER_UPCOMING_LIMIT,
        0,
      )
      const items = schoolId ? res.items.filter((p) => p.school_id === schoolId) : res.items
      return items.slice(0, MASTER_UPCOMING_LIMIT)
    },
  }),
)
