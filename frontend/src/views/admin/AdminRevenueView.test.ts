// =============================================================================
// VELO Frontend -- AdminRevenueView Screen Tests (T8, PROMPT №432)
// =============================================================================
//
// Platform revenue: GMV, commission, payout, and the per-master breakdown. It
// moves no money itself, but it is the number the business reads to decide what
// it earned -- a wrong figure here is a wrong decision, and a SILENT one, since
// nothing downstream contradicts it.
//
// PATTERN B (local-ref): data/loading/error are refs fed by a direct
// getAdminRevenue() in onMounted + a watch on `period`
// (AdminRevenueView.vue:124-137). No store, so no pinia -- the seam is @/api/admin.
//
// This screen binds :description="error" (AdminRevenueView.vue:37), so the REAL
// backend message reaches the card rather than only a toast -- asserted below.
// Several sibling admin screens swallow it into a toast instead; this is the
// behaviour they should be repaired TO.
//
// Its retry button sits in VEmptyState's DEFAULT slot (AdminRevenueView.vue:39).
// That is one of 24 such sites and it has always worked. The 11 sites that used
// `<template #action>` did NOT -- VEmptyState never declared that slot and Vue
// dropped it silently (found PROMPT №432, fixed №433: `action` is now declared,
// and both slots render into .v-empty__action). Migrating these 24 onto the
// named slot was scoped in №433 and NOT done -- see that report.
//
// No time pinning needed -- this screen reads no clock.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AdminRevenueView from '@/views/admin/AdminRevenueView.vue'
import * as adminApi from '@/api/admin'
import { ApiResponseError } from '@/api/client'
import type { AdminRevenueResponse, AdminRevenuePerMaster } from '@/api/types'

vi.mock('@/api/admin')

const back = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), back }),
}))

function master(id: string, overrides: Partial<AdminRevenuePerMaster> = {}): AdminRevenuePerMaster {
  return {
    master_id: id,
    name: `Мастер ${id}`,
    earned_cents: 5000,
    payout_cents: 4000,
    ...overrides,
  }
}

function revenue(overrides: Partial<AdminRevenueResponse> = {}): AdminRevenueResponse {
  return {
    revenue_cents: 100000,
    commission_cents: 20000,
    payout_cents: 80000,
    per_master: [],
    ...overrides,
  }
}

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AdminRevenueView)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  await nextTick()
  await nextTick()
  await nextTick()
}

// Intl's ru currency format groups thousands with U+00A0, not the space on
// your keyboard: «1 000,00 €». An assertion typed with a plain space fails on
// every amount over 999. Written as ESCAPES, not literal characters -- the
// literals are invisible in a diff and the next editor would "tidy" them away
// without noticing what broke.
function text(): string {
  // Intl's ru currency format groups thousands with U+00A0 (a NON-BREAKING
  // space), not the space on your keyboard -- so a toContain('1 000,00') typed
  // normally fails on every amount over 999 while the screen is perfectly
  // correct. Matched by ESCAPE, never by pasting the literal character: the
  // literal is invisible in a diff and the next editor would "tidy" it into a
  // plain space without noticing what broke.
  return (host?.textContent ?? '').replace(/[\u00A0\u202F\u2009]/g, ' ')
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
    b.textContent?.includes(label),
  ) as HTMLButtonElement | undefined
}

function rows(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.admin-detail__items > *') ?? [])
}

