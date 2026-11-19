// =============================================================================
// VELO Frontend -- the admin zone on Pinia Colada (FE-181)
// =============================================================================
//
// Every query and mutation an admin screen uses, by area:
//
//   - shared: onFailedRequest (how a screen tells a failed request) and the
//     admin mutation map with useAdminMutation;
//   - the shell and the dashboard: the counters (`GET /admin/stats` + the
//     count of reports awaiting moderation: the tab badges, the banners,
//     the lists' "all" badges -- one entry, so the shell and the screens
//     read the same answer) and the period window (the overview cards and
//     the four engagement / revenue figures, one entry per (period, offset));
//   - the platform's practices and participants lists;
//   - the catalogs: the method catalog editor, the schools, the promo
//     oversight list, one practice's oversight detail.
//
// ONE module on purpose, not one per area: Rollup puts every module into a
// chunk by the set of routes that import it, and each extra shared chunk
// adds its name and its importers' indices to the preload map shipped in
// the startup chunk every user loads. A screen importing one area file
// directly (a re-export does not help -- Rollup traces it to the source)
// made the start heavier for everyone. The keys are in ./adminKeys.ts,
// imported only from here, so they share this chunk.
//
// Freshness: the counters keep the default window (queries/setup.ts) and
// the admin's own actions invalidate them (ADMIN_INVALIDATES). Everything
// else is asked again on every visit (staleTime 0) -- other people move
// these numbers all the time -- while the cached answer stays on screen.
//
// Errors stay raw on the query (ADR); the screens turn them into text, and
// tell the admin through onFailedRequest -- once per request that failed,
// never for an old error an entry still holds.
// =============================================================================

import { computed, watch, type Ref } from 'vue'
import {
  defineInfiniteQueryOptions,
  defineQueryOptions,
  setInfiniteQueryData,
  useMutation,
  useQuery,
  useQueryCache,
  type EntryKey,
  type QueryCache,
} from '@pinia/colada'
import {
  getAdminPracticeDetail,
  getAdminPractices,
  getAdminPromos,
  getAdminRevenue,
  getAdminStats,
  getAdminStatsOverview,
  getAdminZoomAttendance,
  getCheckinMetric,
  getFeedbackMetric,
  getParticipants,
  getReports,
  getReturnMetric,
  type AdminPaginatedPromosResponse,
  type AdminPracticeScope,
  type AdminPromoTypeFilter,
} from '@/api/admin'
import { getAdminSchools } from '@/api/schools'
import { getFullTaxonomy } from '@/api/taxonomy'
import type {
  AdminRevenueResponse,
  AdminStatsOverviewResponse,
  AdminStatsResponse,
  CheckinMetricResponse,
  FeedbackMetricResponse,
  PaginatedAdminSchoolsResponse,
  PaginatedParticipantsResponse,
  ReturnMetricResponse,
} from '@/api/types'
import { adminKeys } from '@/composables/queries/adminKeys'
import { invalidateKeys } from '@/composables/queries/invalidation'
import { screenQueryState } from '@/composables/queries/screenState'
import { useQueryScopeStore } from '@/composables/queries/setup'

// =============================================================================
// Shared: telling a failed request
// =============================================================================
/** The parts of a Colada query that tell whether a request failed. */
interface RequestState {
  error: Readonly<Ref<unknown>>
  asyncStatus: Readonly<Ref<'idle' | 'loading'>>
}

/**
 * Call `tell` when a request of the query settles failed -- the first
 * failure in a row only: the next one is told after a request succeeded
 * again.
 *
 * @remarks
 * Only a request that settles is told: switching back to a period or a
 * filter whose last answer failed shows that error, it does not tell it
 * again. And one run of failures is one toast: while the server is down,
 * every return to the app (Colada refetches on focus and reconnect), every
 * screen reading the same entry and every retry asks again -- the screen
 * already shows the failure (an error rung, "—"), the admin was told once.
 */
export function onFailedRequest(query: RequestState, tell: (error: unknown) => void): void {
  let failing = false
  watch(query.asyncStatus, (now, before) => {
    if (before !== 'loading' || now !== 'idle') return
    const error = query.error.value
    if (error == null) {
      failing = false
      return
    }
    if (failing) return
    failing = true
    tell(error)
  })
}

// =============================================================================
// Shared: the admin mutation map
// =============================================================================
//
// What each admin mutation makes stale, written down once per mutation, with
// a test per row (./invalidation.test.ts) -- the admin half of
// ./invalidation.ts, kept here for the startup chunk's sake (see the
// header). A row may name user-zone prefixes too (./keys.ts) when an admin
// action changes what the admin's own user zone shows.
//
// useAdminMutation is the one way an admin screen runs a mutation: the
// request, then -- for the session it was started in only -- the row's
// invalidation.

