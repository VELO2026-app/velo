// =============================================================================
// VELO Frontend -- AdminWithdrawalsView Screen Tests (T8, PROMPT №432)
// =============================================================================
//
// The admin's payout queue: every row is real money about to leave the company.
// This screen does not move the money itself -- it decides WHICH withdrawal the
// admin opens and hands the whole record to the detail screen through router
// state (AdminWithdrawalsView.vue:164-170). So the money-critical properties
// here are: the amounts are rendered in the withdrawal's OWN currency, the net
// is gross minus fee, and the row you tap is the record that arrives on the
// next screen.
//
// PATTERN B (local-ref): items/loading/error/hasMore are refs fed by a direct
// getAdminWithdrawals() in onMounted (AdminWithdrawalsView.vue:107-212). No
// store, so no pinia -- the seam is @/api/admin.
//
// Behind roleGuard('admin') (router/index.ts:380). The guard is exercised in
// router/guards.test.ts; route meta carries no auth data (velo-idiom §6), so
// there is nothing to assert about it from here.
//
// TIME IS PINNED (vi.setSystemTime). formatRelative reads Date.now()
// (utils/adminHelpers.ts:115-131), so «2 ч назад» is wall-clock dependent;
// fixtures below are literals relative to the frozen instant.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AdminWithdrawalsView from '@/views/admin/AdminWithdrawalsView.vue'
import * as adminApi from '@/api/admin'
import { ApiResponseError } from '@/api/client'
import type { AdminWithdrawalResponse } from '@/api/admin'

vi.mock('@/api/admin')

const push = vi.fn()
const back = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back }),
}))

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), info: vi.fn() }),
}))

const NOW = new Date('2026-07-20T12:00:00Z')

function wd(id: string, overrides: Partial<AdminWithdrawalResponse> = {}): AdminWithdrawalResponse {
  return {
    id,
    user_id: 'master_1',
    amount_cents: 10000,
    fee_cents: 250,
    currency: 'EUR',
    status: 'pending',
    payout_details: { method: 'paypal', details: { email: 'm@example.com' } },
    admin_id: null,
    admin_note: null,
    approved_at: null,
    rejected_at: null,
    created_at: '2026-07-20T10:00:00Z',
    updated_at: null,
    ...overrides,
  }
}

function page(items: AdminWithdrawalResponse[], total = items.length) {
  return { items, total, limit: 20, offset: 0 }
}

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AdminWithdrawalsView)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  await nextTick()
  await nextTick()
  await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}

function rows(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.wrow') ?? [])
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
    b.textContent?.includes(label),
  ) as HTMLButtonElement | undefined
}

/** The route location the screen pushed. Throws rather than returning undefined. */
function pushedArg(): {
  name: string
  params: Record<string, string>
  state: { withdrawal: AdminWithdrawalResponse }
} {
  const call = push.mock.calls[0]
  if (!call) throw new Error('router.push was never called')
  return call[0]
}