beforeEach(() => {
  vi.mocked(adminApi.getAdminRevenue).mockReset().mockResolvedValue(revenue())
  back.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('AdminRevenueView', () => {
  describe('state ladder', () => {
    it('shows the loader while the fetch is in flight', async () => {
      vi.mocked(adminApi.getAdminRevenue).mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(host?.querySelector('.admin-detail__loader')).not.toBeNull()
      expect(text()).not.toContain('По мастерам')
    })

    it('error: surfaces the generic fallback in the card (unmapped code)', async () => {
      // :description="error" (AdminRevenueView.vue:37) + error.value =
      // extractApiError(e, 'Ошибка загрузки') (:130). B8 (PROMPT №747):
      // 'reports_down' is not a real backend code -- unmapped, lands on that
      // fallback; extractApiError no longer reads e.detail at all, so this
      // screen no longer differs from its siblings the way the old comment
      // described.
      vi.mocked(adminApi.getAdminRevenue).mockRejectedValue(
        new ApiResponseError(503, 'Хранилище отчётов недоступно', 'reports_down'),
      )
      mount()
      await flush()

      expect(text()).toContain('Не удалось загрузить выручку')
      expect(text()).toContain('Ошибка загрузки')
    })

    it('error: falls back to a generic message on a non-API error', async () => {
      vi.mocked(adminApi.getAdminRevenue).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()

      expect(text()).toContain('Ошибка загрузки')
      expect(text()).not.toContain('boom')
    })

    it('error retry: «Повторить» RENDERS and recovers into content', async () => {
      // The default slot, which VEmptyState has always rendered. Kept as the
      // guard for THIS site's spelling; AdminWithdrawalsView.test.ts guards the
      // `#action` spelling that used to vanish.
      vi.mocked(adminApi.getAdminRevenue).mockRejectedValueOnce(new TypeError('boom'))
      mount()
      await flush()
      expect(text()).toContain('Не удалось загрузить выручку')

      const retry = button('Повторить')
      expect(retry).toBeDefined()

      vi.mocked(adminApi.getAdminRevenue).mockResolvedValue(revenue({ revenue_cents: 12345 }))
      retry?.click()
      await flush()

      expect(text()).toContain('123,45')
      expect(text()).not.toContain('Не удалось загрузить выручку')
    })

    it('empty: totals still render, with an honest «Данных пока нет» per-master', async () => {
      // A period with no masters is not an error -- the totals are still the
      // answer, and they are zero.
      mount()
      await flush()

      expect(text()).toContain('Данных пока нет')
      expect(rows()).toHaveLength(0)
      expect(text()).toContain('По мастерам')
    })
  })

  describe('money', () => {
    it('renders revenue, commission and payout from the API', async () => {
      vi.mocked(adminApi.getAdminRevenue).mockResolvedValue(
        revenue({ revenue_cents: 100000, commission_cents: 20000, payout_cents: 80000 }),
      )
      mount()
      await flush()

      expect(text()).toContain('1 000,00')
      expect(text()).toContain('200,00')
      expect(text()).toContain('800,00')
    })

    it('zero totals render as €0,00, NOT «Бесплатно»', async () => {
      // money() passes allowZero=true (AdminRevenueView.vue:113-116) precisely
      // because the seed practices are free, so real totals ARE 0. Without it
      // the revenue hero would read «Бесплатно» (utils/format.ts:33).
      vi.mocked(adminApi.getAdminRevenue).mockResolvedValue(
        revenue({ revenue_cents: 0, commission_cents: 0, payout_cents: 0 }),
      )
      mount()
      await flush()

      expect(text()).toContain('0,00')
      expect(text()).not.toContain('Бесплатно')
    })

    it('renders each master with what they earned and what was paid out', async () => {
      vi.mocked(adminApi.getAdminRevenue).mockResolvedValue(
        revenue({
          per_master: [master('m1', { name: 'Анна', earned_cents: 5000, payout_cents: 4000 })],
        }),
      )
      mount()
      await flush()

      expect(text()).toContain('Анна')
      expect(text()).toContain('Выплачено: 40,00')
      expect(host?.querySelector('.admin-revenue__earned')?.textContent).toContain('50,00')
      expect(rows()).toHaveLength(1)
    })

    it('renders a row per master the API returned', async () => {
      vi.mocked(adminApi.getAdminRevenue).mockResolvedValue(
        revenue({ per_master: [master('m1'), master('m2'), master('m3')] }),
      )
      mount()
      await flush()

      expect(rows()).toHaveLength(3)
      expect(text()).not.toContain('Данных пока нет')
    })
  })

  describe('period toggle', () => {
    it('defaults to «Неделя», matching the backend default', async () => {
      // AdminRevenueView.vue:98. Diverging from the backend default would label
      // a week's revenue as a month's.
      mount()
      await flush()

      expect(adminApi.getAdminRevenue).toHaveBeenCalledWith('week')
      expect(text()).toContain('Выручка за неделю')
    })

    it('switching to «Месяц» re-fetches for that period and relabels the hero', async () => {
      // The label is driven by the SAME ref as the fetch (AdminRevenueView.vue:103-105),
      // so the hero cannot say "за неделю" over month data.
      mount()
      await flush()

      button('Месяц')?.click()
      await flush()

      expect(adminApi.getAdminRevenue).toHaveBeenLastCalledWith('month')
      expect(text()).toContain('Выручка за месяц')
      expect(text()).not.toContain('Выручка за неделю')
    })

    it('re-picking the CURRENT period does not re-fetch', async () => {
      // watch(period, load) fires on CHANGE only (AdminRevenueView.vue:137).
      mount()
      await flush()
      expect(adminApi.getAdminRevenue).toHaveBeenCalledTimes(1)

      button('Неделя')?.click()
      await flush()

      expect(adminApi.getAdminRevenue).toHaveBeenCalledTimes(1)
    })

    it("the switched period renders ITS data, not the previous period's", async () => {
      vi.mocked(adminApi.getAdminRevenue).mockResolvedValue(revenue({ revenue_cents: 10000 }))
      mount()
      await flush()
      expect(text()).toContain('100,00')

      vi.mocked(adminApi.getAdminRevenue).mockResolvedValue(revenue({ revenue_cents: 4444400 }))
      button('Месяц')?.click()
      await flush()

      expect(text()).toContain('44 444,00')
    })

    // selectPeriod's union-narrowing guard (AdminRevenueView.vue:108-111) is
    // deliberately NOT tested: no DOM path can emit a third value today, so any
    // test of it would have to call the internal directly and would assert the
    // test's own setup rather than the screen. It becomes worth covering the day
    // a third segment option is added.
  })

  describe('navigation', () => {
    it('the back button goes back', async () => {
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.admin-detail__top button')?.click()
      await flush()

      expect(back).toHaveBeenCalled()
    })
  })
})
