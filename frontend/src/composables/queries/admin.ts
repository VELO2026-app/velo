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
//     read the same answer), the counts of the dashboard's other queues
//     (open tickets, pending payouts) and the period window (the overview
//     cards and the four engagement / revenue figures, one entry per
//     (period, offset));
//   - the platform's practices and participants lists;
//   - the catalogs: the method catalog editor, the schools, the promo
//     oversight list, one practice's oversight detail.
//   - users and masters: the users and masters lists, one master's review
//     page, the method-change queue.
//   - the metric drill-ins and the revenue: the dashboard's window queries,
//     read through adminFigures;
//   - reports and payouts: the complaints tab, one report, the payout
//     requests.
//   - support: the ticket lists, one ticket, the thread feeds, the admins
//     a ticket can be handed to, the support stats.
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

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { t } from '@/locales'
import {
  defineInfiniteQueryOptions,
  defineQueryOptions,
  setInfiniteQueryData,
  useMutation,
  useQuery,
  useQueryCache,
  type EntryKey,
  type QueryCache,
  type UseQueryReturn,
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
  getMasterById,
  getMastersList,
  getMethodChangeRequests,
  getParticipants,
  getReports,
  getReturnMetric,
  getRevokePreview,
  getUsersList,
  getAdminWithdrawals,
  getReportById,
  type AdminMasterDetail,
  type AdminWithdrawalResponse,
  type ReportStatusFilter,
  type AdminPaginatedPromosResponse,
  type AdminPracticeScope,
  type AdminPromoTypeFilter,
} from '@/api/admin'
import { getAdminSchools } from '@/api/schools'
import {
  getAdminSupportMessages,
  getAdminTicket,
  getSupportStats,
  listAdminTickets,
  type AdminSupportTicket,
  type AdminSupportTicketList,
  type AdminTicketQuery,
  type SupportMessage,
} from '@/api/support'
import { getFullTaxonomy } from '@/api/taxonomy'
import type {
  AdminRevenueResponse,
  AdminStatsOverviewResponse,
  AdminStatsResponse,
  CheckinMetricResponse,
  FeedbackMetricResponse,
  PaginatedAdminPracticesResponse,
  PaginatedAdminSchoolsResponse,
  PaginatedMethodChangeRequestsResponse,
  PaginatedAdminWithdrawalsResponse,
  PaginatedParticipantsResponse,
  PaginatedReportsResponse,
  PaginatedUsersResponse,
  ReturnMetricResponse,
} from '@/api/types'
import { adminKeys } from '@/composables/queries/adminKeys'
import { nearestFirstWindow } from '@/utils/console/nearestFirst'
import { keys } from '@/composables/queries/keys'
import { extractApiError } from '@/composables/useApiError'
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

/** A paged list's next-page loader, with the toast rule of the admin lists. */
export interface PagedListMore {
  /** A next page the admin asked for is in flight (the button's spinner). */
  loadingMore: Ref<boolean>
  /** Ask for the next page; a failure is told through `tell`, never thrown. */
  loadMore: () => Promise<void>
}

/**
 * Tell every failed request of a paged list once (onFailedRequest), saying
 * which one failed: a next page the admin asked for (`nextPage` true), or
 * the list itself -- its first load, a retry, a refetch while the list is
 * shown (a stale list must not pass for a fresh one in silence).
 */
