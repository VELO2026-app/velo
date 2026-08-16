// =============================================================================
// VELO Frontend -- stores/admin.ts Unit Tests (probekit sweep #17)
// =============================================================================
//
// Covers fetchDashboard (stats + pending-reports count, in-flight + loaded
// guards, the W14 silent-unhandled-rejection fix) and fetchOverview (period-
// scoped overview for the dashboard stat cards), plus the three computed
// badges (pendingVerifications / pendingModeration / pendingMethodChanges)
// that read off that state.
//
// Mocked at the @/api/admin wrapper boundary -- the store imports named
// functions directly (getAdminStats / getAdminStatsOverview / getReports),
// same seam as bookings.test.ts / diary.test.ts. No other store is pulled in
// here, so there is nothing else to mock.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAdminStore } from '@/stores/admin'
import { ApiResponseError } from '@/api/client'
import * as adminApi from '@/api/admin'
import type {
  AdminStatsResponse,
  AdminStatsOverviewResponse,
  PaginatedReportsResponse,
} from '@/api/admin'

vi.mock('@/api/admin')

function fakeStats(overrides: Partial<AdminStatsResponse> = {}): AdminStatsResponse {
  return {
    users_count: 100,
    masters_count: 10,
    practices_count: 50,
    pending_verifications: 3,
    pending_method_changes: 1,
    ...overrides,
  }
}

function fakeReportsPage(total = 5): PaginatedReportsResponse {
  return { items: [], total, limit: 1, offset: 0 }
}

function fakeOverview(
  overrides: Partial<AdminStatsOverviewResponse> = {},
): AdminStatsOverviewResponse {
  return {
    new_users: 12,
    new_users_delta_pct: 5,
    new_masters: 2,
    new_masters_delta_pct: null,
    practices_count: 30,
    practices_delta_pct: 10,
    revenue_cents: 500000,
    revenue_delta_pct: -2,
    commission_cents: 50000,
    checkin_rate_pct: 80,
    checkin_rate_delta: 1,
    feedback_rate_pct: 60,
    feedback_rate_delta: null,
    return_rate_pct: 40,
    return_rate_delta: null,
    pending_reports: 4,
    ...overrides,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(adminApi.getAdminStats).mockReset()
  vi.mocked(adminApi.getAdminStatsOverview).mockReset()
  vi.mocked(adminApi.getReports).mockReset()
})

