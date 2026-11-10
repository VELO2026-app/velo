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
// =============================================================================

import { defineQueryOptions } from '@pinia/colada'
import { getSchoolPage, getSchoolPractices } from '@/api/schools'
import { keys } from '@/composables/queries/keys'

/** Query options for the school page payload (`GET /schools/{id}`). */
export const schoolPageQuery = defineQueryOptions((schoolId: string) => ({
  key: keys.schools.detail(schoolId),
  query: () => getSchoolPage(schoolId),
  staleTime: 0,
}))

/** Query options for the first `limit` upcoming practices of a school (`GET /schools/{id}/practices`). */
export const schoolFeedQuery = defineQueryOptions(
  ({ schoolId, limit }: { schoolId: string; limit: number }) => ({
    key: keys.practices.schoolFeed(schoolId, limit),
    query: async () => (await getSchoolPractices(schoolId, limit, 0)).items,
    staleTime: 0,
  }),
)