beforeEach(() => {
  vi.setSystemTime(NOW)
  vi.mocked(adminApi.getAdminWithdrawals).mockReset().mockResolvedValue(page([]))
  push.mockReset()
  back.mockReset()
  toastError.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('AdminWithdrawalsView', () => {
  describe('state ladder', () => {
    it('shows the loader while the first page is in flight', async () => {
      vi.mocked(adminApi.getAdminWithdrawals).mockReturnValue(
        new Promise(() => {}) as Promise<ReturnType<typeof page>>,
      )
      mount()
      await flush()

      expect(host?.querySelector('.admin-withdrawals__loader')).not.toBeNull()
      expect(text()).not.toContain('Запросов на вывод нет')
    })

    it('error: shows the error state AND toasts the REAL backend detail', async () => {
      // The template's description is a hardcoded constant, but the TOAST gets
      // e.detail verbatim (AdminWithdrawalsView.vue:191-192) -- so the real
      // reason does reach the admin, just through the toast rather than the card.
      vi.mocked(adminApi.getAdminWithdrawals).mockRejectedValue(
        new ApiResponseError(503, 'Платёжный провайдер недоступен', 'psp_down'),
      )
      mount()
      await flush()

      expect(text()).toContain('Не удалось загрузить')
      expect(toastError).toHaveBeenCalledWith('Платёжный провайдер недоступен')
    })

    it('error: falls back to a generic toast on a non-API error', async () => {
      vi.mocked(adminApi.getAdminWithdrawals).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Ошибка загрузки выплат')
    })

    it('error retry: the «Повторить» button RENDERS', async () => {
      // REGRESSION GUARD (T8, find from PROMPT №432, fixed in №433).
      // This screen passes its retry button through `<template #action>`
      // (AdminWithdrawalsView.vue:40-42). VEmptyState did not declare an `action`
      // slot, and Vue drops an unmatched named slot SILENTLY -- no warning, no
      // error, no button. The admin hit a failed payout queue with nothing to
      // click and no way out but to leave the screen.
      //
      // VEmptyState now declares `action` (VEmptyState.vue:~40). This asserts the
      // button is BACK -- the failure it guards against is invisible by nature,
      // so it has to be caught here rather than by anyone looking at the screen.
      vi.mocked(adminApi.getAdminWithdrawals).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()

      expect(text()).toContain('Не удалось загрузить')
      expect(button('Повторить')).toBeDefined()
      expect(host?.querySelector('.v-empty__action')).not.toBeNull()
    })

    it('error retry: «Повторить» re-fetches and recovers into content', async () => {
      // The other half: the button exists AND is wired to loadInitial.
      vi.mocked(adminApi.getAdminWithdrawals).mockRejectedValueOnce(new TypeError('boom'))
      mount()
      await flush()
      expect(text()).toContain('Не удалось загрузить')

      vi.mocked(adminApi.getAdminWithdrawals).mockResolvedValue(page([wd('w1')]))
      button('Повторить')?.click()
      await flush()

      expect(rows()).toHaveLength(1)
      expect(text()).not.toContain('Не удалось загрузить')
    })

    it('empty: an empty queue is good news, not an error', async () => {
      mount()
      await flush()

      expect(text()).toContain('Запросов на вывод нет')
      expect(host?.querySelector('.admin-withdrawals__loader')).toBeNull()
    })

    it('content: renders a row per withdrawal the API returned', async () => {
      vi.mocked(adminApi.getAdminWithdrawals).mockResolvedValue(page([wd('w1'), wd('w2')]))
      mount()
      await flush()

      expect(rows()).toHaveLength(2)
      expect(text()).not.toContain('Запросов на вывод нет')
    })

    it('the header count is the API total, not the loaded page size', async () => {
      // 20 loaded of 57 -- printing "20" would tell the admin the queue is
      // drained when 37 payouts are still waiting.
      vi.mocked(adminApi.getAdminWithdrawals).mockResolvedValue(page([wd('w1'), wd('w2')], 57))
      mount()
      await flush()

      expect(host?.querySelector('.admin-withdrawals__count')?.textContent?.trim()).toBe('57')
    })

    it('the header count is «—» before anything is loaded, not «0»', async () => {
      // headerCount (AdminWithdrawalsView.vue:114) guards on a falsy total. A
      // literal 0 on an errored load would read as "no payouts pending".
      vi.mocked(adminApi.getAdminWithdrawals).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()

      expect(host?.querySelector('.admin-withdrawals__count')?.textContent?.trim()).toBe('—')
    })
  })

  describe('money', () => {
    it('renders the gross amount and the net after the fee', async () => {
      // net = amount_cents - fee_cents (AdminWithdrawalsView.vue:138-140). This
      // is the number the master actually receives; getting it wrong here is a
      // wrong payout shown to the person approving it.
      vi.mocked(adminApi.getAdminWithdrawals).mockResolvedValue(
        page([wd('w1', { amount_cents: 10000, fee_cents: 250 })]),
      )
      mount()
      await flush()

      expect(host?.querySelector('.wrow__amount')?.textContent).toContain('100,00')
      expect(host?.querySelector('.wrow__net')?.textContent).toContain('97,50')
    })

    it('renders each withdrawal in ITS OWN currency, not a hardcoded EUR', async () => {
      // formatMoney takes w.currency (AdminWithdrawalsView.vue:136). Painting a
      // USD payout with a € sign misstates what leaves the account.
      vi.mocked(adminApi.getAdminWithdrawals).mockResolvedValue(
        page([wd('w1', { currency: 'USD', amount_cents: 10000, fee_cents: 0 })]),
      )
      mount()
      await flush()

      const amount = host?.querySelector('.wrow__amount')?.textContent ?? ''
      expect(amount).toContain('100,00')
      expect(amount).not.toContain('€')
    })

    it('a zero-fee withdrawal shows net == gross, not «Бесплатно»', async () => {
      // allowZero=true is passed (AdminWithdrawalsView.vue:139); without it a
      // 0-cent net would render as «Бесплатно» (utils/format.ts:33).
      vi.mocked(adminApi.getAdminWithdrawals).mockResolvedValue(
        page([wd('w1', { amount_cents: 5000, fee_cents: 0 })]),
      )
      mount()
      await flush()

      expect(host?.querySelector('.wrow__net')?.textContent).toContain('50,00')
      expect(text()).not.toContain('Бесплатно')
    })
  })

  describe('status', () => {
    it('gives each status its own icon modifier and label', async () => {
      vi.mocked(adminApi.getAdminWithdrawals).mockResolvedValue(
        page([
          wd('w1', { status: 'pending' }),
          wd('w2', { status: 'approved' }),
          wd('w3', { status: 'rejected' }),
        ]),
      )
      mount()
      await flush()

      const icons = Array.from(host?.querySelectorAll('.wrow__icon') ?? [])
      expect(icons[0]?.className).toContain('wrow__icon--pending')
      expect(icons[1]?.className).toContain('wrow__icon--approved')
      expect(icons[2]?.className).toContain('wrow__icon--rejected')
      expect(icons[0]?.getAttribute('title')).toBe('На рассмотрении')
      expect(icons[1]?.getAttribute('title')).toBe('Одобрен')
      expect(icons[2]?.getAttribute('title')).toBe('Отклонён')
    })
  })

  describe('payout method label (AdminWithdrawalsView.vue:149-160)', () => {
    it('masks a bank account down to the last 4 digits', async () => {
      // The full IBAN must never be painted into a list view.
      vi.mocked(adminApi.getAdminWithdrawals).mockResolvedValue(
        page([
          wd('w1', {
            payout_details: {
              method: 'bank_transfer',
              details: { bank_name: 'N26', iban: 'DE89 3704 0044 0532 0130 00' },
            },
          }),
        ]),
      )
      mount()
      await flush()

      const sub = host?.querySelector('.wrow__sub')?.textContent ?? ''
      expect(sub).toContain('N26 •••• 3000')
      expect(sub).not.toContain('DE89')
    })

    it('falls back to «Банк» when the bank name is missing', async () => {
      vi.mocked(adminApi.getAdminWithdrawals).mockResolvedValue(
        page([wd('w1', { payout_details: { method: 'bank_transfer', details: {} } })]),
      )
      mount()
      await flush()

      expect(host?.querySelector('.wrow__sub')?.textContent).toContain('Банк')
    })

    it('shows the PayPal email', async () => {
      vi.mocked(adminApi.getAdminWithdrawals).mockResolvedValue(
        page([
          wd('w1', { payout_details: { method: 'paypal', details: { email: 'm@example.com' } } }),
        ]),
      )
      mount()
      await flush()

      expect(host?.querySelector('.wrow__sub')?.textContent).toContain('m@example.com')
    })

    it('falls back from a Revolut tag to the phone', async () => {
      vi.mocked(adminApi.getAdminWithdrawals).mockResolvedValue(
        page([wd('w1', { payout_details: { method: 'revolut', details: { phone: '+49123' } } })]),
      )
      mount()
      await flush()

      expect(host?.querySelector('.wrow__sub')?.textContent).toContain('+49123')
    })

    it('an unknown method degrades to the raw method name rather than blank', async () => {
      // A blank subtitle would hide WHERE the money is going.
      vi.mocked(adminApi.getAdminWithdrawals).mockResolvedValue(
        page([wd('w1', { payout_details: { method: 'wise', details: {} } })]),
      )
      mount()
      await flush()

      expect(host?.querySelector('.wrow__sub')?.textContent).toContain('wise')
    })

    it('survives payout_details with no details object at all', async () => {
      // `p.details ?? {}` (AdminWithdrawalsView.vue:150) -- details is optional
      // on the generated type (generated.ts:942). A throw here would blank the
      // whole payout queue.
      vi.mocked(adminApi.getAdminWithdrawals).mockResolvedValue(
        page([wd('w1', { payout_details: { method: 'bank_transfer' } })]),
      )
      mount()
      await flush()

      expect(rows()).toHaveLength(1)
      expect(host?.querySelector('.wrow__sub')?.textContent).toContain('Банк')
    })
  })

  describe('honest empty (backend gap E9)', () => {
    it('shows «—» for the master name, which the payload does not carry', async () => {
      // AdminWithdrawalsView.vue:143. Pinning this so that when E9 lands and the
      // name arrives, this test goes red and forces the row to be updated
      // instead of quietly keeping the dash forever.
      vi.mocked(adminApi.getAdminWithdrawals).mockResolvedValue(page([wd('w1')]))
      mount()
      await flush()

      expect(host?.querySelector('.wrow__sub')?.textContent).toContain('—')
    })
  })

  describe('relative time', () => {
    it('renders the age of the request against the frozen clock', async () => {
      vi.mocked(adminApi.getAdminWithdrawals).mockResolvedValue(
        page([wd('w1', { created_at: '2026-07-20T10:00:00Z' })]),
      )
      mount()
      await flush()

      expect(host?.querySelector('.wrow__time')?.textContent).toContain('2 ч назад')
    })

    it('a request from minutes ago reads in minutes', async () => {
      vi.mocked(adminApi.getAdminWithdrawals).mockResolvedValue(
        page([wd('w1', { created_at: '2026-07-20T11:45:00Z' })]),
      )
      mount()
      await flush()

      expect(host?.querySelector('.wrow__time')?.textContent).toContain('15 мин назад')
    })
  })

  describe('load more', () => {
    it('offers «Показать ещё» only while the loaded count is short of the total', async () => {
      vi.mocked(adminApi.getAdminWithdrawals).mockResolvedValue(page([wd('w1')], 5))
      mount()
      await flush()

      expect(button('Показать ещё')).toBeDefined()
    })

    it('hides «Показать ещё» once everything is loaded', async () => {
      vi.mocked(adminApi.getAdminWithdrawals).mockResolvedValue(page([wd('w1')], 1))
      mount()
      await flush()

      expect(button('Показать ещё')).toBeUndefined()
    })

    it('load-more APPENDS the next page and pages from the loaded count', async () => {
      vi.mocked(adminApi.getAdminWithdrawals).mockResolvedValue(page([wd('w1')], 2))
      mount()
      await flush()

      vi.mocked(adminApi.getAdminWithdrawals).mockResolvedValue({
        items: [wd('w2')],
        total: 2,
        limit: 20,
        offset: 1,
      })
      button('Показать ещё')?.click()
      await flush()

      expect(rows()).toHaveLength(2)
      // offset = items.value.length, not a fixed page index
      // (AdminWithdrawalsView.vue:201).
      expect(adminApi.getAdminWithdrawals).toHaveBeenLastCalledWith(undefined, 20, 1)
      expect(button('Показать ещё')).toBeUndefined()
    })

    it('a load-more failure keeps the loaded rows visible and toasts', async () => {
      // loadInitial gates its error state on `items.length === 0`
      // (AdminWithdrawalsView.vue:29) and loadMore never sets `error` at all --
      // a page-2 failure must not blank a queue the admin is working through.
      vi.mocked(adminApi.getAdminWithdrawals).mockResolvedValue(page([wd('w1')], 5))
      mount()
      await flush()

      vi.mocked(adminApi.getAdminWithdrawals).mockRejectedValue(
        new ApiResponseError(500, 'Сеть отвалилась', 'oops'),
      )
      button('Показать ещё')?.click()
      await flush()

      expect(rows()).toHaveLength(1)
      expect(text()).not.toContain('Не удалось загрузить')
      expect(toastError).toHaveBeenCalledWith('Сеть отвалилась')
    })
  })

  describe('navigation', () => {
    it('tapping a row opens THAT withdrawal, carrying the record in router state', async () => {
      // The detail screen has NO GET-by-id: it reads
      // window.history.state.withdrawal (AdminWithdrawalsView.vue:162-169). If
      // the wrong record rode along, an admin would approve a payout while
      // looking at a different one.
      vi.mocked(adminApi.getAdminWithdrawals).mockResolvedValue(
        page([wd('w1'), wd('w2', { amount_cents: 7777 })]),
      )
      mount()
      await flush()

      rows()[1]?.click()
      await flush()

      expect(push).toHaveBeenCalledTimes(1)
      const arg = pushedArg()
      expect(arg.name).toBe('admin-withdrawal-detail')
      expect(arg.params).toEqual({ id: 'w2' })
      expect(arg.state.withdrawal.id).toBe('w2')
      expect(arg.state.withdrawal.amount_cents).toBe(7777)
    })

    it('the record handed over is a detached CLONE, not a live reference', async () => {
      // JSON.parse(JSON.stringify(w)) (AdminWithdrawalsView.vue:168). History
      // state must be structured-cloneable; passing the reactive proxy itself
      // throws DataCloneError in a real browser.
      const original = wd('w1')
      vi.mocked(adminApi.getAdminWithdrawals).mockResolvedValue(page([original]))
      mount()
      await flush()

      rows()[0]?.click()
      await flush()

      const handed = pushedArg().state.withdrawal
      expect(handed).toEqual(original)
      expect(handed).not.toBe(original)
    })

    it('the back button goes back', async () => {
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.admin-withdrawals__top button')?.click()
      await flush()

      expect(back).toHaveBeenCalled()
    })
  })
})
