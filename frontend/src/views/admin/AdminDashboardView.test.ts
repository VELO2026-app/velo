// =============================================================================
// VELO Frontend -- AdminDashboardView Screen Tests
// =============================================================================
//
// Every read of this screen is a Pinia Colada query (composables/queries/
// admin.ts, FE-181): the counters (getAdminStats + getReports -- banners and
// the loader), the overview cards for the selected window
// (getAdminStatsOverview) and the four best-effort figures for the same
// window (getCheckinMetric / getFeedbackMetric / getReturnMetric /
// getAdminRevenue). All of them are mocked at the module boundary
// (@/api/admin); the screen mounts with a real Pinia + Colada, a fresh pair
// per mount, so a test proves what a request returns on screen.
//
// formatPeriodRange computes its label from TODAY: the period-range
// assertions only check that the label CHANGES across a window switch.
//
// MONEY (NBSP): formatMoney(84250,'EUR','ru',true) -> "842,50 €" with one
// U+00A0 before the currency symbol; norm() strips it via explicit escapes.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { PiniaColada, useQueryCache } from '@pinia/colada'
import { adminKeys } from '@/composables/queries/adminKeys'
import { coladaOptions } from '@/composables/queries/setup'
import AdminDashboardView from '@/views/admin/AdminDashboardView.vue'
import * as adminApi from '@/api/admin'
import type { AdminStatsResponse, AdminStatsOverviewResponse } from '@/api/admin'

vi.mock('@/api/admin')

const back = vi.fn()
const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ back, push }),
}))

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, info: vi.fn(), success: vi.fn() }),
}))

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function stats(overrides: Partial<AdminStatsResponse> = {}): AdminStatsResponse {
  return {
    users_count: 0,
    masters_count: 0,
    practices_count: 0,
    pending_verifications: 0,
    pending_method_changes: 0,
    ...overrides,
  }
}

function overview(overrides: Partial<AdminStatsOverviewResponse> = {}): AdminStatsOverviewResponse {
  return {
    new_users: 12,
    new_users_delta_pct: 5, // positive -> "+5%", up
    new_masters: 3,
    new_masters_delta_pct: -2, // negative -> "-2%", down
    practices_count: 45,
    practices_delta_pct: null, // null -> no delta element at all, muted
    revenue_cents: 0,
    revenue_delta_pct: null,
    commission_cents: 0,
    checkin_rate_pct: 0,
    checkin_rate_delta: null,
    feedback_rate_pct: 0,
    feedback_rate_delta: null,
    return_rate_pct: 0,
    return_rate_delta: null,
    pending_reports: 0,
    ...overrides,
  }
}