export function usePagedListFailures(
  query: RequestState & {
    loadNextPage: (options?: { cancelRefetch?: boolean }) => Promise<unknown>
  },
  tell: (error: unknown, nextPage: boolean) => void,
): PagedListMore {
  const loadingMore = ref(false)
  // Read by the failure watcher, which runs before loadMore's own
  // continuation: the failed request was the next page this flag names.
  let askingMore = false
  onFailedRequest(query, (error) => tell(error, askingMore))
  return {
    loadingMore,
    async loadMore() {
      if (loadingMore.value) return
      loadingMore.value = true
      askingMore = true
      try {
        // cancelRefetch false: a tap during a reload joins it instead of
        // gluing a stale page to a fresh one.
        await query.loadNextPage({ cancelRefetch: false })
      } catch {
        // Told by the failure watcher above.
      } finally {
        askingMore = false
        loadingMore.value = false
      }
    },
  }
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
  /**
   * `POST /admin/masters/invite`: a one-time invite link, answered to the
   * caller only -- no list shows invites, nothing goes stale.
   */
  inviteMaster: [],
  /**
   * `POST /admin/users/{id}/make-master`: the user turns master with a
   * verified profile (whatever its status was) -- their role in the users
   * list, their row in the masters list and their detail, the
   * pending-verification badge (a pending application is verified on the
   * way), the schools they curate (a school is active only while its
   * curator is verified: the admin list and the user zone's) and their
   * public master page.
   */
  makeMaster: [
    adminKeys.users(),
    adminKeys.masters(),
    adminKeys.masterAll(),
    adminKeys.stats(),
    adminKeys.schools(),
    keys.schools.root(),
    keys.masters.publicAll(),
  ],
  /**
   * `POST /admin/masters/{id}/verify`: the application turns verified (the
   * role stays as it is: the user switches to master mode on their own) --
   * the masters list and the detail, the pending-verification badge, the
   * schools they curate (admin list and user zone), the public master page;
   * a method promoted on the way is a new catalog row.
   */
  verifyMaster: [
    adminKeys.masters(),
    adminKeys.masterAll(),
    adminKeys.stats(),
    adminKeys.schools(),
    keys.schools.root(),
    adminKeys.taxonomy(),
    keys.masters.publicAll(),
  ],
  /** `POST /admin/masters/{id}/reject`: the application turns rejected -- the list, the detail, the badge. */
  rejectMaster: [adminKeys.masters(), adminKeys.masterAll(), adminKeys.stats()],
  /**
   * `POST /admin/masters/{id}/revoke`: the master is suspended and back to
   * user -- the lists, the detail, the schools they curate freeze (admin
   * list and user zone), the public master page goes.
   */
  revokeMaster: [
    adminKeys.masters(),
    adminKeys.masterAll(),
    adminKeys.users(),
    adminKeys.schools(),
    keys.schools.root(),
    keys.masters.publicAll(),
  ],
  /**
   * `PATCH /admin/masters/{id}/methods`, `PATCH /admin/masters/{id}/profile`:
   * a master-authored field -- the detail and the public page, and every
   * admin list that names or describes the master: the masters list (chips,
   * names), the users and participants lists, the method queue, the schools
   * (their curator), the platform practices (their master). The user zone's
   * practice cards also carry the name; they are left to their staleness
   * window -- an admin rarely holds them, and a name edit is not urgent.
   */
  editMasterFields: [
    adminKeys.masters(),
    adminKeys.masterAll(),
    adminKeys.users(),
    adminKeys.participantsAll(),
    adminKeys.methodRequests(),
    adminKeys.schools(),
    adminKeys.practicesAll(),
    adminKeys.practiceAll(),
    keys.masters.publicAll(),
  ],
  /**
   * `PATCH /admin/masters/{id}/can-create-schools`: the school-founding right
   * -- the detail and the masters list (its flag). Nothing else shows it.
   */
  setSchoolRight: [adminKeys.masters(), adminKeys.masterAll()],
  /**
   * `POST /admin/masters/{id}/method-change-request/approve`: the methods go
   * live -- the request leaves the queue (and its badge), the master's
   * detail, list chips and public page change; a promoted method is a new
   * catalog row.
   */
  approveMethodChange: [
    adminKeys.methodRequests(),
    adminKeys.stats(),
    adminKeys.masters(),
    adminKeys.masterAll(),
    adminKeys.taxonomy(),
    keys.masters.publicAll(),
  ],
  /** `POST /admin/masters/{id}/method-change-request/reject`: the request leaves the queue and its badge. */
  rejectMethodChange: [adminKeys.methodRequests(), adminKeys.stats()],
  /**
   * `POST /admin/reports/{id}/resolve` and `.../dismiss`: the report leaves
   * "pending" -- every complaints list, its detail, the moderation badge.
   */
  decideReport: [adminKeys.reportsAll(), adminKeys.reportAll(), adminKeys.stats()],
  /**
   * `POST /admin/withdrawals/{id}/approve` and `.../reject`: the request's
   * status in the payouts list (the answer is also written in place); the
   * master's balance moves -- frozen to paid out, or back to available --
   * in the masters list, their detail and their revoke advisory (available,
   * frozen, pending withdrawals); an approval adds to the period's payouts
   * (the revenue windows, not the other metrics).
   */
  decideWithdrawal: [
    adminKeys.withdrawals(),
    adminKeys.masters(),
    adminKeys.masterAll(),
    adminKeys.revokePreviewAll(),
    adminKeys.revenueAll(),
  ],
  /**
   * A support ticket closed with a status or reopened: every ticket list
   * (its status) and the support stats (they count statuses, spam and who
   * resolved). Not the ticket itself: the screen writes the answer into it.
   */
  changeTicketStatus: [
    adminKeys.supportTicketsAll(),
    adminKeys.supportStatsAll(),
    adminKeys.openTickets(),
  ],
  /**
   * A support ticket taken, handed over or released: every ticket list (its
   * taker). Not the stats (a taker is not counted) nor the ticket itself
   * (the screen writes the answer into it, or reads it again after the
   * take, whose answer carries no ticket).
   */
  changeTicketTaker: [adminKeys.supportTicketsAll()],
  /**
   * `POST /support/threads/{id}/messages`: a reply -- nothing a held list
   * shows (a list row carries no last message, and a reply moves neither the
   * status nor the taker). The thread's feed is read again by the screen,
   * which polls it while translations are on their way.
   */
  replySupport: [],
  /**
   * `POST /support/threads/{id}/messages/{id}/translation/retry`: queued
   * again -- nothing to read now; the screen marks the message as being
   * prepared and its polling picks up the result.
   */
  retryTranslation: [],
  /**
   * `POST /admin/announcements`: handed to comms -- the server stores no row
   * of it (the history needs BE-256), so no held list or counter goes stale.
   */
  sendAnnouncement: [],
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
  const { loading, failed } = screenQueryState(query)
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
    loading,
    /** Nothing held and the last request failed: the counters are unknown, not zero. */
    failed,
    /** Ask again (the screen's Retry). */
    reload: () => query.refetch(),
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

/** A screen's view of one period window's figures (the drill-in screens). */
export interface AdminFiguresState<T> {
  /** The selected window's answer, or null while there is none. */
  data: ComputedRef<T | null>
  /** No answer for the selected window and none failed yet: the loader. */
  loading: ComputedRef<boolean>
  /** The selected window failed and nothing is being tried: its message. */
  error: ComputedRef<string | null>
  /** Ask again (the error rung's retry). */
  retry: () => void
}

/**
 * The drill-in screens' rungs over one window query: the loader whenever
 * the selected window has no answer of its own -- a period switch shows it
 * too, the previous window's numbers (the dashboard's placeholder) never
 * stand in -- the error with its message, then the figures.
 *
 * @param tellStale - Told when a read fails over figures already shown (a
 *   revisit, a return to the app): the figures stay, the admin must know
 *   they may be old. A failure with nothing shown is the error rung.
 */
export function adminFigures<T>(
  query: Pick<
    UseQueryReturn<T, unknown, undefined>,
    'data' | 'error' | 'asyncStatus' | 'isPlaceholderData' | 'refetch'
  >,
  tellStale?: (error: unknown) => void,
): AdminFiguresState<T> {
  const answer = computed(() => (query.isPlaceholderData.value ? undefined : query.data.value))
  onFailedRequest(query, (error) => {
    if (answer.value !== undefined) tellStale?.(error)
  })
  const failed = computed(
    () =>
      answer.value === undefined && query.error.value != null && query.asyncStatus.value === 'idle',
  )
  return {
    data: computed(() => answer.value ?? null),
    loading: computed(() => answer.value === undefined && !failed.value),
    error: computed(() =>
      failed.value ? extractApiError(query.error.value, t('common.loadError')) : null,
    ),
    retry: () => void query.refetch(),
  }
}

/** Tickets read to count the open ones: the API's page cap. */
export const ADMIN_OPEN_TICKETS_LIMIT = 100

/** How many support tickets are open; `more` -- there are more than were counted. */
export interface OpenTicketsCount {
  count: number
  more: boolean
}

/**
 * Query options for the count of open support tickets (`GET /support/tickets?status=open`).
 *
 * @remarks
 * The ticket list answers with a page and a cursor, never a total, so the
 * dashboard counts one full page: past it the count reads "100+" (`more`).
 * It counts OPEN tickets; whether a person is still waiting for a first
 * answer is not in the API (BE-259).
 */
export const adminOpenTicketsQuery = defineQueryOptions(() => ({
  key: adminKeys.openTickets(),
  query: async (): Promise<OpenTicketsCount> => {
    const page = await listAdminTickets({ status: 'open', limit: ADMIN_OPEN_TICKETS_LIMIT })
    return { count: page.tickets.length, more: page.next_cursor !== null }
  },
  staleTime: 0,
}))

/**
 * Query options for how many payout requests are pending
 * (`GET /admin/withdrawals?status=pending`, the answer's total).
 *
 * @param enabled - Off on an instance without the payments option: there is
 *   no payout queue to count.
 */
export const adminPendingWithdrawalsQuery = defineQueryOptions((enabled: boolean) => ({
  key: adminKeys.withdrawalsPending(),
  query: async (): Promise<number> => (await getAdminWithdrawals('pending', 1, 0)).total,
  staleTime: 0,
  enabled,
}))

/** Practices the platform list asks for (one page, no "show more"). */
export const ADMIN_PRACTICES_LIMIT = 100

/** Query options for the platform's practices in one scope (`GET /admin/practices`). */
export const adminPracticesQuery = defineQueryOptions((scope: AdminPracticeScope) => ({
  key: adminKeys.practices(scope),
  query: () => getAdminPractices(scope, ADMIN_PRACTICES_LIMIT, 0),
  staleTime: 0,
}))

/** Practices per page of the web console's practices table. */
export const ADMIN_PRACTICES_PAGE_SIZE = 20

/**
 * One page (1-based) of the platform's practices in one scope, the way the
 * web console's table shows it.
 *
 * @remarks
 * The API lists every scope newest first. For `past` and `all` that is the
 * order wanted. For `upcoming` it puts the nearest practices on the last
 * page, so the console pages that scope from the end: one request for the
 * total, one for the slice that page 1 (the nearest) is made of
 * (utils/console/nearestFirst.ts), the rows turned around. When the backend
 * can sort `upcoming` ascending this goes and the scope pages like the others.
 */
async function loadPracticesPage(
  scope: AdminPracticeScope,
  page: number,
): Promise<PaginatedAdminPracticesResponse> {
  const size = ADMIN_PRACTICES_PAGE_SIZE
  const offset = (page - 1) * size
  if (scope !== 'upcoming') return getAdminPractices(scope, size, offset)
  const { total } = await getAdminPractices(scope, 1, 0)
  const window = nearestFirstWindow(total, page, size)
  if (window === null) return { items: [], total, limit: size, offset }
  const slice = await getAdminPractices(scope, window.limit, window.offset)
  return { items: [...slice.items].reverse(), total: slice.total, limit: size, offset }
}

/**
 * Query options for one page of the platform's practices in one scope
 * (`GET /admin/practices`), the web console's table. The page is part of
 * the key: a page switch is a cache entry of its own.
 */
export const adminPracticesPageQuery = defineQueryOptions(
  ({ scope, page }: { scope: AdminPracticeScope; page: number }) => ({
    key: adminKeys.practicesPage(scope, page),
    query: () => loadPracticesPage(scope, page),
    staleTime: 0,
  }),
)

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

/**
 * Load the taxonomy catalog into utils/methodTaxonomy's module cache. Imported
 * on demand: a static import would list its chunk in the preload of every
 * admin route (this module is shared by all of them), and that preload map
 * ships in the startup chunk. Never rejects: a failed load leaves the cache
 * as it was (the hardcoded maps stand in, utils/methodTaxonomy).
 */
async function primeTaxonomy(): Promise<void> {
  try {
    const { primeMethodTaxonomyCatalog } = await import('@/utils/methodTaxonomy')
    await primeMethodTaxonomyCatalog()
  } catch {
    // The chunk did not load (offline): the cache keeps what it held.
  }
}

/**
 * A write to the method catalog (ADMIN_INVALIDATES.changeTaxonomy).
 *
 * @remarks
 * Legacy: the active catalog the rest of the app reads (the calendar filter,
 * the practice forms, the method pickers) is utils/methodTaxonomy's module
 * cache, not a Colada entry, so the row cannot reach it -- it is loaded again
 * here, next to the invalidation (./invalidation.ts header). The line leaves
 * when that cache moves to Colada.
 */
export function useTaxonomyMutation<TVars, TData>(mutation: (vars: TVars) => Promise<TData>) {
  return useAdminMutation('changeTaxonomy', mutation, { write: () => void primeTaxonomy() })
}

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

// =============================================================================
// Users and masters
// =============================================================================
//
// The users list, the masters list, one master's review page (with the
// revoke advisory) and the method-change queue. A verdict on a master
// refreshes the lists, the detail and the shell's badges at once.
//
// The masters list, the review page and the method queue render method
// chips from the taxonomy catalog (utils/methodTaxonomy), so each loads it
// alongside its own answer -- a promoted custom method must already resolve
// to a plain chip on first render (Bug 2, PROMPT №405).

/** Users per page of `GET /admin/users` (the backend's cap). */
export const ADMIN_USERS_PAGE_SIZE = 100

/** Next offset of an offset-paged list, or null once every row is loaded. */
function nextOffset(last: { total: number }, pages: { items: unknown[] }[]): number | null {
  const loaded = pages.reduce((n, page) => n + page.items.length, 0)
  return loaded < last.total ? loaded : null
}

/** Infinite query options for every user of the platform (`GET /admin/users`, any role). */
export const adminUsersQuery = defineInfiniteQueryOptions(() => ({
  key: adminKeys.users(),
  query: ({ pageParam }: { pageParam: number }) =>
    getUsersList(undefined, ADMIN_USERS_PAGE_SIZE, pageParam),
  initialPageParam: 0,
  getNextPageParam: (last: PaginatedUsersResponse, pages: PaginatedUsersResponse[]) =>
    nextOffset(last, pages),
  staleTime: 0,
}))

/**
 * Show a user as a master in the users list held, at once -- before the
 * invalidation's refetch answers: the make-master button leaves the row
 * (a second tap would only meet 409 already_master).
 */
export function markUserMaster(queryCache: QueryCache, userId: string): void {
  if (queryCache.getQueryData(adminKeys.users()) === undefined) return
  setInfiniteQueryData<PaginatedUsersResponse, number>(queryCache, adminKeys.users(), (data) => ({
    pageParams: data?.pageParams ?? [],
    pages: (data?.pages ?? []).map((page) => ({
      ...page,
      items: page.items.map((u) => (u.id === userId ? { ...u, role: 'master' as const } : u)),
    })),
  }))
}

/**
 * Masters the list asks for: the backend's page cap (le=100; 200 was
 * 422-rejected). The screen filters and counts client-side; pagination
 * comes when the master count approaches it (operator ruling, PROMPT №289).
 */
export const ADMIN_MASTERS_LIMIT = 100

/** Query options for every master with its status (`GET /admin/masters/list`). */
export const adminMastersQuery = defineQueryOptions(() => ({
  key: adminKeys.masters(),
  query: async () => {
    const [res] = await Promise.all([
      getMastersList(undefined, ADMIN_MASTERS_LIMIT, 0),
      primeTaxonomy(),
    ])
    return res
  },
  staleTime: 0,
}))

/** Query options for one master's full review page (`GET /admin/masters/{id}`). */
export const adminMasterQuery = defineQueryOptions((userId: string) => ({
  key: adminKeys.master(userId),
  query: async () => {
    const [detail] = await Promise.all([getMasterById(userId), primeTaxonomy()])
    return detail
  },
  staleTime: 0,
}))

/**
 * Patch the held review page of a master with what a mutation answered or
 * sent (a status, edited fields, the school right) -- at once, before the
 * invalidation's refetch. No-op while no page is held: the list's handed
 * row is never written in its place (it lacks the detail's fields, and
 * would pass for a full page on a later visit).
 */
export function patchAdminMaster(
  queryCache: QueryCache,
  userId: string,
  patch: Partial<AdminMasterDetail>,
): void {
  const held = queryCache.getQueryData<AdminMasterDetail>(adminKeys.master(userId))
  if (held) queryCache.setQueryData(adminKeys.master(userId), { ...held, ...patch })
}

/**
 * Query options for the revoke advisory of one master
 * (`GET /admin/masters/{id}/revoke-preview`): the numbers the confirm
 * dialog warns with. Best-effort, read when the dialog opens.
 */
export const adminRevokePreviewQuery = defineQueryOptions(
  ({ userId, enabled }: { userId: string; enabled: boolean }) => ({
    key: adminKeys.revokePreview(userId),
    query: () => getRevokePreview(userId),
    staleTime: 0,
    enabled,
  }),
)

/** Requests per page of `GET /admin/masters/method-change-requests`. */
export const ADMIN_METHOD_REQUESTS_PAGE_SIZE = 20

/** Infinite query options for the pending method-change requests, newest first. */
export const adminMethodRequestsQuery = defineInfiniteQueryOptions(() => ({
  key: adminKeys.methodRequests(),
  query: async ({ pageParam }: { pageParam: number }) => {
    const [res] = await Promise.all([
      getMethodChangeRequests(ADMIN_METHOD_REQUESTS_PAGE_SIZE, pageParam),
      // The first page only: later pages render from the catalog it loaded.
      pageParam === 0 ? primeTaxonomy() : undefined,
    ])
    return res
  },
  initialPageParam: 0,
  getNextPageParam: (
    last: PaginatedMethodChangeRequestsResponse,
    pages: PaginatedMethodChangeRequestsResponse[],
  ) => nextOffset(last, pages),
  staleTime: 0,
}))

/**
 * Drop a decided request from the queue held, at once -- the list loses the
 * row and the header its count before the invalidation's refetch answers.
 */
export function dropMethodRequest(queryCache: QueryCache, userId: string): void {
  if (queryCache.getQueryData(adminKeys.methodRequests()) === undefined) return
  setInfiniteQueryData<PaginatedMethodChangeRequestsResponse, number>(
    queryCache,
    adminKeys.methodRequests(),
    (data) => {
      const pages = data?.pages ?? []
      // A master has one pending request; a refetch between two pages can
      // repeat its row, still one request off the queue.
      const dropped = pages.some((page) => page.items.some((i) => i.user_id === userId)) ? 1 : 0
      // Every page carries the queue's total, and the header and "is there
      // more" read the last one: each loses what was dropped anywhere.
      return {
        pageParams: data?.pageParams ?? [],
        pages: pages.map((page) => ({
          ...page,
          items: page.items.filter((i) => i.user_id !== userId),
          total: Math.max(0, page.total - dropped),
        })),
      }
    },
  )
}

// =============================================================================
// Reports and payouts
// =============================================================================

/** Reports per page of the complaints tab. */
export const ADMIN_REPORTS_PAGE_SIZE = 20

/**
 * Infinite query options for the complaints tab under one status filter
 * (`GET /admin/reports?status=`, all statuses when undefined).
 *
 * @param enabled - Off while the moderation screen shows its tickets tab:
 *   the complaints load when their tab is shown.
 */
export const adminReportsQuery = defineInfiniteQueryOptions(
  ({ status, enabled }: { status: ReportStatusFilter | undefined; enabled: boolean }) => ({
    key: adminKeys.reports(status ?? 'all'),
    query: ({ pageParam }: { pageParam: number }) =>
      getReports(status, undefined, ADMIN_REPORTS_PAGE_SIZE, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last: PaginatedReportsResponse, pages: PaginatedReportsResponse[]) =>
      nextOffset(last, pages),
    staleTime: 0,
    enabled,
  }),
)

/**
 * Query options for one report (`GET /admin/reports/{id}`).
 *
 * @param enabled - Off when the list handed the row (router state): the
 *   screen renders it without a request, as it always did.
 */
export const adminReportQuery = defineQueryOptions(
  ({ reportId, enabled }: { reportId: string; enabled: boolean }) => ({
    key: adminKeys.report(reportId),
    query: () => getReportById(reportId),
    staleTime: 0,
    enabled,
  }),
)

/** Payout requests per page of `GET /admin/withdrawals`. */
export const ADMIN_WITHDRAWALS_PAGE_SIZE = 20

/** Infinite query options for every payout request, all statuses (`GET /admin/withdrawals`). */
export const adminWithdrawalsQuery = defineInfiniteQueryOptions(() => ({
  key: adminKeys.withdrawals(),
  query: ({ pageParam }: { pageParam: number }) =>
    getAdminWithdrawals(undefined, ADMIN_WITHDRAWALS_PAGE_SIZE, pageParam),
  initialPageParam: 0,
  getNextPageParam: (
    last: PaginatedAdminWithdrawalsResponse,
    pages: PaginatedAdminWithdrawalsResponse[],
  ) => nextOffset(last, pages),
  staleTime: 0,
}))

/**
 * Write a decided payout request into the payouts list held, at once --
 * the row leaves "pending" before the refetch answers (a second decision
 * would only meet 409).
 */
export function setWithdrawal(queryCache: QueryCache, decided: AdminWithdrawalResponse): void {
  if (queryCache.getQueryData(adminKeys.withdrawals()) === undefined) return
  setInfiniteQueryData<PaginatedAdminWithdrawalsResponse, number>(
    queryCache,
    adminKeys.withdrawals(),
    (data) => ({
      pageParams: data?.pageParams ?? [],
      pages: (data?.pages ?? []).map((page) => ({
        ...page,
        items: page.items.map((w) => (w.id === decided.id ? decided : w)),
      })),
    }),
  )
}

// =============================================================================
// Support
// =============================================================================

/** Tickets per page of the support tab. */
const ADMIN_SUPPORT_TICKETS_PAGE_SIZE = 20

/**
 * Infinite query options for the support tickets of one tab and filter
 * (`GET /admin/support/tickets`), newest appeal first, cursor-paged.
 */
export const adminSupportTicketsQuery = defineInfiniteQueryOptions((query: AdminTicketQuery) => ({
  key: adminKeys.supportTickets(query),
  query: ({ pageParam }: { pageParam: string | null }) =>
    listAdminTickets({
      ...query,
      limit: ADMIN_SUPPORT_TICKETS_PAGE_SIZE,
      ...(pageParam ? { cursor: pageParam } : {}),
    }),
  initialPageParam: null as string | null,
  getNextPageParam: (last: AdminSupportTicketList) => last.next_cursor,
  staleTime: 0,
}))

/**
 * Query options for one support ticket (`GET /admin/support/tickets/{id}`).
 * The default staleness window: the list hands its row (seeded into the
 * entry), and the screen reads the ticket again itself where it must (a
 * conflict, the take).
 */
export const adminSupportTicketQuery = defineQueryOptions((ticketId: string) => ({
  key: adminKeys.supportTicket(ticketId),
  query: () => getAdminTicket(ticketId),
}))

/**
 * Query options for one support thread's feed, oldest first (the API
 * answers newest first). Asked again on every visit; the detail screen
 * polls it while translations are on their way.
 */
export const adminSupportMessagesQuery = defineQueryOptions(
  ({ threadId, enabled }: { threadId: string; enabled: boolean }) => ({
    key: adminKeys.supportMessages(threadId),
    query: async (): Promise<SupportMessage[]> =>
      [...(await getAdminSupportMessages(threadId)).messages].reverse(),
    staleTime: 0,
    enabled,
  }),
)

/** Write a thread's feed held in the cache (a sent reply, a retried translation). No-op while none is held. */
export function updateSupportFeed(
  queryCache: QueryCache,
  threadId: string,
  update: (messages: SupportMessage[]) => SupportMessage[],
): void {
  const held = queryCache.getQueryData<SupportMessage[]>(adminKeys.supportMessages(threadId))
  if (held) queryCache.setQueryData(adminKeys.supportMessages(threadId), update(held))
}

/**
 * Query options for the admins a ticket can be handed to
 * (`GET /admin/users?role=admin`), read when the hand-over sheet opens.
 */
export const adminAdminsQuery = defineQueryOptions((enabled: boolean) => ({
  key: adminKeys.admins(),
  query: async () => (await getUsersList('admin')).items,
  staleTime: 0,
  enabled,
}))

/** Query options for the support figures of the tickets created in one window (`GET /admin/support/stats`). */
export const adminSupportStatsQuery = defineQueryOptions(
  ({ createdFrom, createdTo }: { createdFrom: string; createdTo: string }) => ({
    key: adminKeys.supportStats(createdFrom, createdTo),
    query: () => getSupportStats(createdFrom, createdTo),
    staleTime: 0,
  }),
)

/**
 * Write a ticket into its entry: the row the list handed (the card paints
 * at once, no request within the staleness window), or the answer of a
 * ticket mutation.
 */
export function setSupportTicket(queryCache: QueryCache, ticket: AdminSupportTicket): void {
  queryCache.setQueryData(adminKeys.supportTicket(ticket.id), ticket)
}

/** Whether a ticket's entry holds an answer. */
export function hasSupportTicket(queryCache: QueryCache, ticketId: string): boolean {
  return queryCache.getQueryData(adminKeys.supportTicket(ticketId)) !== undefined
}
