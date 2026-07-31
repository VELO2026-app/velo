// =============================================================================
// VELO Frontend -- MasterFinanceView Screen Tests (T8, PROMPT №432)
// =============================================================================
//
// Where a master asks for their money. POST /masters/me/withdraw opens the
// payout an admin later approves in AdminWithdrawalDetailView -- these two
// screens are the two ends of the same money pipe, and this is the end that
// decides the AMOUNT. So the assertions that matter are the amount arithmetic
// (min, fee, net, "withdraw all"), the not-more-than-you-have guard, and the
// masking of the payout account.
//
// PATTERN A (store-backed) for the balance + a local-ref form on top:
//   - available/frozen/payout come from useMasterStore (MasterFinanceView.vue:31-33).
//     The store is a DEPENDENCY, not the thing under test, so it is mocked
//     wholesale behind getters over a mutable object -- the guards.test.ts trick
//     (velo-idiom §5). A real store here would drag its own network path in.
//   - the amount input, the payout form and the history are local refs fed by
//     direct @/api/masters calls -- that is the seam for everything else.
//
// TIME IS PINNED (vi.setSystemTime). formatDateShort compares the entry against
// `new Date()` to decide «Сегодня»/«Вчера» (utils/format.ts:65-67), so history
// rows are wall-clock dependent; fixtures are literals relative to the frozen
// instant. useViewerTimezone is mocked to a FIXED zone -- it reads the auth
// profile, and an unpinned zone would drift the calendar-date comparison.
//
// MIN_WITHDRAWAL_EUROS=50 / WITHDRAWAL_FEE_EUROS=2 mirror backend config
// (utils/constants.ts:34,37). The tests below use those constants rather than
// literals ONLY where the arithmetic is the point; the boundary tests hardcode
// 50 deliberately, so that changing the constant fails loudly here instead of
// silently agreeing with itself.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import MasterFinanceView from '@/views/master/MasterFinanceView.vue'
import * as mastersApi from '@/api/masters'
import { ApiResponseError } from '@/api/client'
import type { WithdrawalResponse, PayoutDetails } from '@/api/types'

vi.mock('@/api/masters')

const back = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), back }),
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: vi.fn() }),
}))

// Pinned: the real one derives from the auth profile, and the zone feeds
// formatDateShort's calendar-date comparison.
vi.mock('@/composables/useViewerTimezone', async () => {
  const { computed } = await import('vue')
  return { useViewerTimezone: () => computed(() => 'UTC') }
})

// Dependency store behind getters -- tests mutate `profile` instead of
// re-mocking (velo-idiom §5). `profile` is deliberately a plain reactive-free
// object: the screen writes to profile.payout directly (MasterFinanceView.vue:160),
// and these tests assert the API call rather than the re-render for that path.
interface Profile {
  available_cents: number
  frozen_cents: number
  payout: PayoutDetails | null
}
const masterState: { profile: Profile | null } = { profile: null }
const fetchMyProfile = vi.fn()
vi.mock('@/stores/master', () => ({
  useMasterStore: () => ({
    get profile() {
      return masterState.profile
    },
    fetchMyProfile,
  }),
}))

const NOW = new Date('2026-07-20T12:00:00Z')

function withdrawal(id: string, overrides: Partial<WithdrawalResponse> = {}): WithdrawalResponse {
  return {
    id,
    user_id: 'master_1',
    amount_cents: 10000,
    fee_cents: 200,
    currency: 'EUR',
    status: 'pending',
    payout_details: { method: 'paypal', details: { email: 'm@example.com' } },
    admin_id: null,
    admin_note: null,
    approved_at: null,
    rejected_at: null,
    created_at: '2026-07-20T09:00:00Z',
    updated_at: null,
    ...overrides,
  }
}

function page(items: WithdrawalResponse[], total = items.length) {
  return { items, total, limit: 20, offset: 0 }
}

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(MasterFinanceView)
  app.mount(host)
  return host
}

