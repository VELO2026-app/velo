// =============================================================================
// VELO Frontend -- Admin store (Admin DS rebuild 2026-06-14)
// =============================================================================
//
// Shared admin state for the admin shell + screens. Holds the dashboard stats
// and the live "pending" counts that drive the tab-bar badges (masters awaiting
// verification + reports awaiting moderation), so the shell and the dashboard
// view fetch once and read the same source.
//
// /admin/stats is the cumulative-counter source for the tab/alert badges
// (pending verifications / method-changes, + a moderation count from getReports).
// The 3 dashboard stat cards + their percent deltas come from the period-scoped
// /admin/stats/overview (E7), fetched separately with a period + offset.
// =============================================================================

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getAdminStats, getAdminStatsOverview, getReports } from '@/api/admin'
import type { AdminStatsResponse, AdminStatsOverviewResponse } from '@/api/admin'
import { extractApiError } from '@/composables/useApiError'
import i18n from '@/locales'

const { t } = i18n.global

/** Admin dashboard stats and live pending counts shared by the admin shell badges and screens. */
export const useAdminStore = defineStore('admin', () => {
  const stats = ref<AdminStatsResponse | null>(null)
  const pendingReports = ref(0)
  const loading = ref(false)
  const loaded = ref(false)
  const dashboardError = ref('')

  // Period-scoped overview (E7) for the 3 stat cards + percent deltas. Refetched
  // on period/offset change; always refetches (cheap, and the window shifts).
  const overview = ref<AdminStatsOverviewResponse | null>(null)
  const overviewLoading = ref(false)
  const overviewError = ref('')

  const pendingVerifications = computed((): number => stats.value?.pending_verifications ?? 0)
  const pendingModeration = computed((): number => pendingReports.value)
  // A2: pending master method-change requests -> red badge on the dashboard row.
  const pendingMethodChanges = computed((): number => stats.value?.pending_method_changes ?? 0)

  // Bumped by $reset: an answer (or error) that lands after it belongs to the
  // previous account and must not reach this store.
  let generation = 0

  // Load the dashboard data set (stats + pending-reports count) once. Idempotent:
  // skips while in flight and after a successful load unless `force` is passed.
  async function fetchDashboard(force = false): Promise<void> {
    if (loading.value) return
    if (loaded.value && !force) return
    const gen = generation
    loading.value = true
    dashboardError.value = ''
    try {
      const [s, reports] = await Promise.all([
        getAdminStats(),
        getReports('pending', undefined, 1, 0),
      ])
      if (gen !== generation) return
      stats.value = s
      pendingReports.value = reports.total
      loaded.value = true
    } catch (e) {
      if (gen !== generation) return
      // W14 fix (PROMPT №409): every caller fires this with `void` and no
      // .catch(), so an uncaught error here used to be a completely silent
      // unhandled rejection -- badges/stats just never updated, with nothing
      // telling the admin why. Record it so a caller can surface it.
      dashboardError.value = extractApiError(e, t('storeErrors.admin.dashboard'))
    } finally {
      if (gen === generation) loading.value = false
    }
  }

  // Load the period-scoped overview for the stat cards + deltas (D1/D6).
  async function fetchOverview(period: 'week' | 'month', offset = 0): Promise<void> {
    const gen = generation
    overviewLoading.value = true
    overviewError.value = ''
    try {
      const result = await getAdminStatsOverview(period, offset)
      if (gen === generation) overview.value = result
    } catch (e) {
      // W14 fix: same silent-unhandled-rejection issue as fetchDashboard above.
      if (gen === generation)
        overviewError.value = extractApiError(e, t('storeErrors.admin.overview'))
    } finally {
      if (gen === generation) overviewLoading.value = false
    }
  }

  /** Back to the initial state at the account boundary (platform/session.ts). */
  function $reset(): void {
    generation += 1
    stats.value = null
    pendingReports.value = 0
    loading.value = false
    loaded.value = false
    dashboardError.value = ''
    overview.value = null
    overviewLoading.value = false
    overviewError.value = ''
  }

  return {
    stats,
    pendingReports,
    loading,
    loaded,
    dashboardError,
    pendingVerifications,
    pendingModeration,
    pendingMethodChanges,
    fetchDashboard,
    overview,
    overviewLoading,
    overviewError,
    fetchOverview,
    $reset,
  }
})
