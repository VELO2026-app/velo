// =============================================================================
// VELO Frontend -- the admin zone's catalogs on Pinia Colada (FE-181)
// =============================================================================
//
// The method catalog editor, the platform's schools, the promo oversight
// list and one practice's oversight detail. Each screen used to fetch on
// mount into its own refs; the reads now live here, the writes go through
// useAdminMutation (./adminInvalidation.ts).
//
// Freshness: every read is asked again on each visit (staleTime 0) --
// other people create schools, promos and bookings all the time -- while
// the cached answer stays on screen. Errors stay raw on the query (ADR).
// =============================================================================

import {
  defineInfiniteQueryOptions,
  defineQueryOptions,
  setInfiniteQueryData,
  type QueryCache,
} from '@pinia/colada'
import { getAdminPracticeDetail, getAdminPromos, getAdminZoomAttendance } from '@/api/admin'
import type { AdminPaginatedPromosResponse, AdminPromoTypeFilter } from '@/api/admin'
import { getAdminSchools } from '@/api/schools'
import { getFullTaxonomy } from '@/api/taxonomy'
import type { PaginatedAdminSchoolsResponse } from '@/api/types'
import { adminKeys } from '@/composables/queries/adminKeys'

/** Query options for the full method catalog, inactive items included (`GET /admin/taxonomy`). */
export const adminTaxonomyQuery = defineQueryOptions(() => ({
  key: adminKeys.taxonomy(),
  query: async () => (await getFullTaxonomy()).directions,
  staleTime: 0,
}))

/** Schools per page of `GET /admin/schools`. */
export const ADMIN_SCHOOLS_PAGE_SIZE = 100

/** Infinite query options for every school of the platform (`GET /admin/schools`). */
export const adminSchoolsQuery = defineInfiniteQueryOptions(() => ({
  key: adminKeys.schools(),
  query: ({ pageParam }: { pageParam: number }) =>
    getAdminSchools(ADMIN_SCHOOLS_PAGE_SIZE, pageParam),
  initialPageParam: 0,
  getNextPageParam: (
    last: PaginatedAdminSchoolsResponse,
    pages: PaginatedAdminSchoolsResponse[],
  ) => {
    const loaded = pages.reduce((n, page) => n + page.items.length, 0)
    return loaded < last.total ? loaded : null
  },
  staleTime: 0,
}))

/** A tab of the promo oversight list. */
export type AdminPromoFilter = 'all' | 'master' | 'company' | 'inactive'

/** Promos per page of `GET /admin/promos`. */
export const ADMIN_PROMOS_PAGE_SIZE = 20

/**
 * The request parameters of one tab -- server-side filtered (type /
 * is_active): a promo list can grow past one page per master.
 */
function promoParams(filter: AdminPromoFilter): {
  type?: AdminPromoTypeFilter
  isActive?: boolean
} {
  if (filter === 'master') return { type: 'master' }
  if (filter === 'company') return { type: 'company' }
  if (filter === 'inactive') return { isActive: false }
  return {}
}

/** Infinite query options for one tab of the promo oversight list (`GET /admin/promos`). */
export const adminPromosQuery = defineInfiniteQueryOptions((filter: AdminPromoFilter) => ({
  key: adminKeys.promos(filter),
  query: ({ pageParam }: { pageParam: number }) => {
    const { type, isActive } = promoParams(filter)
    return getAdminPromos(type, isActive, ADMIN_PROMOS_PAGE_SIZE, pageParam)
  },
  initialPageParam: 0,
  getNextPageParam: (last: AdminPaginatedPromosResponse, pages: AdminPaginatedPromosResponse[]) => {
    const loaded = pages.reduce((n, page) => n + page.items.length, 0)
    return loaded < last.total ? loaded : null
  },
  staleTime: 0,
}))

/** Query options for one practice with its roster (`GET /admin/practices/{id}`). */
export const adminPracticeQuery = defineQueryOptions((practiceId: string) => ({
  key: adminKeys.practice(practiceId),
  query: () => getAdminPracticeDetail(practiceId),
  staleTime: 0,
}))

/**
 * Query options for a practice's meeting status and attendance match
 * (`GET /admin/practices/{id}/zoom-attendance`). Best-effort: the screen
 * shows it only once it answered.
 */
export const adminPracticeAttendanceQuery = defineQueryOptions((practiceId: string) => ({
  key: adminKeys.practiceAttendance(practiceId),
  query: () => getAdminZoomAttendance(practiceId),
  staleTime: 0,
}))

/**
 * Show a promo as inactive in every promo list held, at once -- before the
 * invalidation's refetch answers (the card's badge flips under the toast).
 */
export function markPromoInactive(queryCache: QueryCache, promoId: string): void {
  for (const entry of queryCache.getEntries({ key: adminKeys.promosAll() })) {
    if (entry.state.value.data === undefined) continue
    setInfiniteQueryData<AdminPaginatedPromosResponse, number>(queryCache, entry.key, (data) => ({
      pageParams: data?.pageParams ?? [],
      pages: (data?.pages ?? []).map((page) => ({
        ...page,
        items: page.items.map((p) => (p.id === promoId ? { ...p, is_active: false } : p)),
      })),
    }))
  }
}
