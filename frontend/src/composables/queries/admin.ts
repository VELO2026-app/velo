// =============================================================================
// VELO Frontend -- the admin zone on Pinia Colada (FE-181)
// =============================================================================
//
// Every query and mutation an admin screen uses, by area:
//
//   - shared: onFailedRequest (how a screen tells a failed request) and the
//     admin mutation map with useAdminMutation;
//   - the sidebar and the dashboard: the counters (`GET /admin/stats` + the
//     count of reports awaiting moderation: the sidebar's counters, the
//     attention queues, the moderation tabs -- one entry, so the sidebar
//     and the screens read the same answer), the counts of the dashboard's other queues
//     (open tickets, pending payouts) and the period window (the overview
//     cards and the four engagement / revenue figures, one entry per
//     (period, offset));
//   - the platform's practices table;
//   - the catalogs: the method catalog editor, the schools, the promo
//     table, one practice's oversight detail.
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
  getAdminStats,
  getAdminStatsOverview,
  getAdminZoomAttendance,
  getCheckinMetric,
  getFeedbackMetric,
  getMasterById,
  getMastersList,
  getMethodChangeRequests,
  getReports,
  getReturnMetric,
  getRevokePreview,
  getUsersList,
  getAdminWithdrawals,
  getReportById,
  type AdminMasterDetail,
  type WithdrawalStatus,
  type ReportStatusFilter,
  type AdminPracticeScope,
  type AdminPromoTypeFilter,
  type UserResponse,
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
  AdminPracticeListItem,
  AdminStatsOverviewResponse,
  AdminStatsResponse,
  CheckinMetricResponse,
  FeedbackMetricResponse,
  PaginatedAdminPracticesResponse,
  PaginatedMethodChangeRequestsResponse,
  PaginatedReportsResponse,
  ReturnMetricResponse,
} from '@/api/types'
import { adminKeys } from '@/composables/queries/adminKeys'
import { nearestFirstWindow } from '@/utils/console/nearestFirst'
import { relativeDayCode } from '@/utils/format'
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
  /** `POST /admin/promos`: a company promo is born -- every page of every tab of the promo table. */
  createPromo: [adminKeys.promoPagesAll()],
  /** `PATCH /admin/promos/{id}/deactivate`: the promo turns inactive -- every page of every tab of the promo table. */
  deactivatePromo: [adminKeys.promoPagesAll()],
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
   * names), the users list, the method queue, the schools
   * (their curator), the platform practices (their master). The user zone's
   * practice cards also carry the name; they are left to their staleness
   * window -- an admin rarely holds them, and a name edit is not urgent.
   */
  editMasterFields: [
    adminKeys.masters(),
    adminKeys.masterAll(),
    adminKeys.users(),
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
 * The admin counters for a screen or the sidebar.
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

/** Pages of the nearest practices read for the dashboard's "Today" at most (100 practices). */
export const ADMIN_TODAY_MAX_PAGES = 5

/** The practices still ahead today; `more` -- the read stopped at its cap, and today has more. */
export interface TodayPractices {
  items: AdminPracticeListItem[]
  more: boolean
}

/**
 * Query options for the practices still ahead today, nearest first
 * (`GET /admin/practices?scope=upcoming`), the dashboard's "Today".
 *
 * @remarks
 * A busy day has more practices than one page (FE-260): the pages are read
 * nearest first until one holds a practice of another day or the scope
 * ends. The read stops at ADMIN_TODAY_MAX_PAGES; past it the card says
 * "N+" (`more`). A practice is today in its own time zone, as the
 * practices table dates it.
 */
export const adminTodayPracticesQuery = defineQueryOptions(() => ({
  key: adminKeys.practicesToday(),
  query: async (): Promise<TodayPractices> => {
    const items: AdminPracticeListItem[] = []
    for (let page = 1; page <= ADMIN_TODAY_MAX_PAGES; page++) {
      const slice = await loadPracticesPage('upcoming', page)
      const today = slice.items.filter(
        (p) => relativeDayCode(p.scheduled_at, p.timezone) === 'today',
      )
      items.push(...today)
      const ended = page * ADMIN_PRACTICES_PAGE_SIZE >= slice.total
      if (today.length < slice.items.length || ended) return { items, more: false }
    }
    return { items, more: true }
  },
  staleTime: 0,
}))

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

/** A tab of the web console's promo table: no "inactive" tab -- a deactivated promo shows under "all" with its status. */
export type ConsolePromoFilter = Exclude<AdminPromoFilter, 'inactive'>

/**
 * Query options for one page (1-based) of one tab of the promo table
 * (`GET /admin/promos`), the web console. The page is part of the key: a
 * page switch is a cache entry of its own.
 */
export const adminPromosPageQuery = defineQueryOptions(
  ({ filter, page }: { filter: ConsolePromoFilter; page: number }) => ({
    key: adminKeys.promosPage(filter, page),
    query: () => {
      const { type, isActive } = promoParams(filter)
      return getAdminPromos(
        type,
        isActive,
        ADMIN_PROMOS_PAGE_SIZE,
        (page - 1) * ADMIN_PROMOS_PAGE_SIZE,
      )
    },
    staleTime: 0,
  }),
)

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

/** Next offset of an offset-paged list, or null once every row is loaded. */
function nextOffset(last: { total: number }, pages: { items: unknown[] }[]): number | null {
  const loaded = pages.reduce((n, page) => n + page.items.length, 0)
  return loaded < last.total ? loaded : null
}

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

// =============================================================================
// The web console's people tables (FE-262): numbered pages, one tab each
// =============================================================================
//
// The /console tables page by number, the server pages by offset: one entry
// per (tab, page), all under the prefix of the list they show, so the
// verdicts of ADMIN_INVALIDATES refetch the page on screen and make the
// others stale. A tab's total is its own one-row request, so the tab labels
// carry counts without loading the tab.

/** Rows per page of the web console's people tables. */
export const CONSOLE_PAGE_SIZE = 20

/** A tab of the console masters table: every master or one verification status. */
export type ConsoleMastersTab = 'all' | 'pending' | 'rejected'

/** A tab of the console users table: every user or one role. */
export type ConsoleUsersTab = 'all' | 'user' | 'master' | 'admin'

/** Offset of a 1-based page. */
function pageOffset(page: number): number {
  return (page - 1) * CONSOLE_PAGE_SIZE
}

/** Query options for one page of one tab of the console masters table (`GET /admin/masters/list`). */
export const consoleMastersPageQuery = defineQueryOptions(
  ({ tab, page }: { tab: ConsoleMastersTab; page: number }) => ({
    key: adminKeys.mastersPage(tab, page),
    query: async () => {
      const [res] = await Promise.all([
        getMastersList(tab === 'all' ? undefined : tab, CONSOLE_PAGE_SIZE, pageOffset(page)),
        primeTaxonomy(),
      ])
      return res
    },
    staleTime: 0,
  }),
)

/** Query options for the total of one tab of the console masters table. */
export const consoleMastersCountQuery = defineQueryOptions((tab: ConsoleMastersTab) => ({
  key: adminKeys.mastersCount(tab),
  query: async () => (await getMastersList(tab === 'all' ? undefined : tab, 1, 0)).total,
  staleTime: 0,
}))

/** The activity filter of the console users table: every user, or only the active or the inactive. */
export type ConsoleUsersActivity = 'all' | 'active' | 'inactive'

/** The `is_active` value the server takes for an activity filter (none -- every user). */
function activityParam(activity: ConsoleUsersActivity): boolean | undefined {
  return activity === 'all' ? undefined : activity === 'active'
}

/** Query options for one page of one tab of the console users table (`GET /admin/users`). */
export const consoleUsersPageQuery = defineQueryOptions(
  ({
    tab,
    activity,
    page,
  }: {
    tab: ConsoleUsersTab
    activity: ConsoleUsersActivity
    page: number
  }) => ({
    key: adminKeys.usersPage(tab, activity, page),
    query: () =>
      getUsersList(
        tab === 'all' ? undefined : tab,
        CONSOLE_PAGE_SIZE,
        pageOffset(page),
        activityParam(activity),
      ),
    staleTime: 0,
  }),
)

/** Query options for the total of one tab of the console users table. */
export const consoleUsersCountQuery = defineQueryOptions(
  ({ tab, activity }: { tab: ConsoleUsersTab; activity: ConsoleUsersActivity }) => ({
    key: adminKeys.usersCount(tab, activity),
    query: async () =>
      (await getUsersList(tab === 'all' ? undefined : tab, 1, 0, activityParam(activity))).total,
    staleTime: 0,
  }),
)

/** Query options for one page of the console schools table (`GET /admin/schools`). */
export const consoleSchoolsPageQuery = defineQueryOptions((page: number) => ({
  key: adminKeys.schoolsPage(page),
  query: () => getAdminSchools(CONSOLE_PAGE_SIZE, pageOffset(page)),
  staleTime: 0,
}))

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

/**
 * Drop a decided complaint from every complaints list held, at once -- the
 * list loses the row and its total before the verdict's refetch answers
 * (as `dropMethodRequest` does for the method queue).
 */
export function dropReport(queryCache: QueryCache, reportId: string): void {
  for (const entry of queryCache.getEntries({ key: adminKeys.reportsAll() })) {
    if (entry.state.value.data === undefined) continue
    setInfiniteQueryData<PaginatedReportsResponse, number>(queryCache, entry.key, (data) => {
      const pages = data?.pages ?? []
      // A refetch between two pages can repeat a row: still one complaint off the list.
      const dropped = pages.some((page) => page.items.some((r) => r.id === reportId)) ? 1 : 0
      return {
        pageParams: data?.pageParams ?? [],
        pages: pages.map((page) => ({
          ...page,
          items: page.items.filter((r) => r.id !== reportId),
          total: Math.max(0, page.total - dropped),
        })),
      }
    })
  }
}

/** Payout requests per page of `GET /admin/withdrawals`. */
export const ADMIN_WITHDRAWALS_PAGE_SIZE = 20

/**
 * Query options for one page (1-based) of one status of the payout queue
 * (`GET /admin/withdrawals?status=`), the web console's table. The page is
 * part of the key; every page sits under `adminKeys.withdrawals()`, so a
 * verdict (ADMIN_INVALIDATES.decideWithdrawal) makes them all stale.
 */
export const adminWithdrawalsPageQuery = defineQueryOptions(
  ({ status, page }: { status: WithdrawalStatus; page: number }) => ({
    key: adminKeys.withdrawalsPage(status, page),
    query: () =>
      getAdminWithdrawals(
        status,
        ADMIN_WITHDRAWALS_PAGE_SIZE,
        (page - 1) * ADMIN_WITHDRAWALS_PAGE_SIZE,
      ),
    staleTime: 0,
  }),
)

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

/** The API's largest page of a thread feed (`limit` le=100, support/router.py). */
const SUPPORT_FEED_PAGE_SIZE = 100

/** Pages of one feed read at most (10 000 messages): a cursor the API never ends stops here. */
const MAX_FEED_PAGES = 100

/**
 * Every message of one support thread, newest first: the pages are read by
 * their cursor until the API says there is no more (FE-260 -- the first page
 * alone hid the start of a long conversation). An empty page, a cursor seen
 * before or MAX_FEED_PAGES ends the read; `signal` drops it (another ticket
 * opened).
 */
async function readWholeFeed(threadId: string, signal: AbortSignal): Promise<SupportMessage[]> {
  const messages: SupportMessage[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let pages = 0; pages < MAX_FEED_PAGES; pages++) {
    const page = await getAdminSupportMessages(threadId, SUPPORT_FEED_PAGE_SIZE, cursor, signal)
    messages.push(...page.messages)
    const next = page.next_cursor
    if (page.messages.length === 0 || next === null || seen.has(next)) break
    seen.add(next)
    cursor = next
  }
  return messages
}

/**
 * A held feed (oldest first) brought up to date by its newest page: the
 * page's messages replace their older copies (a translation that came) and
 * the new ones join at the end. When the page reaches no message already
 * held and there are older pages, messages may lie between the two -- the
 * whole feed is read instead.
 */
async function refreshFeed(
  threadId: string,
  held: SupportMessage[],
  signal: AbortSignal,
): Promise<SupportMessage[]> {
  const head = await getAdminSupportMessages(threadId, SUPPORT_FEED_PAGE_SIZE, undefined, signal)
  const fresh = [...head.messages].reverse()
  const heldIds = new Set(held.map((m) => m.id))
  const joins = fresh.some((m) => heldIds.has(m.id))
  if (!joins && head.next_cursor !== null) return (await readWholeFeed(threadId, signal)).reverse()
  const freshIds = new Set(fresh.map((m) => m.id))
  return [...held.filter((m) => !freshIds.has(m.id)), ...fresh]
}

/** The entry's own data is a feed; Colada types it `unknown` inside the query. */
function isFeed(data: unknown): data is SupportMessage[] {
  return Array.isArray(data)
}

/** The first read of a feed takes every page; a held one is refreshed by its newest page. */
async function readFeed(
  threadId: string,
  signal: AbortSignal,
  held: SupportMessage[] | undefined,
): Promise<SupportMessage[]> {
  return held
    ? refreshFeed(threadId, held, signal)
    : (await readWholeFeed(threadId, signal)).reverse()
}

/**
 * Query options for one support thread's feed, oldest first (the API
 * answers newest first), all of it.
 *
 * @remarks
 * The first read takes every page; every later one (a return to the
 * screen, the translation poll every few seconds) reads the newest page
 * only and merges it into what is held (refreshFeed), so a long thread
 * costs one request a poll.
 */
export const adminSupportMessagesQuery = defineQueryOptions(
  ({ threadId, enabled }: { threadId: string; enabled: boolean }) => ({
    key: adminKeys.supportMessages(threadId),
    query: ({ signal, entry }) => {
      const held = entry.state.value.data
      return readFeed(threadId, signal, isFeed(held) ? held : undefined)
    },
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
 * Every admin a ticket can be handed to (`GET /admin/users?role=admin`),
 * page after page until the total is read (FE-260: one page of 100 would
 * cut the rest silently).
 */
async function readAllAdmins(): Promise<UserResponse[]> {
  const pages: { items: UserResponse[] }[] = []
  let offset: number | null = 0
  while (offset !== null) {
    const page = await getUsersList('admin', 100, offset)
    pages.push(page)
    offset = page.items.length === 0 ? null : nextOffset(page, pages)
  }
  return pages.flatMap((page) => page.items)
}

/**
 * Query options for the admins a ticket can be handed to
 * (`GET /admin/users?role=admin`), all of them, read when the hand-over
 * sheet opens.
 */
export const adminAdminsQuery = defineQueryOptions((enabled: boolean) => ({
  key: adminKeys.admins(),
  query: readAllAdmins,
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
