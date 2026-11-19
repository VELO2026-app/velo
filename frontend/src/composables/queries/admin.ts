// =============================================================================
// VELO Frontend -- the admin zone's shared reads on Pinia Colada (FE-181)
// =============================================================================
//
// What stores/admin.ts used to hold, and what the dashboard and the two
// platform lists fetched by hand:
//
//   - the counters (`GET /admin/stats` + the count of reports awaiting
//     moderation): the shell's tab badges, the dashboard's banners, the
//     lists' "all" badges -- one entry, so the shell and the screens read
//     the same answer;
//   - the dashboard's period window: the overview cards and the four
//     engagement / revenue figures, one entry per (period, offset);
//   - the platform's practices and participants lists.
//
// Freshness: the counters keep the default window (queries/setup.ts) and the
// admin's own actions invalidate them (./invalidation.ts). Everything else
// is asked again on every visit (staleTime 0) -- other people move these
// numbers all the time -- while the cached answer stays on screen.
//
// Errors stay raw on the query (ADR); the screens turn them into text.
// =============================================================================

import { computed } from 'vue'
import { defineInfiniteQueryOptions, defineQueryOptions, useQuery } from '@pinia/colada'
import {
  getAdminPractices,
  getAdminRevenue,
  getAdminStats,
  getAdminStatsOverview,
  getCheckinMetric,
  getFeedbackMetric,
  getParticipants,
  getReports,
  getReturnMetric,
  type AdminPracticeScope,
} from '@/api/admin'
import type {
  AdminRevenueResponse,
  AdminStatsOverviewResponse,
  AdminStatsResponse,
  CheckinMetricResponse,
  FeedbackMetricResponse,
  PaginatedParticipantsResponse,
  ReturnMetricResponse,
} from '@/api/types'
import { adminKeys } from '@/composables/queries/adminKeys'
import { screenQueryState } from '@/composables/queries/screenState'

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
