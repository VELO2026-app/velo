// =============================================================================
// VELO Frontend -- AdminWithdrawalDetailView Screen Tests (T8, PROMPT №432)
// =============================================================================
//
// The single highest-stakes screen in the app: this is where an admin actually
// releases a payout. POST /admin/withdrawals/:id/approve moves real money out.
// So the assertions that matter are: the numbers the admin reads before
// approving are the withdrawal's own, approve fires for the RIGHT id and only
// through the full gate, and a non-pending request offers no buttons at all.
//
// PATTERN B (local-ref): `w` and the flow flags are refs; the seam is @/api/admin
// (approveWithdrawal / rejectWithdrawal). No store, so no pinia.
//
// THE WITHDRAWAL ARRIVES VIA window.history.state, NOT VIA A FETCH. There is no
// GET-by-id endpoint (AdminWithdrawalDetailView.vue:116-119) -- the list hands
// the record over in router state. So each test seeds history.replaceState()
// BEFORE mounting; the screen reads it during setup, so seeding it afterwards is
// too late.
//
// MODALS AND SHEETS ARE DRIVEN FOR REAL, NOT STUBBED (velo-idiom §2). VModal and
// VBottomSheet both `Teleport to="body"` (VModal.vue:20, VBottomSheet.vue:18),
// so their DOM is queried from document.body, not the mount root (SC-07) -- and
// both leak past unmount, so afterEach reaps them (see the note there).
//
// STUB SCOPE, stated honestly (AdminWithdrawalDetailView.vue:12-15): the 2FA code
// has NO backend. approve() takes only an optional note; the OTP is a pure UI
// gate. The tests below therefore assert that the gate is a GATE (approve does
// not fire until six digits are in) and explicitly do NOT claim the code is
// verified anywhere -- it is not.
//
// No time pinning needed -- this screen reads no clock.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AdminWithdrawalDetailView from '@/views/admin/AdminWithdrawalDetailView.vue'
import * as adminApi from '@/api/admin'
import { ApiResponseError } from '@/api/client'
import type { AdminWithdrawalResponse } from '@/api/admin'

vi.mock('@/api/admin')

const push = vi.fn()
const back = vi.fn()
const replace = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back, replace }),
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: vi.fn() }),
}))

function wd(id: string, overrides: Partial<AdminWithdrawalResponse> = {}): AdminWithdrawalResponse {
  return {
    id,
    user_id: 'master_1',
    amount_cents: 10000,
    fee_cents: 250,
    currency: 'EUR',
    status: 'pending',
    payout_details: {
      method: 'bank_transfer',
      details: { bank_name: 'N26', iban: 'DE89 3704 0044 0532 0130 00', account_holder: 'Анна П.' },
    },
    admin_id: null,
    admin_note: null,
    approved_at: null,
    rejected_at: null,
    created_at: '2026-07-20T10:00:00Z',
    updated_at: null,
    ...overrides,
  }
}

let app: App | null = null
let host: HTMLElement | null = null

/** Seed router state, then mount. Order matters: the screen reads it in setup. */
function mountWith(withdrawal: AdminWithdrawalResponse | null): HTMLElement {
  window.history.replaceState(withdrawal ? { withdrawal } : {}, '')
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AdminWithdrawalDetailView)
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

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
    b.textContent?.includes(label),
  ) as HTMLButtonElement | undefined
}

/** Teleported to body (VModal.vue:20 / VBottomSheet.vue:18) -- NOT under host. */
function bodyButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(label),
  ) as HTMLButtonElement | undefined
}

// SCOPED to the 2FA modal on purpose. A bare search for «Подтвердить» across
// document.body also matches ConfirmPaymentModal's «Подтвердить 2FA», which is
// still parked in the DOM behind it -- the test would click the confirm button
// again and silently never approve.
function tfaSubmit(): HTMLButtonElement | undefined {
  const tfa = document.body.querySelector('.tfa')
  return Array.from(tfa?.querySelectorAll('button') ?? []).find(
    (b) => b.textContent?.trim() === 'Подтвердить',
  ) as HTMLButtonElement | undefined
}

function rowValue(key: string): string {
  const rows = Array.from(host?.querySelectorAll('.wd__row') ?? [])
  const row = rows.find((r) => r.querySelector('.wd__k')?.textContent?.trim() === key)
  return row?.querySelector('.wd__v')?.textContent?.trim() ?? ''
}

/** Type a full 6-digit OTP into the teleported TwoFactorModal. */
async function type2fa(code = '123456'): Promise<void> {
  const boxes = Array.from(document.body.querySelectorAll<HTMLInputElement>('.tfa__box'))
  if (boxes.length !== 6) throw new Error(`expected 6 OTP boxes, found ${boxes.length}`)
  for (const [i, digit] of [...code].entries()) {
    const box = boxes[i]
    if (!box) throw new Error(`no OTP box at index ${i}`)
    box.value = digit
    box.dispatchEvent(new Event('input'))
  }
  await flush()
}

