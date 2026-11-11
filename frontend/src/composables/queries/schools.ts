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
// every mutation that changes a practice's booking marks (purchase, waitlist
// confirmation, cancellation) invalidates `keys.practices.root()`
// (./invalidation.ts, FE-166 step 1), so a cached feed is never stale about
// this app's own bookings.
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
import { getSchoolPage, getSchoolPractices } from '@/api/schools'
import { keys } from '@/composables/queries/keys'

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
