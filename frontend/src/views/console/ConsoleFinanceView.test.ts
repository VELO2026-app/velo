// =============================================================================
// VELO Frontend -- ConsoleFinanceView screen tests (FE-262, slice 4, FE-267)
// =============================================================================
//
// The Finance module of the web console is two tabs over what the API has
// today: the payout queue (only where the instance has the payments option)
// and the promo codes. The tables themselves are tested with their panels
// (components/console/finance/*.test.ts); this file proves what the screen
// owns: which tabs exist, which one opens, that the tab rides the URL and
// that the number on the payout tab is the count of requests awaiting a
// verdict.
//
// The screen mounts with a real router (memory history), a real Pinia and
// Pinia Colada, as in production; the seam mocked is @/api/admin. The option
// is set the way the app gets it (applyInstanceConfig, as /config.json does).
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { coladaOptions } from '@/composables/queries/setup'
import ConsoleFinanceView from '@/views/console/ConsoleFinanceView.vue'
import * as adminApi from '@/api/admin'
import { applyInstanceConfig } from '@/platform/instance'
import type { AdminWithdrawalResponse } from '@/api/admin'

vi.mock('@/api/admin')

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), info: vi.fn() }),
}))

function request(id: string): AdminWithdrawalResponse {
  return {
    id,
    user_id: `user_${id}`,
    amount_cents: 10000,
    fee_cents: 100,
    currency: 'EUR',
    status: 'pending',
    payout_details: { method: 'paypal', details: { email: `${id}@example.com` } },
    admin_id: null,
    admin_note: null,
    approved_at: null,
    rejected_at: null,
    created_at: '2026-11-24T09:12:00Z',
    updated_at: null,
  }
}

let app: App | null = null
let host: HTMLElement | null = null
let router: Router

async function mount(url = '/console/finance'): Promise<HTMLElement> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/console/finance', name: 'console-finance', component: { render: () => null } },
    ],
  })
  await router.push(url)
  await router.isReady()
  host = document.createElement('div')
  document.body.appendChild(host)
  const pinia = createPinia()
  setActivePinia(pinia)
  app = createApp(ConsoleFinanceView)
    .use(createTestI18n())
    .use(router)
    .use(pinia)
    .use(PiniaColada, coladaOptions)
  app.mount(host)
  await flush()
  return host
}

async function flush(): Promise<void> {
  for (let n = 0; n < 6; n++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

/** The tabs of the module: the first row of tabs, above the panel's own. */
function moduleTabs(): string[] {
  const strip = host?.querySelector('.console-page__tabs')
  return Array.from(strip?.querySelectorAll('[role="tab"]') ?? []).map(
    (el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  )
}
function moduleTab(label: string): HTMLButtonElement {
  const found = Array.from(
    host?.querySelectorAll<HTMLButtonElement>('.console-page__tabs [role="tab"]') ?? [],
  ).find((el) => el.textContent?.trim().startsWith(label))
  if (!found) throw new Error(`no tab ${label}`)
  return found
}
function panel(): 'withdrawals' | 'promos' | null {
  if (host?.querySelector('[data-testid="finance-withdrawals"]')) return 'withdrawals'
  if (host?.querySelector('[data-testid="finance-promos"]')) return 'promos'
  return null
}

let pending: AdminWithdrawalResponse[]

beforeEach(() => {
  pending = [request('w_1'), request('w_2'), request('w_3')]
  vi.mocked(adminApi.getAdminWithdrawals)
    .mockReset()
    .mockImplementation(async (_status, limit = 20, offset = 0) => ({
      items: pending.slice(offset, offset + limit),
      total: pending.length,
      limit,
      offset,
    }))
  vi.mocked(adminApi.getAdminPromos)
    .mockReset()
    .mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 })
  toastError.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  applyInstanceConfig({})
})

describe('ConsoleFinanceView', () => {
  describe('an instance with the payments option', () => {
    it('has the payout tab, with the count awaiting a verdict, and the promo tab; the payouts open first', async () => {
      await mount()

      expect(moduleTabs()).toEqual(['Выплаты · 3', 'Промокоды'])
      expect(panel()).toBe('withdrawals')
    })

    it('shows no number when no request awaits a verdict', async () => {
      pending = []
      await mount()

      expect(moduleTabs()).toEqual(['Выплаты', 'Промокоды'])
    })

    it('a failed counter leaves the tab without a number and says nothing: the list tells its own failures', async () => {
      vi.mocked(adminApi.getAdminWithdrawals).mockImplementation(async (_status, limit = 20) =>
        limit === 1
          ? Promise.reject(new Error('down'))
          : { items: pending, total: pending.length, limit, offset: 0 },
      )
      await mount()

      expect(moduleTabs()).toEqual(['Выплаты', 'Промокоды'])
      expect(panel()).toBe('withdrawals')
      expect(toastError).not.toHaveBeenCalled()
    })

    it('the tab rides the URL: a tab press writes it, a kept link opens it', async () => {
      await mount()

      moduleTab('Промокоды').click()
      await flush()
      expect(router.currentRoute.value.query).toEqual({ tab: 'promos' })
      expect(panel()).toBe('promos')

      moduleTab('Выплаты').click()
      await flush()
      expect(router.currentRoute.value.query).toEqual({ tab: 'withdrawals' })
      expect(panel()).toBe('withdrawals')

      app?.unmount()
      host?.remove()
      await mount('/console/finance?tab=promos')
      expect(panel()).toBe('promos')
    })

    it('a new tab drops the status, the filter and the page of the old one', async () => {
      await mount('/console/finance?tab=withdrawals&status=approved&page=2')

      moduleTab('Промокоды').click()
      await flush()

      expect(router.currentRoute.value.query).toEqual({ tab: 'promos' })
    })

    it('a tab the URL cannot mean opens the payouts', async () => {
      await mount('/console/finance?tab=revenue')

      expect(panel()).toBe('withdrawals')
    })
  })

  describe('an instance without the payments option', () => {
    beforeEach(() => {
      applyInstanceConfig({ options: { payments: 'false' } })
    })

    it('has only the promo codes: no tab strip, no payout request is made', async () => {
      await mount()

      expect(moduleTabs()).toEqual([])
      expect(panel()).toBe('promos')
      expect(adminApi.getAdminPromos).toHaveBeenCalled()
      expect(adminApi.getAdminWithdrawals).not.toHaveBeenCalled()
    })

    it('a kept link to the payouts opens the promo codes', async () => {
      await mount('/console/finance?tab=withdrawals')

      expect(panel()).toBe('promos')
      expect(adminApi.getAdminWithdrawals).not.toHaveBeenCalled()
    })
  })
})
