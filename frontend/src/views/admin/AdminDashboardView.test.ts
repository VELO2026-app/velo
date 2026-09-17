// =============================================================================
// VELO Frontend -- AdminDashboardView Screen Tests (probekit-screen-test)
// =============================================================================
//
// 519 lines, the value peak of the admin zone: store-heavy + 4 direct metric
// fetches (allSettled, best-effort) + money + a period/offset watch. Builds
// directly on the admin-store harness established in AdminPracticesView's
// coverage (№473) -- same real-store-seeding pattern, extended here with
// SPYING the store's ACTIONS (fetchDashboard/fetchOverview) since this screen
// actually calls them (AdminPracticesView never did).
//
// PATTERN = A (store-backed, heavy) + 4 direct metric seams + money + a period
// watch. Confirmed by reading every import AND stores/admin.ts end to end.
// Store surface used: adminStore.loading/.stats/.overview/.overviewError (read
// directly) + .pendingVerifications/.pendingModeration/.pendingMethodChanges
// (computed getters over stats/pendingReports) + the actions
// fetchDashboard() (onMounted, .vue:364) and fetchOverview(period, offset)
// (loadOverview, .vue:352-356).
//
// STORE SEED + SPY (the harness extension): real useAdminStore, real Pinia.
// `stats` / `overview` / `overviewError` / `pendingReports` are all plain
// refs returned directly from the setup store (admin.ts:83-97) -- writable
// from outside, seeded directly for render assertions (`store.stats = ...`).
// `fetchDashboard` / `fetchOverview` are spied via `vi.spyOn(store, 'name')
// .mockResolvedValue(undefined)` BEFORE mount() -- this fully replaces their
// real bodies (which would otherwise hit getAdminStats/getReports/
// getAdminStatsOverview, real network calls happy-dom can't satisfy) with a
// no-op resolve, while leaving every OTHER store ref exactly as seeded (the
// mocked fetchDashboard never touches `loading`, so a manually-seeded
// `loading=true` stays true for the whole test -- used deliberately for the
// loading-rung test below). Confirmed working empirically: the spies are
// picked up by the component's own `useAdminStore()` call because both sides
// resolve to the SAME store instance off the SAME active Pinia.
//
// DIRECT SEAMS mocked at the module boundary (@/api/admin, auto-mock):
// getCheckinMetric / getFeedbackMetric / getReturnMetric / getAdminRevenue --
// run in `Promise.allSettled` (.vue:323-328), BEST-EFFORT: a rejected one
// leaves its ref null ("—"), a fulfilled one sets its rate/cents. Exercised
// below with a genuinely mixed fixture (2 fulfilled, 2 rejected) to prove one
// rejection doesn't blank the others.
//
// DATE-DEPENDENT UTIL, VERIFIED NOT GUESSED: formatPeriodRange
// (periodRange.ts:13, `const now = new Date()`) computes the label from
// TODAY -- confirmed by reading the source (not asserting an exact string
// here, learned forward from the formatDateShort miss in the AdminMasters/
// AdminPractices coverage). The period-range assertions below only check
// non-empty + that the string CHANGES across a period/offset switch.
//
// A FINDING FROM THE MUTATION PASS ITSELF: stepNext()'s own internal
// `if (periodOffset.value < 0)` guard (.vue:249) is PROVABLY DEAD CODE as
// currently wired. Attempted the recon's requested mutation (delete the
// guard) and the "cannot step into the future" test still passed -- because
// the button's `:disabled="!canStepNext"` (.vue:118, canStepNext = .vue:251
// `periodOffset.value < 0`, BYTE-IDENTICAL to stepNext's own condition)
// already blocks the click at the DOM level before the handler ever runs. No
// real user interaction can reach the internal guard while it would fail.
// Not a bug (no incorrect behavior results, the two conditions can never
// disagree) -- reported as a minor redundancy, not fixed here (no
// defineExpose exists to call stepNext() directly, and adding one purely for
// testability is out of this task's minimal-scope). See that test's own
// comment for the full mutation trail.
//
// MONEY (NBSP): revenueValue comes from a FULFILLED getAdminRevenue call
// inside loadEngagement (.vue:308-312,332), NOT from adminStore.overview
// (that field exists on AdminStatsOverviewResponse but this screen doesn't
// read it for revenue -- verified by grepping every `overview.value` use).
// formatMoney(84250,'EUR','ru',true) verified directly in node ->
// "842,50 €" (ONE U+00A0 before the currency symbol, value under 1000 so
// no thousands-separator NBSP). norm() strips it via explicit \u00A0/
// \u202F/\u2009 escapes (see norm()'s own comment below -- a transcription
// slip in an early draft of THIS file put plain ASCII spaces in the
// character class by mistake, silently defeating the strip; escapes close
// that gap for good). The expected string is a plain ASCII space, written
// via the Write tool, never a shell heredoc.
//
// No modal, no v-show (grepped -- v-if throughout except VLoader's own v-if
// gate). No order dependence -- every test mounts its own app + fresh Pinia.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import AdminDashboardView from '@/views/admin/AdminDashboardView.vue'
import * as adminApi from '@/api/admin'
import { useAdminStore } from '@/stores/admin'
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
  return { rate_pct, visited: 0, left_review: 0, distribution: { fire: 0, good: 0, confused: 0 } }
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
let pinia: Pinia
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fetchDashboardSpy: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fetchOverviewSpy: any

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AdminDashboardView)
  app.use(pinia)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
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
function banner(): HTMLElement | null {
  return host?.querySelector('.banner') ?? null
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
  pinia = createPinia()
  setActivePinia(pinia)

  const store = useAdminStore()
  fetchDashboardSpy = vi.spyOn(store, 'fetchDashboard').mockResolvedValue(undefined)
  fetchOverviewSpy = vi.spyOn(store, 'fetchOverview').mockResolvedValue(undefined)

  vi.mocked(adminApi.getCheckinMetric).mockReset().mockResolvedValue(checkinResult(80))
  vi.mocked(adminApi.getFeedbackMetric).mockReset().mockResolvedValue(feedbackResult(60))
  vi.mocked(adminApi.getReturnMetric).mockReset().mockResolvedValue(returnResult(40))
  vi.mocked(adminApi.getAdminRevenue).mockReset().mockResolvedValue(revenueResult(84250))

  back.mockReset()
  push.mockReset()
  toastError.mockReset()
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
  describe('loading rung (.vue:253)', () => {
    it('store.loading=true and stats=null: shows the loader, no dashboard content', async () => {
      const store = useAdminStore()
      store.loading = true
      mount()
      await flush()

      expect(host?.querySelector('.v-loader')).not.toBeNull()
      expect(host?.querySelector('.admin-dashboard__stats')).toBeNull()
    })

    it('seeding stats while store.loading stays true: content shows anyway (!stats clause)', async () => {
      const store = useAdminStore()
      store.loading = true
      mount()
      await flush()
      expect(host?.querySelector('.v-loader')).not.toBeNull()

      store.stats = stats({ practices_count: 10 })
      await flush()

      // store.loading is STILL true (the mocked fetchDashboard never flips it) --
      // only seeding stats moves the ladder, proving the `&& !stats` clause.
      expect(store.loading).toBe(true)
      expect(host?.querySelector('.v-loader')).toBeNull()
      expect(host?.querySelector('.admin-dashboard__stats')).not.toBeNull()
    })
  })

  // ===========================================================================
  describe('banners + Russian plural (.vue:261-276)', () => {
    it.each([
      [1, 'мастер'],
      [3, 'мастера'],
      [5, 'мастеров'],
      [11, 'мастеров'], // the 11-14 exception
      [21, 'мастер'],
    ] as const)('%i pending verifications -> "%s"', async (n, form) => {
      const store = useAdminStore()
      store.stats = stats({ pending_verifications: n })
      mount()
      await flush()

      expect(banner()?.querySelector('.banner__title')?.textContent).toBe(
        `${n} ${form} на верификации`,
      )
    })

    it('pending_verifications = 0: no verification banner at all', async () => {
      const store = useAdminStore()
      store.stats = stats({ pending_verifications: 0 })
      mount()
      await flush()

      expect(host?.querySelectorAll('.banner--warning')).toHaveLength(0)
    })

    it('pendingReports > 0: the moderation banner renders with the right plural', async () => {
      const store = useAdminStore()
      store.stats = stats()
      store.pendingReports = 3
      mount()
      await flush()

      const alertBanner = host?.querySelector('.banner--alert')
      expect(alertBanner?.querySelector('.banner__title')?.textContent).toBe(
        '3 обращения на модерации',
      )
    })
  })

  // ===========================================================================
  describe('stat cards from overview (.vue:295-303)', () => {
    it('values + deltas + tones render per the mixed fixture', async () => {
      const store = useAdminStore()
      store.stats = stats()
      store.overview = overview()
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
    })

    it('overview absent: all three cards show "—"', async () => {
      const store = useAdminStore()
      store.stats = stats()
      store.overview = null
      mount()
      await flush()

      expect(statCard('Практик')?.querySelector('.v-stat__value')?.textContent).toBe('—')
      expect(statCard('Мастеров')?.querySelector('.v-stat__value')?.textContent).toBe('—')
      expect(statCard('Участников')?.querySelector('.v-stat__value')?.textContent).toBe('—')
    })
  })

  // ===========================================================================
  describe('revenue money (NBSP-safe, .vue:308-312) + engagement partial rejection (allSettled)', () => {
    it('a mixed fixture: fulfilled metrics render, rejected ones show "—", one rejection does not blank the others', async () => {
      vi.mocked(adminApi.getCheckinMetric).mockResolvedValue(checkinResult(80))
      vi.mocked(adminApi.getFeedbackMetric).mockRejectedValue(new Error('feedback down'))
      vi.mocked(adminApi.getReturnMetric).mockRejectedValue(new Error('return down'))
      vi.mocked(adminApi.getAdminRevenue).mockResolvedValue(revenueResult(84250))

      const store = useAdminStore()
      store.stats = stats()
      mount()
      await flush()

      expect(
        progressRow('Check-in rate')?.querySelector('.v-progress-row__value')?.textContent,
      ).toBe('80%')
      expect(
        progressRow('Feedback rate')?.querySelector('.v-progress-row__value')?.textContent,
      ).toBe('—')
      expect(progressRow('Return rate')?.querySelector('.v-progress-row__value')?.textContent).toBe(
        '—',
      )
      expect(norm(host?.querySelector('.admin-dashboard__revenue-amount')?.textContent)).toBe(
        '842,50 €',
      )
    })

    it('all 4 metrics rejected: every row/amount shows "—", no crash', async () => {
      vi.mocked(adminApi.getCheckinMetric).mockRejectedValue(new Error('down'))
      vi.mocked(adminApi.getFeedbackMetric).mockRejectedValue(new Error('down'))
      vi.mocked(adminApi.getReturnMetric).mockRejectedValue(new Error('down'))
      vi.mocked(adminApi.getAdminRevenue).mockRejectedValue(new Error('down'))

      const store = useAdminStore()
      store.stats = stats()
      expect(() => mount()).not.toThrow()
      await flush()

      expect(
        progressRow('Check-in rate')?.querySelector('.v-progress-row__value')?.textContent,
      ).toBe('—')
      expect(host?.querySelector('.admin-dashboard__revenue-amount')?.textContent).toBe('—')
    })
  })

  // ===========================================================================
  describe('period switching + refetch (watch([period, periodOffset]), .vue:245-251,358-361)', () => {
    it('selecting "Месяц" re-fetches overview + all 4 metrics with the new period', async () => {
      const store = useAdminStore()
      store.stats = stats()
      mount()
      await flush()
      expect(fetchOverviewSpy).toHaveBeenLastCalledWith('week', 0)
      expect(adminApi.getCheckinMetric).toHaveBeenLastCalledWith('week', 0)

      segmentItem('Месяц').click()
      await flush()

      expect(fetchOverviewSpy).toHaveBeenLastCalledWith('month', 0)
      expect(adminApi.getCheckinMetric).toHaveBeenLastCalledWith('month', 0)
      expect(adminApi.getFeedbackMetric).toHaveBeenLastCalledWith('month', 0)
      expect(adminApi.getReturnMetric).toHaveBeenLastCalledWith('month', 0)
      expect(adminApi.getAdminRevenue).toHaveBeenLastCalledWith('month', 0)
    })

    it('stepPrev moves the offset back and re-fetches; the range label changes', async () => {
      const store = useAdminStore()
      store.stats = stats()
      mount()
      await flush()
      const before = periodRangeText()
      expect(before).toBeTruthy()

      prevBtn()?.click()
      await flush()

      expect(fetchOverviewSpy).toHaveBeenLastCalledWith('week', -1)
      expect(periodRangeText()).toBeTruthy()
      expect(periodRangeText()).not.toBe(before)
      expect(nextBtn()?.disabled).toBe(false) // canStepNext: offset < 0
    })

    // NOT a mutation-proof for stepNext()'s own internal `if (periodOffset.value
    // < 0)` guard (.vue:249) -- attempted that mutation (removed the guard,
    // left the button's :disabled binding alone) and this test STILL PASSED,
    // because canStepNext (.vue:251, `periodOffset.value < 0`) is BYTE-
    // IDENTICAL to stepNext's own condition: a real `<button disabled>`
    // never dispatches a click at all (verified: happy-dom honours the HTML
    // disabled-button contract same as a real browser), so the DOM guard
    // fires first and the internal guard is unreachable through any real
    // user interaction. This makes .vue:249's own `if` provably dead code
    // as currently wired -- reported, not fixed (no defineExpose exists to
    // call stepNext() directly without a source change, out of this task's
    // scope). What IS tested below, and IS reachable and real: the DOM
    // disabled attribute itself correctly gates the UI at offset=0.
    it('cannot step into the future: at offset=0 the button is disabled and a click is a no-op', async () => {
      const store = useAdminStore()
      store.stats = stats()
      mount()
      await flush()
      expect(nextBtn()?.disabled).toBe(true) // canStepNext: offset(0) < 0 is false

      const callsBefore = fetchOverviewSpy.mock.calls.length
      nextBtn()?.click()
      await flush()

      expect(fetchOverviewSpy.mock.calls.length).toBe(callsBefore)
    })

    it('stepPrev then stepNext returns to offset 0 and re-fetches accordingly', async () => {
      const store = useAdminStore()
      store.stats = stats()
      mount()
      await flush()

      prevBtn()?.click()
      await flush()
      expect(fetchOverviewSpy).toHaveBeenLastCalledWith('week', -1)

      nextBtn()?.click()
      await flush()
      expect(fetchOverviewSpy).toHaveBeenLastCalledWith('week', 0)
    })

    it('switching period resets the offset to 0 even after stepping back', async () => {
      const store = useAdminStore()
      store.stats = stats()
      mount()
      await flush()

      prevBtn()?.click()
      await flush()
      expect(fetchOverviewSpy).toHaveBeenLastCalledWith('week', -1)

      segmentItem('Месяц').click()
      await flush()

      expect(fetchOverviewSpy).toHaveBeenLastCalledWith('month', 0)
      expect(nextBtn()?.disabled).toBe(true) // back to offset 0
    })
  })

  // ===========================================================================
  describe('overviewError -> toast (.vue:352-356)', () => {
    it('a pre-seeded overviewError toasts once the spied fetchOverview resolves', async () => {
      const store = useAdminStore()
      store.stats = stats()
      store.overviewError = 'Не удалось загрузить статистику за период'
      mount()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось загрузить статистику за период')
    })

    it('no overviewError: no toast fires', async () => {
      const store = useAdminStore()
      store.stats = stats()
      store.overviewError = ''
      mount()
      await flush()

      expect(toastError).not.toHaveBeenCalled()
    })
  })

  // ===========================================================================
  describe('onMounted fires all three loaders (.vue:363-367)', () => {
    it('fetchDashboard, fetchOverview, and the 4 metric calls all fire on mount', async () => {
      const store = useAdminStore()
      store.stats = stats()
      mount()
      await flush()

      expect(fetchDashboardSpy).toHaveBeenCalledTimes(1)
      expect(fetchOverviewSpy).toHaveBeenCalledWith('week', 0)
      expect(adminApi.getCheckinMetric).toHaveBeenCalledWith('week', 0)
      expect(adminApi.getFeedbackMetric).toHaveBeenCalledWith('week', 0)
      expect(adminApi.getReturnMetric).toHaveBeenCalledWith('week', 0)
      expect(adminApi.getAdminRevenue).toHaveBeenCalledWith('week', 0)
    })
  })
})