//
// The admin half of ./invalidation.ts: what each admin mutation makes stale,
// written down once per mutation, with a test per row
// (./invalidation.test.ts). Kept apart for the same reason as ./adminKeys.ts
// -- the admin zone loads lazily, ./invalidation.ts is in the startup chunk.
// A row may name user-zone prefixes too (./keys.ts) when an admin action
// changes what the admin's own user zone shows.
//
// useAdminMutation is the one way an admin screen runs a mutation: the
// request, then -- for the session it was started in only -- the row's
// invalidation.
// =============================================================================

/** Each admin mutation and the query-key prefixes it makes stale. */
export const ADMIN_INVALIDATES = {
  /**
   * `POST /admin/taxonomy/directions`, `POST /admin/taxonomy/directions/{id}/styles`,
   * `PATCH /admin/taxonomy/directions/{id}`, `PATCH /admin/taxonomy/styles/{id}`:
   * an item added, renamed, switched off or on -- the catalog editor's tree.
   */
  changeTaxonomy: [adminKeys.taxonomy()],
  /** `PATCH /admin/promos/{id}/deactivate`: the promo turns inactive -- every tab of the promo list. */
  deactivatePromo: [adminKeys.promosAll()],
} as const satisfies Record<string, readonly EntryKey[]>

/** Name of an admin mutation that has a row in `ADMIN_INVALIDATES`. */
export type AdminMutationName = keyof typeof ADMIN_INVALIDATES

/** Options of `useAdminMutation`. */
export interface AdminMutationOptions<TVars, TData> {
  /**
   * Write the answer into the cache at once, before the invalidation's
   * refetch answers (a card that must flip under the toast).
   */
  write?: (data: TData, vars: TVars) => void
  /**
   * Whether `mutateAsync` waits for the refetches on screen (default true:
   * the control's spinner covers the list catching up). Off when the screen
   * already shows the outcome through `write`.
   */
  waitForRefetch?: boolean
}

/**
 * An admin mutation for a screen: runs `mutation`, then, when it succeeded
 * in the session it was started in, `write` and the invalidation of the
 * mutation's row.
 *
 * @remarks
 * `mutateAsync` rejects with the raw API error (the screen turns it into
 * text) and then nothing is invalidated. A session that ended while the
 * request was in flight gets nothing: its caches are already emptied
 * (queries/setup.ts).
 */
export function useAdminMutation<TVars, TData>(
  name: AdminMutationName,
  mutation: (vars: TVars) => Promise<TData>,
  { write, waitForRefetch = true }: AdminMutationOptions<TVars, TData> = {},
) {
  const queryCache = useQueryCache()
  const scope = useQueryScopeStore()
  return useMutation({
    onMutate: () => ({ sessionGeneration: scope.generation() }),
    mutation,
    async onSuccess(data: TData, vars: TVars, { sessionGeneration }) {
      if (sessionGeneration !== scope.generation()) return
      write?.(data, vars)
      const invalidation = invalidateKeys(queryCache, ADMIN_INVALIDATES[name])
      if (waitForRefetch) await invalidation
    },
  })
}

// =============================================================================
// The shell, the dashboard and the platform lists
// =============================================================================

/** The period window of the dashboard and its drill-ins. */
export type AdminPeriod = 'week' | 'month'

/** One period window: the granularity and the stepper offset (0 = current, -1 = previous ...). */
export interface AdminPeriodWindow {
  period: AdminPeriod
  offset: number
}

/** The admin counters as one entry holds them. */
export interface AdminCounters {
  /** `GET /admin/stats`: platform totals and pending verifications / method changes. */
  stats: AdminStatsResponse
  /** Reports awaiting moderation (the total of `GET /admin/reports?status=pending`). */
  pendingReports: number
}

/** Query options for the admin counters (see the header). */
export const adminStatsQuery = defineQueryOptions(() => ({
  key: adminKeys.stats(),
  query: async (): Promise<AdminCounters> => {
    const [stats, reports] = await Promise.all([
      getAdminStats(),
      getReports('pending', undefined, 1, 0),
    ])
    return { stats, pendingReports: reports.total }
  },
}))

/**
 * The admin counters for a screen or the shell.
 *
 * @remarks
 * Every number reads 0 / null while nothing has answered: a badge or a
 * banner simply does not show.
 */