// onMounted awaits fetchMyProfile() THEN reloadHistory() -- two sequential
// awaits plus the re-render, so three ticks is not enough (velo-idiom §3:
// count the awaits, do not copy the number).
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

// Intl's ru currency format groups thousands with U+00A0, not the space on
// your keyboard: «1 234,56 €». An assertion typed with a plain space fails on
// every amount over 999. Written as ESCAPES, not literal characters -- the
// literals are invisible in a diff and the next editor would "tidy" them away
// without noticing what broke.
function norm(s: string | null | undefined): string {
  // Intl's ru currency format groups thousands with U+00A0 (a NON-BREAKING
  // space), not the space on your keyboard -- so a toContain('1 000,00') typed
  // normally fails on every amount over 999 while the screen is perfectly
  // correct. Matched by ESCAPE, never by pasting the literal character: the
  // literal is invisible in a diff and the next editor would "tidy" it into a
  // plain space without noticing what broke.
  return (s ?? '').replace(/[\u00A0\u202F\u2009]/g, ' ')
}

function text(): string {
  return norm(host?.textContent)
}

function pick(selector: string): string {
  return norm(host?.querySelector(selector)?.textContent)
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
    b.textContent?.includes(label),
  ) as HTMLButtonElement | undefined
}

function amountField(): HTMLInputElement | null {
  return host?.querySelector<HTMLInputElement>('.finance-view__amount-row input') ?? null
}

function typeAmount(value: string): void {
  const input = amountField()
  if (!input) throw new Error('amount input not rendered -- is a payout method configured?')
  input.value = value
  input.dispatchEvent(new Event('input'))
}

const PAYPAL: PayoutDetails = { method: 'paypal', details: { email: 'master@example.com' } }