function checkinResult(rate_pct: number) {
  return { rate_pct, total_records: 0, checked_in: 0, series: [], low_practices: [] }
}
function feedbackResult(rate_pct: number) {
  return {
    rate_pct,
    visited: 0,
    left_review: 0,
    distribution: { bad: 0, low: 0, neutral: 0, good: 0, fire: 0 },
  }
}
function returnResult(rate_pct: number) {
  return { rate_pct, total_users: 0, returning: 0, top_users: [] }
}
function revenueResult(revenue_cents: number) {
  return { revenue_cents, commission_cents: 0, payout_cents: 0, per_master: [] }
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  const pinia = createPinia()
  setActivePinia(pinia)
  app = createApp(AdminDashboardView)
    .use(createTestI18n())
    .use(pinia)
    .use(PiniaColada, coladaOptions)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

/** Seed the counters' answer: /admin/stats and the pending-reports total. */
function counters(overrides: Partial<AdminStatsResponse> = {}, pendingReports = 0): void {
  vi.mocked(adminApi.getAdminStats).mockResolvedValue(stats(overrides))
  vi.mocked(adminApi.getReports).mockResolvedValue({
    items: [],
    total: pendingReports,
    limit: 1,
    offset: 0,
  })
}

function rateText(label: string): string | null | undefined {
  return progressRow(label)?.querySelector('.v-progress-row__value')?.textContent
}

// U+00A0 NBSP / U+202F narrow-no-break-space / U+2009 thin-space, written as
// explicit \u escapes (not literal invisible bytes): an earlier draft of
// this exact function put plain ASCII spaces inside the character class by
// mistake (a transcription slip copying an invisible character), which
// silently defeated the NBSP strip. Escapes remove that ambiguity entirely --
// verified afterward via node -e reading this file back, byte for byte.
function norm(s: string | null | undefined): string {
  return (s ?? '').replace(/[\u00A0\u202F\u2009]/g, ' ')
}

function statCard(label: string): HTMLElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLElement>('.v-stat') ?? []).find(
    (c) => c.querySelector('.v-stat__label')?.textContent?.trim() === label,
  )
}
function segmentItem(label: string): HTMLButtonElement {
  const btn = Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-segment__item') ?? []).find(
    (b) => b.textContent?.includes(label),
  )
  if (!btn) throw new Error(`no segment item containing «${label}»`)
  return btn
}
function progressRow(label: string): HTMLElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLElement>('.v-progress-row') ?? []).find(
    (r) => r.querySelector('.v-progress-row__label')?.textContent?.trim() === label,
  )
}
function prevBtn(): HTMLButtonElement | null {
  return host?.querySelector<HTMLButtonElement>('.admin-dashboard__week-nav--prev') ?? null
}
function nextBtn(): HTMLButtonElement | null {
  return (
    Array.from(host?.querySelectorAll<HTMLButtonElement>('.admin-dashboard__week-nav') ?? []).find(
      (b) => !b.classList.contains('admin-dashboard__week-nav--prev'),
    ) ?? null
  )
}
function periodRangeText(): string | undefined {
  return host?.querySelector('.admin-dashboard__week-range')?.textContent?.trim()
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  counters()
  vi.mocked(adminApi.getAdminStatsOverview).mockReset().mockResolvedValue(overview())
  vi.mocked(adminApi.getCheckinMetric).mockReset().mockResolvedValue(checkinResult(80))
  vi.mocked(adminApi.getFeedbackMetric).mockReset().mockResolvedValue(feedbackResult(60))
  vi.mocked(adminApi.getReturnMetric).mockReset().mockResolvedValue(returnResult(40))
  vi.mocked(adminApi.getAdminRevenue).mockReset().mockResolvedValue(revenueResult(84250))
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('AdminDashboardView', () => {
  // ===========================================================================
  describe('loading rung', () => {
    it('shows the loader until the counters answer, then the dashboard', async () => {
      let answer!: (v: AdminStatsResponse) => void
      vi.mocked(adminApi.getAdminStats).mockReturnValue(
        new Promise((resolve) => {
          answer = resolve
        }),
      )
      mount()
      await flush()
      expect(host?.querySelector('.v-loader')).not.toBeNull()
      expect(host?.querySelector('.admin-dashboard__stats')).toBeNull()

      answer(stats())
      await flush()

      expect(host?.querySelector('.v-loader')).toBeNull()
      expect(host?.querySelector('.admin-dashboard__stats')).not.toBeNull()
    })

    it('failed counters: an error banner with Retry, not silently absent banners (FE-242)', async () => {
      vi.mocked(adminApi.getAdminStats).mockRejectedValueOnce(new Error('down'))
      mount()
      await flush()

      expect(host?.querySelector('[data-testid="counters-error"]')).not.toBeNull()

      counters({ pending_verifications: 2 })
      Array.from(host!.querySelectorAll('button'))
        .find((b) => b.textContent?.includes('Повторить'))!
        .click()
      await flush()

      expect(host?.querySelector('[data-testid="counters-error"]')).toBeNull()
      expect(host?.textContent).toContain('2')
    })

    it('a background refetch of the counters keeps the dashboard, no loader', async () => {
      mount()
      await flush()
      vi.mocked(adminApi.getAdminStats).mockReturnValue(new Promise(() => {}))

      // Another screen asks for the counters again (or the window expired).
      // A failed refetch rejects here; the screen hears of it through the entry.
      useQueryCache()
        .invalidateQueries({ key: adminKeys.stats() })
        .catch(() => {})
      await flush()
      expect(adminApi.getAdminStats).toHaveBeenCalledTimes(2)

      expect(host?.querySelector('.v-loader')).toBeNull()
      expect(host?.querySelector('.admin-dashboard__stats')).not.toBeNull()
    })
  })

  // ===========================================================================
  describe('banners + Russian plural', () => {
    it.each([
      [0, null],
      [1, 'мастер'],
      [3, 'мастера'],
      [5, 'мастеров'],
      [11, 'мастеров'], // the 11-14 exception
      [21, 'мастер'],
    ] as const)('%i pending verifications -> "%s"', async (n, form) => {
      counters({ pending_verifications: n })
      mount()
      await flush()

      const title = host?.querySelector('.banner--warning .banner__title')?.textContent
      expect(title ?? null).toBe(form === null ? null : `${n} ${form} на верификации`)
    })

    it('pending method-change requests: a red badge with their count on the requests row', async () => {
      counters({ pending_method_changes: 4 })
      mount()
      await flush()

      expect(
        host?.querySelector('.admin-dashboard__row-trailing .v-badge')?.textContent?.trim(),
      ).toBe('4')
    })

    // FE-100: Moderation (i18n:adminScreens.adminReports.moderationTab) opens
    // on the tickets tab (i18n:adminScreens.adminReports.tabTickets) by
    // default; the banner counts pending REPORTS, so it lands on the
    // complaints tab (i18n:adminScreens.adminReports.tabComplaints).
    it('pending reports: the moderation banner counts them and opens «Модерация» on «Жалобы»', async () => {
      counters({}, 3)
      mount()
      await flush()

      const alertBanner = host?.querySelector<HTMLElement>('.banner--alert')
      expect(alertBanner?.querySelector('.banner__title')?.textContent).toBe(
        '3 обращения на модерации',
      )

      alertBanner?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'admin-reports', query: { tab: 'complaints' } })
    })
  })

  // ===========================================================================
  describe('stat cards from the overview', () => {
    it('values + deltas + tones render per the mixed fixture; no toast', async () => {
      mount()
      await flush()

      const practices = statCard('Практик')!
      expect(practices.querySelector('.v-stat__value')?.textContent).toBe('45')
      // null delta -> pctDelta returns '' -> VStatCard's v-if="delta" never renders the element.
      expect(practices.querySelector('.v-stat__delta')).toBeNull()

      const masters = statCard('Мастеров')!
      expect(masters.querySelector('.v-stat__value')?.textContent).toBe('3')
      expect(masters.querySelector('.v-stat__delta')?.textContent).toBe('-2%')
      expect(
        masters.querySelector('.v-stat__delta')?.classList.contains('v-stat__delta--down'),
      ).toBe(true)

      const participants = statCard('Участников')!
      expect(participants.querySelector('.v-stat__value')?.textContent).toBe('12')
      expect(participants.querySelector('.v-stat__delta')?.textContent).toBe('+5%')
      expect(
        participants.querySelector('.v-stat__delta')?.classList.contains('v-stat__delta--up'),
      ).toBe(true)
      expect(toastError).not.toHaveBeenCalled()
    })

    it('a failed overview: all three cards show "—" and the admin is told (W14)', async () => {
      vi.mocked(adminApi.getAdminStatsOverview).mockRejectedValue(new Error('down'))
      mount()
      await flush()

      expect(statCard('Практик')?.querySelector('.v-stat__value')?.textContent).toBe('—')
      expect(statCard('Мастеров')?.querySelector('.v-stat__value')?.textContent).toBe('—')
      expect(statCard('Участников')?.querySelector('.v-stat__value')?.textContent).toBe('—')
      expect(toastError).toHaveBeenCalledWith('Не удалось загрузить статистику за период')
    })
  })

  // ===========================================================================
  describe('revenue money (NBSP-safe) + engagement, best-effort', () => {
    it('a mixed fixture: fulfilled metrics render, rejected ones show "—", one rejection does not blank the others', async () => {
      vi.mocked(adminApi.getFeedbackMetric).mockRejectedValue(new Error('feedback down'))
      vi.mocked(adminApi.getReturnMetric).mockRejectedValue(new Error('return down'))
      mount()
      await flush()

      expect(rateText('Check-in rate')).toBe('80%')
      expect(rateText('Feedback rate')).toBe('—')
      expect(rateText('Return rate')).toBe('—')
      expect(norm(host?.querySelector('.admin-dashboard__revenue-amount')?.textContent)).toBe(
        '842,50 €',
      )
    })

    it('a failed revenue shows "—" and leaves the rates alone', async () => {
      vi.mocked(adminApi.getAdminRevenue).mockRejectedValue(new Error('revenue down'))
      mount()
      await flush()

      expect(host?.querySelector('.admin-dashboard__revenue-amount')?.textContent).toBe('—')
      expect(rateText('Check-in rate')).toBe('80%')
    })
  })

  // ===========================================================================
  describe('navigation', () => {
    it('the engagement rows open their drill-in for the SELECTED window (P1)', async () => {
      mount()
      await flush()
      prevBtn()?.click()
      await flush()

      progressRow('Check-in rate')?.click()
      progressRow('Feedback rate')?.click()
      progressRow('Return rate')?.click()

      const window = { period: 'week', offset: '-1' }
      expect(push).toHaveBeenCalledWith({ name: 'admin-checkin-rate', query: window })
      expect(push).toHaveBeenCalledWith({ name: 'admin-feedback-rate', query: window })
      expect(push).toHaveBeenCalledWith({ name: 'admin-return-rate', query: window })
    })

    it('the stat cards open the platform lists', async () => {
      mount()
      await flush()

      statCard('Практик')?.click()
      statCard('Мастеров')?.click()
      statCard('Участников')?.click()

      expect(push).toHaveBeenCalledWith({ name: 'admin-practices' })
      expect(push).toHaveBeenCalledWith({ name: 'admin-masters' })
      expect(push).toHaveBeenCalledWith({ name: 'admin-participants' })
    })
  })

  // ===========================================================================
  describe('the period window', () => {
    it('selecting "Месяц" asks for the month window: the overview and all 4 figures', async () => {
      mount()
      await flush()
      expect(adminApi.getAdminStatsOverview).toHaveBeenLastCalledWith('week', 0)

      segmentItem('Месяц').click()
      await flush()

      expect(adminApi.getAdminStatsOverview).toHaveBeenLastCalledWith('month', 0)
      expect(adminApi.getCheckinMetric).toHaveBeenLastCalledWith('month', 0)
      expect(adminApi.getFeedbackMetric).toHaveBeenLastCalledWith('month', 0)
      expect(adminApi.getReturnMetric).toHaveBeenLastCalledWith('month', 0)
      expect(adminApi.getAdminRevenue).toHaveBeenLastCalledWith('month', 0)
    })

    it('stepPrev moves the window back; the range label changes and → unlocks', async () => {
      mount()
      await flush()
      const before = periodRangeText()
      expect(before).toBeTruthy()
      expect(nextBtn()?.disabled).toBe(true) // no stepping into the future

      prevBtn()?.click()
      await flush()

      expect(adminApi.getAdminStatsOverview).toHaveBeenLastCalledWith('week', -1)
      expect(periodRangeText()).toBeTruthy()
      expect(periodRangeText()).not.toBe(before)
      expect(nextBtn()?.disabled).toBe(false)

      nextBtn()?.click()
      await flush()

      expect(periodRangeText()).toBe(before)
      expect(nextBtn()?.disabled).toBe(true)
    })

    it('a window switch keeps the previous cards until the new answer lands', async () => {
      mount()
      await flush()
      let answer!: (v: AdminStatsOverviewResponse) => void
      vi.mocked(adminApi.getAdminStatsOverview).mockReturnValue(
        new Promise((resolve) => {
          answer = resolve
        }),
      )

      prevBtn()?.click()
      await flush()
      expect(statCard('Практик')?.querySelector('.v-stat__value')?.textContent).toBe('45')

      answer(overview({ practices_count: 7 }))
      await flush()
      expect(statCard('Практик')?.querySelector('.v-stat__value')?.textContent).toBe('7')
    })

    it('switching period resets the offset to 0 even after stepping back', async () => {
      mount()
      await flush()

      prevBtn()?.click()
      await flush()
      segmentItem('Месяц').click()
      await flush()

      expect(adminApi.getAdminStatsOverview).toHaveBeenLastCalledWith('month', 0)
      expect(nextBtn()?.disabled).toBe(true) // back to offset 0
    })

    it('a window whose answer failed is told once; picked back and answered, it is not told again', async () => {
      mount()
      await flush()
      vi.mocked(adminApi.getAdminStatsOverview).mockRejectedValueOnce(new Error('down'))
      segmentItem('Месяц').click()
      await flush()
      expect(toastError).toHaveBeenCalledTimes(1)

      segmentItem('Неделя').click()
      await flush()
      segmentItem('Месяц').click() // asked again, answers this time
      await flush()

      expect(toastError).toHaveBeenCalledTimes(1)
      expect(statCard('Практик')?.querySelector('.v-stat__value')?.textContent).toBe('45')
    })

    // Owner decision 19.11: a failed window shows the failure, never the
    // previous window's numbers.
    it('a failed overview for the new window shows "—" on the cards, never the previous window', async () => {
      mount()
      await flush()
      expect(statCard('Практик')?.querySelector('.v-stat__value')?.textContent).toBe('45')

      vi.mocked(adminApi.getAdminStatsOverview).mockRejectedValue(new Error('down'))
      prevBtn()?.click()
      await flush()

      expect(statCard('Практик')?.querySelector('.v-stat__value')?.textContent).toBe('—')
      expect(statCard('Участников')?.querySelector('.v-stat__value')?.textContent).toBe('—')
    })

    it('a failed figure for the new window shows "—", never the previous window value', async () => {
      mount()
      await flush()
      expect(rateText('Check-in rate')).toBe('80%')

      vi.mocked(adminApi.getCheckinMetric).mockRejectedValue(new Error('down'))
      prevBtn()?.click()
      await flush()

      expect(rateText('Check-in rate')).toBe('—')
      expect(rateText('Feedback rate')).toBe('60%')
    })
  })
})