/** Walk the real gate: Подтвердить -> ConfirmPaymentModal -> TwoFactorModal. */
async function openTwoFa(): Promise<void> {
  button('Подтвердить')?.click()
  await flush()
  bodyButton('Подтвердить 2FA')?.click()
  await flush()
}

beforeEach(() => {
  vi.mocked(adminApi.approveWithdrawal).mockReset().mockResolvedValue(wd('w1'))
  vi.mocked(adminApi.rejectWithdrawal).mockReset().mockResolvedValue(wd('w1'))
  push.mockReset()
  back.mockReset()
  replace.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null

  // MANDATORY. A teleported overlay that has been CLOSED leaks past unmount:
  // VModal/VBottomSheet wrap it in a <Transition>, and when `open` flips to false
  // Vue holds the leaving element pending a transitionend that happy-dom never
  // fires. The next test then finds the DEAD modal first in document order,
  // clicks it, and nothing happens -- silently. (SC-07 covers QUERYING teleported
  // content; it does not cover reaping it. See the report.)
  document.body
    .querySelectorAll('.v-modal__overlay, .v-sheet__overlay')
    .forEach((el) => el.remove())

  window.history.replaceState({}, '')
  vi.clearAllMocks()
})

describe('AdminWithdrawalDetailView', () => {
  describe('arriving without router state (W-5)', () => {
    it('bounces to the list instead of stranding the admin on a blank screen', async () => {
      // The record arrives ONLY via router state, so a deep-link or a reload
      // leaves w null (AdminWithdrawalDetailView.vue:121-127). router.replace,
      // NOT push -- a dead entry must not go on the history stack.
      mountWith(null)
      await flush()

      expect(replace).toHaveBeenCalledWith('/admin/withdrawals')
      expect(push).not.toHaveBeenCalled()
    })

    it('renders the unavailable placeholder and NO approve/reject buttons', async () => {
      // Belt and braces: the bounce is async, so for one frame this screen is
      // visible. It must not offer money buttons with no withdrawal behind them.
      mountWith(null)
      await flush()

      expect(text()).toContain('Запрос недоступен')
      expect(button('Подтвердить')).toBeUndefined()
      expect(button('Отклонить')).toBeUndefined()
    })
  })

  describe('what the admin reads before approving', () => {
    it('renders gross, fee and net from the handed-over record', async () => {
      // These three numbers are the entire basis for the approve decision.
      mountWith(wd('w1', { amount_cents: 10000, fee_cents: 250 }))
      await flush()

      expect(host?.querySelector('.wd__hero-amount')?.textContent).toContain('100,00')
      expect(rowValue('Комиссия провайдера')).toContain('2,50')
      expect(rowValue('К получению')).toContain('97,50')
    })

    it("renders in the withdrawal's OWN currency, not a hardcoded EUR", async () => {
      mountWith(wd('w1', { currency: 'USD', amount_cents: 10000, fee_cents: 0 }))
      await flush()

      const hero = host?.querySelector('.wd__hero-amount')?.textContent ?? ''
      expect(hero).toContain('100,00')
      expect(hero).not.toContain('€')
    })

    it('a zero fee renders as money, not «Бесплатно»', async () => {
      // money() passes allowZero=true (AdminWithdrawalDetailView.vue:152).
      mountWith(wd('w1', { fee_cents: 0 }))
      await flush()

      expect(rowValue('Комиссия провайдера')).toContain('0,00')
      expect(text()).not.toContain('Бесплатно')
    })

    it('masks the bank account to the last 4 digits', async () => {
      mountWith(wd('w1'))
      await flush()

      expect(rowValue('Банк')).toBe('N26 •••• 3000')
      expect(text()).not.toContain('DE89')
    })

    it('falls back to the bank account holder for the master name (backend gap)', async () => {
      // The payload carries no master name (AdminWithdrawalDetailView.vue:147-148).
      mountWith(wd('w1'))
      await flush()

      expect(host?.querySelector('.wd__hero-master')?.textContent).toContain('Анна П.')
    })

    it('shows «—» when even the account holder is missing, rather than a blank', async () => {
      mountWith(wd('w1', { payout_details: { method: 'paypal', details: { email: 'a@b.c' } } }))
      await flush()

      expect(host?.querySelector('.wd__hero-master')?.textContent?.trim()).toBe('—')
      expect(rowValue('Банк')).toBe('a@b.c')
    })
  })

  describe('a request that is already processed', () => {
    it('an approved request offers NO buttons and says so', async () => {
      // Re-approving a paid-out withdrawal is a double payment. The buttons are
      // gated on isPending (AdminWithdrawalDetailView.vue:50,138).
      mountWith(wd('w1', { status: 'approved' }))
      await flush()

      expect(text()).toContain('Запрос уже обработан')
      expect(text()).toContain('Одобрен')
      expect(button('Подтвердить')).toBeUndefined()
      expect(button('Отклонить')).toBeUndefined()
    })

    it('a rejected request offers NO buttons and says so', async () => {
      mountWith(wd('w1', { status: 'rejected' }))
      await flush()

      expect(text()).toContain('Запрос уже обработан')
      expect(text()).toContain('Отклонён')
      expect(button('Подтвердить')).toBeUndefined()
    })

    it('a pending request DOES offer both buttons', async () => {
      mountWith(wd('w1', { status: 'pending' }))
      await flush()

      expect(button('Подтвердить')).toBeDefined()
      expect(button('Отклонить')).toBeDefined()
      expect(text()).not.toContain('Запрос уже обработан')
    })
  })

  describe('approve: the gate', () => {
    it('«Подтвердить» does NOT approve on its own -- it only opens the confirm modal', async () => {
      // One click must never move money.
      mountWith(wd('w1'))
      await flush()

      button('Подтвердить')?.click()
      await flush()

      expect(adminApi.approveWithdrawal).not.toHaveBeenCalled()
      expect(bodyButton('Подтвердить 2FA')).toBeDefined()
    })

    it('the confirm modal shows the SAME numbers as the screen behind it', async () => {
      // ConfirmPaymentModal is fed the parent's computed labels
      // (AdminWithdrawalDetailView.vue:80-89). A mismatch here would mean the
      // admin confirms a different amount than the one they reviewed.
      mountWith(wd('w1', { amount_cents: 10000, fee_cents: 250 }))
      await flush()

      button('Подтвердить')?.click()
      await flush()

      const modal = document.body.querySelector('.cpm')?.textContent ?? ''
      expect(modal).toContain('100,00')
      expect(modal).toContain('2,50')
      expect(modal).toContain('97,50')
      expect(modal).toContain('N26 •••• 3000')
      expect(modal).toContain('Анна П.')
    })

    it('confirming does NOT approve either -- it only opens the 2FA modal', async () => {
      mountWith(wd('w1'))
      await flush()

      await openTwoFa()

      expect(adminApi.approveWithdrawal).not.toHaveBeenCalled()
      expect(document.body.querySelectorAll('.tfa__box')).toHaveLength(6)
    })

    it('an INCOMPLETE 2FA code cannot approve', async () => {
      // TwoFactorModal gates submit on all six digits (TwoFactorModal.vue:76,88).
      // NOTE: this is a UI gate ONLY -- the code is never verified against
      // anything (see the banner). This asserts the gate holds, not that 2FA works.
      mountWith(wd('w1'))
      await flush()
      await openTwoFa()
      await type2fa('123')

      tfaSubmit()?.click()
      await flush()

      expect(adminApi.approveWithdrawal).not.toHaveBeenCalled()
    })

    it('a COMPLETE 2FA code approves THAT withdrawal by id', async () => {
      mountWith(wd('w7', { amount_cents: 10000 }))
      await flush()
      await openTwoFa()
      await type2fa('123456')

      tfaSubmit()?.click()
      await flush()

      expect(adminApi.approveWithdrawal).toHaveBeenCalledTimes(1)
      expect(adminApi.approveWithdrawal).toHaveBeenCalledWith('w7')
      expect(toastSuccess).toHaveBeenCalledWith('Выплата одобрена')
      expect(back).toHaveBeenCalled()
    })
  })

  describe('approve: failure', () => {
    it('surfaces the REAL backend detail and does NOT claim success', async () => {
      // «Insufficient platform balance» is exactly what the admin must see.
      vi.mocked(adminApi.approveWithdrawal).mockRejectedValue(
        new ApiResponseError(409, 'Недостаточно средств на счёте платформы', 'no_funds'),
      )
      mountWith(wd('w1'))
      await flush()
      await openTwoFa()
      await type2fa()

      tfaSubmit()?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Недостаточно средств на счёте платформы')
      expect(toastSuccess).not.toHaveBeenCalled()
      expect(back).not.toHaveBeenCalled()
    })

    it('falls back to a generic message on a non-API error', async () => {
      vi.mocked(adminApi.approveWithdrawal).mockRejectedValue(new TypeError('boom'))
      mountWith(wd('w1'))
      await flush()
      await openTwoFa()
      await type2fa()

      tfaSubmit()?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Ошибка одобрения выплаты')
    })

    it('does NOT double-pay when submit is hit twice while the approve is in flight', async () => {
      // The `approving` re-entry guard (AdminWithdrawalDetailView.vue:194). A
      // second POST here is a literal double payout.
      let resolve!: (v: AdminWithdrawalResponse) => void
      vi.mocked(adminApi.approveWithdrawal).mockReturnValue(
        new Promise((r) => {
          resolve = r
        }),
      )
      mountWith(wd('w1'))
      await flush()
      await openTwoFa()
      await type2fa()

      tfaSubmit()?.click()
      await nextTick()
      tfaSubmit()?.click()
      await nextTick()

      expect(adminApi.approveWithdrawal).toHaveBeenCalledTimes(1)

      resolve(wd('w1'))
      await flush()
    })
  })

  describe('reject', () => {
    it('«Отклонить» opens the reason sheet without rejecting', async () => {
      mountWith(wd('w1'))
      await flush()

      button('Отклонить')?.click()
      await flush()

      expect(adminApi.rejectWithdrawal).not.toHaveBeenCalled()
      expect(bodyButton('Отклонить выплату')).toBeDefined()
    })

    it('refuses an EMPTY reason and says why', async () => {
      // rejectWithdrawal's note is REQUIRED (api/admin.ts:346-352) -- the master
      // is owed an explanation for a refused payout.
      mountWith(wd('w1'))
      await flush()
      button('Отклонить')?.click()
      await flush()

      bodyButton('Отклонить выплату')?.click()
      await flush()

      expect(adminApi.rejectWithdrawal).not.toHaveBeenCalled()
      expect(document.body.textContent).toContain('Укажите причину отклонения')
    })

    it('refuses a whitespace-only reason', async () => {
      mountWith(wd('w1'))
      await flush()
      button('Отклонить')?.click()
      await flush()

      const ta = document.body.querySelector<HTMLTextAreaElement>('textarea')
      ta!.value = '   '
      ta!.dispatchEvent(new Event('input'))
      await flush()

      bodyButton('Отклонить выплату')?.click()
      await flush()

      expect(adminApi.rejectWithdrawal).not.toHaveBeenCalled()
    })

    it('rejects THAT withdrawal with the TRIMMED reason', async () => {
      mountWith(wd('w7'))
      await flush()
      button('Отклонить')?.click()
      await flush()

      const ta = document.body.querySelector<HTMLTextAreaElement>('textarea')
      ta!.value = '  Неверные реквизиты  '
      ta!.dispatchEvent(new Event('input'))
      await flush()

      bodyButton('Отклонить выплату')?.click()
      await flush()

      expect(adminApi.rejectWithdrawal).toHaveBeenCalledWith('w7', 'Неверные реквизиты')
      expect(toastSuccess).toHaveBeenCalledWith('Выплата отклонена')
      expect(back).toHaveBeenCalled()
    })

    it('surfaces the REAL backend detail on failure and stays put', async () => {
      vi.mocked(adminApi.rejectWithdrawal).mockRejectedValue(
        new ApiResponseError(409, 'Запрос уже обработан', 'already_done'),
      )
      mountWith(wd('w1'))
      await flush()
      button('Отклонить')?.click()
      await flush()

      const ta = document.body.querySelector<HTMLTextAreaElement>('textarea')
      ta!.value = 'Причина'
      ta!.dispatchEvent(new Event('input'))
      await flush()

      bodyButton('Отклонить выплату')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Запрос уже обработан')
      expect(toastSuccess).not.toHaveBeenCalled()
      expect(back).not.toHaveBeenCalled()
    })

    it('clears a stale reason each time the sheet is reopened', async () => {
      // openReject resets reason + error (AdminWithdrawalDetailView.vue:182-186).
      // A leftover reason from a previous attempt would be attached to the NEXT
      // rejection -- a wrong explanation on a real refusal.
      mountWith(wd('w1'))
      await flush()
      button('Отклонить')?.click()
      await flush()

      const ta = document.body.querySelector<HTMLTextAreaElement>('textarea')
      ta!.value = 'Первая причина'
      ta!.dispatchEvent(new Event('input'))
      await flush()

      bodyButton('Отмена')?.click()
      host?.querySelector<HTMLElement>('.v-sheet__overlay')
      button('Отклонить')?.click()
      await flush()

      const reopened = document.body.querySelector<HTMLTextAreaElement>('textarea')
      expect(reopened?.value).toBe('')
    })
  })

  describe('navigation', () => {
    it('the back button goes back', async () => {
      mountWith(wd('w1'))
      await flush()

      host?.querySelector<HTMLElement>('.wd__top button')?.click()
      await flush()

      expect(back).toHaveBeenCalled()
    })
  })
})
