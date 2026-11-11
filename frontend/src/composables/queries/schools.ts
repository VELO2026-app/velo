// =============================================================================
// VELO Frontend -- school queries for Pinia Colada (FE-157 4F pilot)
// =============================================================================
//
// The school page (views/user/SchoolPageView.vue) reads two independent
// entries: the page payload and the practices feed. Each id has its own
// entries, so a slow answer for the previous school lands in that school's
// entry and never on the current screen -- the guard the page used to keep
// by hand (loadEpoch).
//
// staleTime: the page payload 0 -- it revalidates on every visit, the cached
// copy only removes the spinner; it carries the viewer's relation, which
// changes outside this app. The feed takes the default window (setup.ts):
// every mutation of this app that changes a practice in it -- a booking made
// or cancelled, a waitlist spot confirmed, the master's own practice
// created, edited, cancelled or deleted -- invalidates `keys.practices.root()`
// (./invalidation.ts, FE-166 step 1). What the window can still hide is
// another person's change: seats taken by others, another master's edit.
//
// Window focus (a return to Telegram): only the page payload revalidates,
// the feed does not -- Colada's default (refetch when stale) would send
// both GETs on a return after the window. The page carries the viewer's
// relation, which changes outside this screen (an invite accepted in the bot
// chat, a curator's removal); the feed's booking marks change through this
// app's own mutations, which invalidate it (./invalidation.ts).
//
// Leaving a school (forgetSchool) drops both entries: the cached copy holds
// the member relation, and a reopen would paint the member actions for a
// moment before the refetch answers.
// =============================================================================

import { defineQueryOptions, type QueryCache } from '@pinia/colada'
import { getMySchools, getSchoolPage, getSchoolPractices, getSchools } from '@/api/schools'
import { keys } from '@/composables/queries/keys'
import type { SchoolMineItem } from '@/api/types'

/** Query options for the school page payload (`GET /schools/{id}`). */
export const schoolPageQuery = defineQueryOptions((schoolId: string) => ({
  key: keys.schools.detail(schoolId),
  query: () => getSchoolPage(schoolId),
  staleTime: 0,
  refetchOnWindowFocus: true,
}))

/** Query options for the first `limit` upcoming practices of a school (`GET /schools/{id}/practices`). */
export const schoolFeedQuery = defineQueryOptions(
  ({ schoolId, limit }: { schoolId: string; limit: number }) => ({
    key: keys.practices.schoolFeed(schoolId, limit),
    query: async () => (await getSchoolPractices(schoolId, limit, 0)).items,
    refetchOnWindowFocus: false,
  }),
)

/**
 * Drop every cached entry of one school (page payload and feeds of any limit).
 *
 * @remarks
 * For after the viewer left the school. An entry nobody holds is removed, so
 * the next visit starts from the loader, not from the old relation. One still
 * held by a screen cannot be removed (it would keep a detached copy); it is
 * invalidated instead and refetches at once.
 */
export function forgetSchool(queryCache: QueryCache, schoolId: string): void {
  const entries = [
    ...queryCache.getEntries({ key: keys.schools.detail(schoolId) }),
    ...queryCache.getEntries({ key: ['practices', 'list', { schoolId }] }),
  ]
  for (const entry of entries) {
    if (entry.active) void queryCache.invalidate(entry)
    else queryCache.remove(entry)
  }
}

// =============================================================================
// School lists (FE-166 step 2: moved from the in-house cache)
// =============================================================================
//
// Both lists revalidate on every visit (staleTime 0): a school created or
// joined a moment ago is there on the next one; the cached copy only removes
// the spinner. Each is two parallel calls, one payload split: /mine feeds the
// rows (relation and transfer_offered ride only there), the curator list
// carries the create right. allSettled, because the two calls are NOT equal:
// /mine failing means there is no screen, while the flag call failing only
// means no «+» -- rows plus the honest no-right hint beat an error state over
// data already held.

/** Payload of a schools list screen: the rows, plus the school-create right. */
export interface SchoolsList {
  schools: SchoolMineItem[]
  canCreate: boolean
}

/**
 * Query options for the user zone's schools tab (SchoolsView): the schools I
 * participate in, plus the create right. Persisted across reloads.
 *
 * @remarks
 * The flag lives on the master surface, which answers 403 outside master
 * mode (FE-93), so it is only dialed there -- anywhere else false is the
 * honest «+». The curated rows /mine still returns (relation is
 * role-independent) belong to the master hub's curator tab and would 403
 * their way through this zone's screens, so they are dropped here.
 */
export const userSchoolsQuery = defineQueryOptions((role: string) => ({
  key: keys.schools.mine('participant', role),
  query: async (): Promise<SchoolsList> => {
    const [mineRes, listRes] = await Promise.allSettled([
      getMySchools(),
      role === 'master' ? getSchools() : Promise.resolve(null),
    ])
    if (mineRes.status === 'rejected') throw mineRes.reason
    return {
      schools: mineRes.value.items.filter((g) => g.relation !== 'curator'),
      canCreate:
        listRes.status === 'fulfilled' && listRes.value
          ? (listRes.value.can_create_schools ?? false)
          : false,
    }
  },
  staleTime: 0,
  meta: { persist: true },
}))

/** Query options for the master's schools hub (MasterSchoolsView): every school of mine, plus the create right. */
export const masterSchoolsQuery = defineQueryOptions(() => ({
  key: keys.schools.mine('master-hub'),
  query: async (): Promise<SchoolsList> => {
    const [mineRes, listRes] = await Promise.allSettled([getMySchools(), getSchools()])
    if (mineRes.status === 'rejected') throw mineRes.reason
    return {
      schools: mineRes.value.items,
      canCreate:
        listRes.status === 'fulfilled' ? (listRes.value.can_create_schools ?? false) : false,
    }
  },
  staleTime: 0,
}))