export function useAdminStats() {
  const query = useQuery(adminStatsQuery)
  const stats = computed<AdminStatsResponse | null>(() => query.data.value?.stats ?? null)
  return {
    /** The platform totals, or null until an answer. */
    stats,
    /** Masters awaiting verification. */
    pendingVerifications: computed(() => stats.value?.pending_verifications ?? 0),
    /** Pending master method-change requests. */
    pendingMethodChanges: computed(() => stats.value?.pending_method_changes ?? 0),
    /** Reports awaiting moderation. */
    pendingModeration: computed(() => query.data.value?.pendingReports ?? 0),
    /** Nothing held and a request in flight. */
    loading: screenQueryState(query).loading,
    /** The raw error of the last request, or null. */
    error: query.error,
    /** The query itself, for onFailedRequest. */
    query,
  }
}

// A window query keeps the previous window's answer on screen while the
// next one loads (placeholderData), so a period switch does not blank the
// figures. A failed answer ends it: the figures go to "—", never to another
// window's numbers.

/** Query options for the dashboard's stat cards (`GET /admin/stats/overview`). */
export const adminOverviewQuery = defineQueryOptions(({ period, offset }: AdminPeriodWindow) => ({
  key: adminKeys.overview(period, offset),
  query: () => getAdminStatsOverview(period, offset),
  staleTime: 0,
  placeholderData: (previous: AdminStatsOverviewResponse | undefined) => previous,
}))

/** Query options for the check-in rate of one window (`GET /admin/metrics/check-in`). */
export const checkinMetricQuery = defineQueryOptions(({ period, offset }: AdminPeriodWindow) => ({
  key: adminKeys.metric('checkin', period, offset),
  query: () => getCheckinMetric(period, offset),
  staleTime: 0,
  placeholderData: (previous: CheckinMetricResponse | undefined) => previous,
}))

/** Query options for the feedback rate of one window (`GET /admin/metrics/feedback`). */
export const feedbackMetricQuery = defineQueryOptions(({ period, offset }: AdminPeriodWindow) => ({
  key: adminKeys.metric('feedback', period, offset),
  query: () => getFeedbackMetric(period, offset),
  staleTime: 0,
  placeholderData: (previous: FeedbackMetricResponse | undefined) => previous,
}))

/** Query options for the return rate of one window (`GET /admin/metrics/return`). */
export const returnMetricQuery = defineQueryOptions(({ period, offset }: AdminPeriodWindow) => ({
  key: adminKeys.metric('return', period, offset),
  query: () => getReturnMetric(period, offset),
  staleTime: 0,
  placeholderData: (previous: ReturnMetricResponse | undefined) => previous,
}))

/** Query options for the platform revenue of one window (`GET /admin/revenue`). */
export const revenueQuery = defineQueryOptions(({ period, offset }: AdminPeriodWindow) => ({
  key: adminKeys.metric('revenue', period, offset),
  query: () => getAdminRevenue(period, offset),
  staleTime: 0,
  placeholderData: (previous: AdminRevenueResponse | undefined) => previous,
}))

/** Practices the platform list asks for (one page, no "show more"). */
export const ADMIN_PRACTICES_LIMIT = 100

/** Query options for the platform's practices in one scope (`GET /admin/practices`). */
export const adminPracticesQuery = defineQueryOptions((scope: AdminPracticeScope) => ({
  key: adminKeys.practices(scope),
  query: () => getAdminPractices(scope, ADMIN_PRACTICES_LIMIT, 0),
  staleTime: 0,
}))

/** A filter of the participants list: everyone, or new / active this week. */
export type AdminParticipantFilter = 'all' | 'new' | 'active'

/** Participants per page of `GET /admin/participants`. */
export const ADMIN_PARTICIPANTS_PAGE_SIZE = 100

/**
 * Infinite query options for the platform's participants under one filter
 * (`GET /admin/participants`, the current week's window), every page loaded
 * so far.
 */
export const adminParticipantsQuery = defineInfiniteQueryOptions(
  (filter: AdminParticipantFilter) => ({
    key: adminKeys.participants(filter),
    query: ({ pageParam }: { pageParam: number }) =>
      getParticipants(filter, 'week', 0, ADMIN_PARTICIPANTS_PAGE_SIZE, pageParam),
    initialPageParam: 0,
    getNextPageParam: (
      last: PaginatedParticipantsResponse,
      pages: PaginatedParticipantsResponse[],
    ) => {
      const loaded = pages.reduce((n, page) => n + page.items.length, 0)
      return loaded < last.total ? loaded : null
    },
    staleTime: 0,
  }),
)

// =============================================================================
// The catalogs
// =============================================================================
//
// The method catalog editor, the platform's schools, the promo oversight
// list and one practice's oversight detail.

//
// Each screen used to fetch on mount into its own refs; the reads now live
// here, the writes go through useAdminMutation.
// =============================================================================

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
