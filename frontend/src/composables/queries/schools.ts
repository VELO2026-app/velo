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
// staleTime 0: the page revalidates on every visit, as it did before the
// pilot -- the cached copy only removes the spinner. Purchases and the other
// booking mutations are not in the invalidation map yet (./invalidation.ts),
// so a longer window would show a stale is_paid / is_booked mark after a
// booking made elsewhere. Raise it once those mutations invalidate
// `keys.practices.root()`.
//
// Window focus (a return to Telegram): only the page payload revalidates,
// the feed does not -- with staleTime 0 Colada's default (refetch when
// stale) would send BOTH GETs on every return. The page carries the viewer's
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
    staleTime: 0,
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