describe('useAdminStore', () => {
  describe('fetchDashboard', () => {
    it('on success: sets stats + pending reports count and marks loaded', async () => {
      vi.mocked(adminApi.getAdminStats).mockResolvedValue(
        fakeStats({ pending_verifications: 4, pending_method_changes: 2 }),
      )
      vi.mocked(adminApi.getReports).mockResolvedValue(fakeReportsPage(7))
      const store = useAdminStore()

      await store.fetchDashboard()

      expect(adminApi.getReports).toHaveBeenCalledWith('pending', undefined, 1, 0)
      expect(store.stats).toEqual(
        fakeStats({ pending_verifications: 4, pending_method_changes: 2 }),
      )
      expect(store.pendingReports).toBe(7)
      expect(store.loaded).toBe(true)
      expect(store.loading).toBe(false)
      expect(store.dashboardError).toBe('')
      // Derived badge getters read straight off this state.
      expect(store.pendingVerifications).toBe(4)
      expect(store.pendingMethodChanges).toBe(2)
      expect(store.pendingModeration).toBe(7)
    })

    it('on failure: falls back to the generic message via extractApiError and leaves loaded false', async () => {
      // B8 (PROMPT №747): 'server_error' is not a real backend code (the
      // base-class default is 'internal_error') and extractApiError no
      // longer reads e.detail at all, so an unmapped code -- real or, as
      // here, a fixture that was never realistic -- lands on the call
      // site's own fallback (admin.ts:60), never on the mocked detail.
      vi.mocked(adminApi.getAdminStats).mockRejectedValue(
        new ApiResponseError(500, 'Внутренняя ошибка сервера', 'server_error'),
      )
      vi.mocked(adminApi.getReports).mockResolvedValue(fakeReportsPage())
      const store = useAdminStore()

      await store.fetchDashboard()

      expect(store.dashboardError).toBe('Не удалось загрузить статистику')
      expect(store.loaded).toBe(false)
      expect(store.loading).toBe(false)
      expect(store.stats).toBeNull()
    })

    it('falls back to the generic message for a non-ApiResponseError failure', async () => {
      vi.mocked(adminApi.getAdminStats).mockRejectedValue(new Error('boom'))
      vi.mocked(adminApi.getReports).mockResolvedValue(fakeReportsPage())
      const store = useAdminStore()

      await store.fetchDashboard()

      expect(store.dashboardError).toBe('Не удалось загрузить статистику')
    })

    it('skips the network call when already loaded and force is not passed', async () => {
      vi.mocked(adminApi.getAdminStats).mockResolvedValue(fakeStats())
      vi.mocked(adminApi.getReports).mockResolvedValue(fakeReportsPage())
      const store = useAdminStore()

      await store.fetchDashboard()
      await store.fetchDashboard()

      expect(adminApi.getAdminStats).toHaveBeenCalledTimes(1)
    })

    it('force=true refetches even when already loaded', async () => {
      vi.mocked(adminApi.getAdminStats).mockResolvedValue(fakeStats())
      vi.mocked(adminApi.getReports).mockResolvedValue(fakeReportsPage())
      const store = useAdminStore()

      await store.fetchDashboard()
      await store.fetchDashboard(true)

      expect(adminApi.getAdminStats).toHaveBeenCalledTimes(2)
    })

    it('a call already in flight is dropped, not queued (in-flight guard)', async () => {
      let resolveStats: (v: AdminStatsResponse) => void = () => {}
      vi.mocked(adminApi.getAdminStats).mockReturnValue(
        new Promise<AdminStatsResponse>((resolve) => {
          resolveStats = resolve
        }),
      )
      vi.mocked(adminApi.getReports).mockResolvedValue(fakeReportsPage())
      const store = useAdminStore()

      const first = store.fetchDashboard()
      const second = store.fetchDashboard() // fired while `first` is still in flight

      resolveStats(fakeStats())
      await Promise.all([first, second])

      expect(adminApi.getAdminStats).toHaveBeenCalledTimes(1)
      expect(store.loaded).toBe(true)
    })
  })

  describe('badge getters default to 0 before any load', () => {
    it('reads zero for every badge on a fresh store', () => {
      const store = useAdminStore()

      expect(store.pendingVerifications).toBe(0)
      expect(store.pendingModeration).toBe(0)
      expect(store.pendingMethodChanges).toBe(0)
    })
  })

  describe('fetchOverview', () => {
    it('on success: stores the period-scoped overview and clears the error', async () => {
      const overview = fakeOverview()
      vi.mocked(adminApi.getAdminStatsOverview).mockResolvedValue(overview)
      const store = useAdminStore()

      await store.fetchOverview('week', -1)

      expect(adminApi.getAdminStatsOverview).toHaveBeenCalledWith('week', -1)
      expect(store.overview).toEqual(overview)
      expect(store.overviewLoading).toBe(false)
      expect(store.overviewError).toBe('')
    })

    it('on failure: falls back to the generic message and leaves the previous overview alone', async () => {
      // B8 (PROMPT №747): 'bad_period' is not a real backend code -- same
      // reasoning as fetchDashboard's test above.
      vi.mocked(adminApi.getAdminStatsOverview).mockRejectedValue(
        new ApiResponseError(400, 'Неверный период', 'bad_period'),
      )
      const store = useAdminStore()

      await store.fetchOverview('month')

      expect(store.overviewError).toBe('Не удалось загрузить статистику за период')
      expect(store.overviewLoading).toBe(false)
      expect(store.overview).toBeNull()
    })

    it('defaults offset to 0 when omitted', async () => {
      vi.mocked(adminApi.getAdminStatsOverview).mockResolvedValue(fakeOverview())
      const store = useAdminStore()

      await store.fetchOverview('week')

      expect(adminApi.getAdminStatsOverview).toHaveBeenCalledWith('week', 0)
    })
  })
})