beforeEach(() => {
  vi.setSystemTime(NOW)
  masterState.profile = { available_cents: 100000, frozen_cents: 0, payout: PAYPAL }
  fetchMyProfile.mockReset().mockResolvedValue(undefined)
  vi.mocked(mastersApi.getMyWithdrawals).mockReset().mockResolvedValue(page([]))
  vi.mocked(mastersApi.createWithdrawal).mockReset().mockResolvedValue(withdrawal('w1'))
  vi.mocked(mastersApi.updatePayoutDetails).mockReset().mockResolvedValue(PAYPAL)
  vi.mocked(mastersApi.deletePayout).mockReset().mockResolvedValue(undefined)
  back.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('MasterFinanceView', () => {
  describe('balance', () => {
    it('renders the available balance from the profile', async () => {
      masterState.profile = { available_cents: 123456, frozen_cents: 0, payout: PAYPAL }
      mount()
      await flush()

      expect(pick('.finance-view__balance-value')).toContain('1 234,56')
    })

    it('a zero balance renders as €0,00, not «Бесплатно»', async () => {
      masterState.profile = { available_cents: 0, frozen_cents: 0, payout: PAYPAL }
      mount()
      await flush()

      expect(pick('.finance-view__balance-value')).toContain('0,00')
      expect(text()).not.toContain('Бесплатно')
    })

    it('shows frozen money separately -- it is real money in review', async () => {
      // Kept beyond the SVG on purpose (MasterFinanceView.vue:35). Hiding it
      // would make a master think a pending withdrawal's money vanished.
      masterState.profile = { available_cents: 5000, frozen_cents: 7500, payout: PAYPAL }
      mount()
      await flush()

      expect(text()).toContain('На рассмотрении:')
      expect(pick('.finance-view__balance-frozen')).toContain('75,00')
    })

    it('hides the frozen line when nothing is frozen, rather than showing €0,00', async () => {
      masterState.profile = { available_cents: 5000, frozen_cents: 0, payout: PAYPAL }
      mount()
      await flush()

      expect(host?.querySelector('.finance-view__balance-frozen')).toBeNull()
      expect(text()).not.toContain('На рассмотрении')
    })
  })

  describe('no payout method configured', () => {
    it('offers NO amount field and says what to do first', async () => {
      // Without a payout method there is nowhere to send the money, so the
      // request form is gated entirely (MasterFinanceView.vue:157,191).
      masterState.profile = { available_cents: 100000, frozen_cents: 0, payout: null }
      mount()
      await flush()

      expect(amountField()).toBeNull()
      expect(button('Запросить вывод')).toBeUndefined()
      expect(text()).toContain('Сначала добавьте способ выплаты')
    })
  })

  describe('amount validation (nothing reaches the API)', () => {
    it('refuses below the €50 minimum', async () => {
      mount()
      await flush()
      typeAmount('49.99')
      await flush()

      expect(text()).toContain('Минимальная сумма вывода')
      expect(button('Запросить вывод')?.disabled).toBe(true)
    })

    it('accepts EXACTLY the €50 minimum -- it is in range, not out', async () => {
      // `cents < MIN * 100` is strict (MasterFinanceView.vue:242-244); an
      // off-by-one to <= would reject the single most likely amount.
      mount()
      await flush()
      typeAmount('50')
      await flush()

      expect(text()).not.toContain('Минимальная сумма вывода')
      expect(button('Запросить вывод')?.disabled).toBe(false)
    })

    it('refuses more than the available balance', async () => {
      masterState.profile = { available_cents: 10000, frozen_cents: 0, payout: PAYPAL }
      mount()
      await flush()
      typeAmount('100.01')
      await flush()

      expect(text()).toContain('Недостаточно средств')
      expect(button('Запросить вывод')?.disabled).toBe(true)
    })

    it('accepts EXACTLY the available balance', async () => {
      masterState.profile = { available_cents: 10000, frozen_cents: 0, payout: PAYPAL }
      mount()
      await flush()
      typeAmount('100')
      await flush()

      expect(text()).not.toContain('Недостаточно средств')
      expect(button('Запросить вывод')?.disabled).toBe(false)
    })

    it('does NOT count frozen money as withdrawable', async () => {
      // available_cents only (MasterFinanceView.vue:31,246). Letting a master
      // draw against money already in review is a double-spend of their balance.
      masterState.profile = { available_cents: 6000, frozen_cents: 50000, payout: PAYPAL }
      mount()
      await flush()
      typeAmount('600')
      await flush()

      expect(text()).toContain('Недостаточно средств')
      expect(button('Запросить вывод')?.disabled).toBe(true)
    })

    it('refuses a zero amount', async () => {
      mount()
      await flush()
      typeAmount('0')
      await flush()

      expect(text()).toContain('Введите корректную сумму')
      expect(button('Запросить вывод')?.disabled).toBe(true)
    })

    it('an empty field shows no scolding but still blocks submit', async () => {
      mount()
      await flush()

      expect(text()).not.toContain('Введите корректную сумму')
      expect(button('Запросить вывод')?.disabled).toBe(true)
    })
  })

  describe('fee arithmetic (what the master actually receives)', () => {
    it('shows the net after the €2 fee', async () => {
      mount()
      await flush()
      typeAmount('100')
      await flush()

      expect(text()).toContain('Вы получите')
      expect(text()).toContain('98,00')
    })

    // formattedNetAmount's Math.max(0, ...) floor (MasterFinanceView.vue:257) is
    // deliberately NOT tested: the "Вы получите" line only renders when
    // amountError is empty (:169), which requires amount >= €50, where
    // amount - €2 fee is always positive. The floor is unreachable through the
    // DOM today. It becomes reachable -- and worth a test -- the day the
    // minimum drops below the fee.

    it('converts the typed euro string to cents WITHOUT float math', async () => {
      // W-1 (MasterFinanceView.vue:236): parseFloat('0.575') * 100 rounds wrong.
      // '99.99' must reach the API as exactly 9999 -- a cent off is a real
      // payout error.
      mount()
      await flush()
      typeAmount('99.99')
      await flush()

      button('Запросить вывод')?.click()
      await flush()

      expect(mastersApi.createWithdrawal).toHaveBeenCalledWith(9999)
    })
  })

  describe('«Вывести все»', () => {
    it('fills the field with the FULL available balance, to the cent', async () => {
      // W-2 (MasterFinanceView.vue:230-232): centsToEurString avoids float math.
      masterState.profile = { available_cents: 12345, frozen_cents: 0, payout: PAYPAL }
      mount()
      await flush()

      button('Вывести все')?.click()
      await flush()

      expect(amountField()?.value).toBe('123.45')
      expect(button('Запросить вывод')?.disabled).toBe(false)
    })

    it('fills only AVAILABLE, never available+frozen', async () => {
      masterState.profile = { available_cents: 12345, frozen_cents: 99999, payout: PAYPAL }
      mount()
      await flush()

      button('Вывести все')?.click()
      await flush()

      expect(amountField()?.value).toBe('123.45')
      expect(text()).not.toContain('Недостаточно средств')
    })

    it('«Вывести все» on a sub-minimum balance fills, but submit stays blocked', async () => {
      // fillMaxAmount does not consult the minimum -- the amountError computed
      // is what holds the line.
      masterState.profile = { available_cents: 1000, frozen_cents: 0, payout: PAYPAL }
      mount()
      await flush()

      button('Вывести все')?.click()
      await flush()

      expect(amountField()?.value).toBe('10.00')
      expect(text()).toContain('Минимальная сумма вывода')
      expect(button('Запросить вывод')?.disabled).toBe(true)
    })
  })

  describe('submitting the request', () => {
    it('sends the amount in cents, clears the field, and refreshes balance + history', async () => {
      // The balance MUST be re-fetched (MasterFinanceView.vue:270-273): the money
      // just moved to frozen, and a stale available would let the master
      // immediately request it again.
      mount()
      await flush()
      typeAmount('100')
      await flush()
      vi.mocked(mastersApi.getMyWithdrawals).mockClear()
      fetchMyProfile.mockClear()

      button('Запросить вывод')?.click()
      await flush()

      expect(mastersApi.createWithdrawal).toHaveBeenCalledWith(10000)
      expect(toastSuccess).toHaveBeenCalledWith(
        'Запрос на вывод отправлен. Ожидайте решения администратора.',
      )
      expect(amountField()?.value).toBe('')
      expect(fetchMyProfile).toHaveBeenCalledWith(true)
      expect(mastersApi.getMyWithdrawals).toHaveBeenCalled()
    })

    it('surfaces the REAL backend detail on failure and KEEPS the amount', async () => {
      // «Insufficient funds» from the server is the only thing that tells the
      // master why. Clearing the field on failure would also make them retype it.
      vi.mocked(mastersApi.createWithdrawal).mockRejectedValue(
        new ApiResponseError(409, 'Недостаточно средств на балансе', 'no_funds'),
      )
      mount()
      await flush()
      typeAmount('100')
      await flush()

      button('Запросить вывод')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Недостаточно средств на балансе')
      expect(toastSuccess).not.toHaveBeenCalled()
      expect(amountField()?.value).toBe('100')
    })

    it('falls back to a generic message on a non-API error', async () => {
      vi.mocked(mastersApi.createWithdrawal).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()
      typeAmount('100')
      await flush()

      button('Запросить вывод')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось создать запрос')
    })

    it('does NOT create two withdrawals when the button is hit twice in flight', async () => {
      // The `submitting` re-entry guard (MasterFinanceView.vue:263). A second
      // POST is a duplicate payout request against the same balance.
      let resolve!: (v: WithdrawalResponse) => void
      vi.mocked(mastersApi.createWithdrawal).mockReturnValue(
        new Promise((r) => {
          resolve = r
        }),
      )
      mount()
      await flush()
      typeAmount('100')
      await flush()

      button('Запросить вывод')?.click()
      await nextTick()
      button('Запросить вывод')?.click()
      await nextTick()

      expect(mastersApi.createWithdrawal).toHaveBeenCalledTimes(1)

      resolve(withdrawal('w1'))
      await flush()
    })
  })

  describe('the configured payout method, masked', () => {
    it('masks an IBAN to the last 4', async () => {
      masterState.profile = {
        available_cents: 100000,
        frozen_cents: 0,
        payout: {
          method: 'bank_transfer',
          details: { iban: 'DE89 3704 0044 0532 0130 00', account_holder: 'Анна П.' },
        },
      }
      mount()
      await flush()

      expect(pick('.finance-view__card-num')).toContain('IBAN ···· 3000')
      expect(text()).not.toContain('DE89')
      expect(pick('.finance-view__card-name')).toContain('Анна П.')
    })

    it('masks a PayPal email to its first letter + domain', async () => {
      masterState.profile = {
        available_cents: 100000,
        frozen_cents: 0,
        payout: { method: 'paypal', details: { email: 'master@example.com' } },
      }
      mount()
      await flush()

      expect(pick('.finance-view__card-num')).toContain('m···@example.com')
      expect(text()).not.toContain('master@example.com')
    })

    it('masks a card number to the last 4', async () => {
      masterState.profile = {
        available_cents: 100000,
        frozen_cents: 0,
        payout: { method: 'card', details: { card_number: '4111111111111234' } },
      }
      mount()
      await flush()

      expect(pick('.finance-view__card-num')).toContain('Карта ···· 1234')
      expect(text()).not.toContain('4111111111111234')
    })

    it('degrades to a safe label when the details are empty rather than showing «···· »', async () => {
      masterState.profile = {
        available_cents: 100000,
        frozen_cents: 0,
        payout: { method: 'bank_transfer', details: {} },
      }
      mount()
      await flush()

      expect(pick('.finance-view__card-num')).toContain('IBAN настроен')
    })
  })

  describe('editing the payout method', () => {
    it('requires an IBAN for a bank transfer', async () => {
      masterState.profile = { available_cents: 100000, frozen_cents: 0, payout: null }
      mount()
      await flush()

      button('Добавить')?.click()
      await flush()
      button('Сохранить')?.click()
      await flush()

      expect(mastersApi.updatePayoutDetails).not.toHaveBeenCalled()
      expect(text()).toContain('IBAN обязателен')
    })

    it('saves a bank transfer with the trimmed IBAN', async () => {
      masterState.profile = { available_cents: 100000, frozen_cents: 0, payout: null }
      mount()
      await flush()
      button('Добавить')?.click()
      await flush()

      const iban = host?.querySelector<HTMLInputElement>('.finance-view__payout-form input')
      iban!.value = '  DE89370400440532013000  '
      iban!.dispatchEvent(new Event('input'))
      await flush()

      button('Сохранить')?.click()
      await flush()

      expect(mastersApi.updatePayoutDetails).toHaveBeenCalledWith({
        method: 'bank_transfer',
        details: { iban: 'DE89370400440532013000' },
      })
      expect(toastSuccess).toHaveBeenCalledWith('Реквизиты сохранены')
    })

    it('surfaces the REAL backend detail when saving fails', async () => {
      vi.mocked(mastersApi.updatePayoutDetails).mockRejectedValue(
        new ApiResponseError(422, 'IBAN не прошёл проверку', 'bad_iban'),
      )
      masterState.profile = { available_cents: 100000, frozen_cents: 0, payout: null }
      mount()
      await flush()
      button('Добавить')?.click()
      await flush()

      const iban = host?.querySelector<HTMLInputElement>('.finance-view__payout-form input')
      iban!.value = 'DE00'
      iban!.dispatchEvent(new Event('input'))
      await flush()
      button('Сохранить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('IBAN не прошёл проверку')
      expect(toastSuccess).not.toHaveBeenCalled()
    })
  })

  describe('removing the payout method', () => {
    it('the X calls the real DELETE and reports it', async () => {
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.finance-view__card-x')?.click()
      await flush()

      expect(mastersApi.deletePayout).toHaveBeenCalledTimes(1)
      expect(toastSuccess).toHaveBeenCalledWith('Способ выплаты удалён')
    })

    it('a FAILED delete does not claim the method is gone', async () => {
      vi.mocked(mastersApi.deletePayout).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.finance-view__card-x')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось удалить способ выплаты')
      expect(toastSuccess).not.toHaveBeenCalled()
    })
  })

  describe('history', () => {
    it('shows the loader while the first page is in flight', async () => {
      vi.mocked(mastersApi.getMyWithdrawals).mockReturnValue(
        new Promise(() => {}) as Promise<ReturnType<typeof page>>,
      )
      mount()
      await flush()

      expect(host?.querySelector('.finance-view__loader')).not.toBeNull()
    })

    it('empty: says so rather than rendering an empty list', async () => {
      mount()
      await flush()

      expect(host?.querySelector('.finance-view__empty-text')).not.toBeNull()
    })

    it('renders each withdrawal with its amount and its own status icon + label', async () => {
      vi.mocked(mastersApi.getMyWithdrawals).mockResolvedValue(
        page([
          withdrawal('w1', { amount_cents: 10000, status: 'pending' }),
          withdrawal('w2', { amount_cents: 5000, status: 'approved' }),
          withdrawal('w3', { amount_cents: 7500, status: 'rejected' }),
        ]),
      )
      mount()
      await flush()

      const items = Array.from(host?.querySelectorAll('.finance-view__hitem') ?? [])
      expect(items).toHaveLength(3)
      expect(text()).toContain('100,00')
      expect(text()).toContain('50,00')
      expect(text()).toContain('75,00')

      const icons = Array.from(host?.querySelectorAll('.finance-view__hicon') ?? [])
      expect(icons[0]?.getAttribute('title')).toBe('На рассмотрении')
      expect(icons[1]?.getAttribute('title')).toBe('Одобрен')
      expect(icons[2]?.getAttribute('title')).toBe('Отклонён')
    })

    it('a history failure is swallowed -- the balance card must still work', async () => {
      // reloadHistory's bare `catch {}` is deliberate (MasterFinanceView.vue:301-303):
      // a broken history must not cost the master the ability to see and
      // withdraw their balance.
      vi.mocked(mastersApi.getMyWithdrawals).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()

      expect(pick('.finance-view__balance-value')).toContain('1 000,00')
      expect(button('Запросить вывод')).toBeDefined()
      expect(toastError).not.toHaveBeenCalled()
    })

    it('offers «Показать ещё» only while the loaded count is short of the total', async () => {
      vi.mocked(mastersApi.getMyWithdrawals).mockResolvedValue(page([withdrawal('w1')], 5))
      mount()
      await flush()

      expect(host?.querySelector('.finance-view__load-more')).not.toBeNull()
    })

    it('hides «Показать ещё» once everything is loaded', async () => {
      vi.mocked(mastersApi.getMyWithdrawals).mockResolvedValue(page([withdrawal('w1')], 1))
      mount()
      await flush()

      expect(host?.querySelector('.finance-view__load-more')).toBeNull()
    })

    it('load-more APPENDS the next page from the loaded offset', async () => {
      vi.mocked(mastersApi.getMyWithdrawals).mockResolvedValue(page([withdrawal('w1')], 2))
      mount()
      await flush()

      vi.mocked(mastersApi.getMyWithdrawals).mockResolvedValue({
        items: [withdrawal('w2')],
        total: 2,
        limit: 20,
        offset: 1,
      })
      host?.querySelector<HTMLElement>('.finance-view__load-more')?.click()
      await flush()

      expect(Array.from(host?.querySelectorAll('.finance-view__hitem') ?? [])).toHaveLength(2)
      expect(mastersApi.getMyWithdrawals).toHaveBeenLastCalledWith(20, 1)
    })
  })

  describe('navigation', () => {
    it('the header back arrow goes back', async () => {
      mount()
      await flush()

      const backBtn = Array.from(host?.querySelectorAll('button') ?? []).find(
        (b) => b.getAttribute('aria-label') === 'Назад' || b.className.includes('back'),
      )
      backBtn?.click()
      await flush()

      expect(back).toHaveBeenCalled()
    })
  })
})
