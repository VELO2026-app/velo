// =============================================================================
// VELO Frontend -- MasterNewPromocodeView Screen Tests (T8, PROMPT №432)
// =============================================================================
//
// The form that mints a master promo code. Money: the master absorbs the
// discount out of their own revenue (generated.ts:427), so a percent that
// reaches the API as the wrong number, or a validity window off by a day, is a
// real loss on every redemption.
//
// PATTERN B (local-ref/reactive): `form` is a reactive() and `creating` a ref;
// the seam is @/api/promos (createPromo), the module the screen imports. No
// store, so no pinia.
//
// THE DATE SHEET IS DRIVEN FOR REAL, NOT STUBBED (velo-idiom §2). DatePickerSheet
// renders inside VBottomSheet, which is `Teleport to="body"`
// (VBottomSheet.vue:18) -- so its DOM is queried from document.body, NOT from
// the mount root, or the test would conclude the picker never rendered (SC-07).
//
// TIME IS PINNED (vi.setSystemTime). todayLocalISO() (utils/format.ts:191-195)
// feeds the picker's :min from the wall clock, and DatePickerSheet opens on
// today's month when the field is empty (DatePickerSheet.vue:138-145). Without a
// frozen instant the calendar under test would be a different month every run.
//
// TIMEZONE: deliberately NOT pinned, and the assertions are written so it does
// not need to be. The product builds valid_until as
// `new Date('YYYY-MM-DDT23:59:59')` (MasterNewPromocodeView.vue:151) -- no 'Z',
// so it parses in the RUNNER'S LOCAL ZONE by design ("end of the selected local
// day"). Asserting a literal UTC ISO string would therefore pass only in the
// author's timezone and fail in CI. The tests below read the sent instant back
// through LOCAL getters (getDate/getHours), which is exactly the property the
// product intends and is stable in every zone.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import MasterNewPromocodeView from '@/views/master/MasterNewPromocodeView.vue'
import * as promosApi from '@/api/promos'
import { ApiResponseError } from '@/api/client'
import type { CreateMasterPromoRequest, PromoResponse } from '@/api/types'

vi.mock('@/api/promos')

const push = vi.fn()
const back = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back }),
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: vi.fn() }),
}))

// Frozen at 2026-07-20 midday UTC: far enough from either midnight that the
// local calendar date is 2026-07-20 in every realistic runner zone, so
// todayLocalISO() -- and therefore the picker's :min and opening month -- are
// the same everywhere.
const NOW = new Date('2026-07-20T12:00:00Z')

function created(overrides: Partial<PromoResponse> = {}): PromoResponse {
  return {
    id: 'p1',
    code: 'SUMMER',
    type: 'master',
    master_id: 'master_1',
    practice_id: null,
    discount_percent: 100,
    max_uses: null,
    used_count: 0,
    valid_from: '2026-07-20T00:00:00Z',
    valid_until: null,
    first_purchase_only: false,
    is_active: true,
    created_at: '2026-07-20T00:00:00Z',
    updated_at: null,
    ...overrides,
  }
}

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(MasterNewPromocodeView)
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

function typeCode(value: string): void {
  const input = host?.querySelector<HTMLInputElement>('input')
  if (!input) throw new Error('code input not rendered')
  input.value = value
  input.dispatchEvent(new Event('input'))
}

function typeLimit(value: string): void {
  const input = host?.querySelector<HTMLInputElement>('input[type="number"]')
  if (!input) throw new Error('limit input not rendered')
  input.value = value
  input.dispatchEvent(new Event('input'))
}

/** Drive the real teleported DatePickerSheet: open it, tap `day`, save. */
async function pickDay(day: number): Promise<void> {
  host?.querySelector<HTMLElement>('.new-promo__picker')?.click()
  await flush()

  // Teleported to body (VBottomSheet.vue:18) -- not under `host` (SC-07).
  const cell = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.dps__day')).find(
    (b) => !b.disabled && b.textContent?.trim() === String(day),
  )
  if (!cell) throw new Error(`day ${day} is not selectable in the open month`)
  cell.click()
  await flush()

  const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.v-sheet__save'))[0]
  if (!save) throw new Error('sheet save button not rendered')
  save.click()
  await flush()
}

/** The body the screen actually POSTed. */
function sentBody(): CreateMasterPromoRequest {
  const call = vi.mocked(promosApi.createPromo).mock.calls[0]
  if (!call) throw new Error('createPromo was never called')
  return call[0]
}

beforeEach(() => {
  vi.setSystemTime(NOW)
  vi.mocked(promosApi.createPromo).mockReset().mockResolvedValue(created())
  push.mockReset()
  back.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null

  // MANDATORY, and the reason is nasty: a teleported bottom sheet that has been
  // CLOSED leaks past app.unmount(). VBottomSheet wraps its overlay in a
  // <Transition> (VBottomSheet.vue:19-20); when `open` flips to false, Vue holds
  // the leaving element pending a transitionend that happy-dom never fires, and
  // unmount does not reap it -- it stays parked directly on document.body.
  // The next test then finds the DEAD sheet FIRST in document order, clicks it,
  // and nothing happens: the picker silently no-ops and every downstream
  // assertion fails while the screen is perfectly fine. Verified: the first
  // sheet-using test in a file passes and every later one fails. (SC-07 covers
  // QUERYING teleported content; it does not cover reaping it. See the report.)
  document.body.querySelectorAll('.v-sheet__overlay').forEach((el) => el.remove())

  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('MasterNewPromocodeView', () => {
  describe('validation gates (nothing reaches the API)', () => {
    it('refuses an empty code', async () => {
      mount()
      await flush()

      button('Создать промокод')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Введите код промокода')
      expect(promosApi.createPromo).not.toHaveBeenCalled()
    })

    it('refuses a whitespace-only code', async () => {
      // onCreate gates on form.code.trim() (MasterNewPromocodeView.vue:136) --
      // '   ' is not a usable promo code.
      mount()
      await flush()
      typeCode('   ')
      await flush()

      button('Создать промокод')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Введите код промокода')
      expect(promosApi.createPromo).not.toHaveBeenCalled()
    })

    it('refuses a code with no end date', async () => {
      // A master promo with no expiry discounts the master's revenue forever.
      mount()
      await flush()
      typeCode('SUMMER')
      await flush()

      button('Создать промокод')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Укажите дату окончания действия')
      expect(promosApi.createPromo).not.toHaveBeenCalled()
    })
  })

  describe('the date picker', () => {
    it('opens on the current month and shows the picked day on the trigger', async () => {
      mount()
      await flush()

      await pickDay(25)

      // «июля», genitive -- VELO_SHORT_MONTHS abbreviates only the months whose
      // names are long (utils/format.ts:103-116); июнь/июль/май are spelled out.
      expect(text()).toContain('25 июля 2026')
      expect(text()).not.toContain('Выберите дату')
    })

    it('disables days before today -- a promo cannot expire in the past', async () => {
      // :min="todayISO" (MasterNewPromocodeView.vue:70) -> DatePickerSheet marks
      // earlier cells disabled (DatePickerSheet.vue:203).
      mount()
      await flush()
      host?.querySelector<HTMLElement>('.new-promo__picker')?.click()
      await flush()

      const cells = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.dps__day'))
      const dayCell = (n: number) =>
        cells.find((b) => b.classList.contains('dps__day') && b.textContent?.trim() === String(n))

      // Frozen at 2026-07-20: the 19th is yesterday, the 21st is tomorrow.
      expect(dayCell(19)?.disabled).toBe(true)
      expect(dayCell(21)?.disabled).toBe(false)
      // Today itself stays selectable -- `ymd < min` is strict (DatePickerSheet.vue:203).
      expect(dayCell(20)?.disabled).toBe(false)
    })
  })

  describe('the POST body', () => {
    it('sends the trimmed code, the chosen percent and the limit', async () => {
      mount()
      await flush()
      typeCode('  SUMMER20  ')
      await flush()
      typeLimit('10')
      await flush()
      await pickDay(25)

      button('Создать промокод')?.click()
      await flush()

      const body = sentBody()
      expect(body.code).toBe('SUMMER20')
      expect(body.max_uses).toBe(10)
    })

    it("sends discount_percent as a NUMBER, not the select's string", async () => {
      // form.discount is a string ('100') from VSelect; onCreate coerces with
      // Number() (MasterNewPromocodeView.vue:148). Shipping "100" to a backend
      // expecting an int is a 422 -- or worse, a silently mis-parsed discount.
      mount()
      await flush()
      typeCode('SUMMER')
      await flush()
      await pickDay(25)

      button('Создать промокод')?.click()
      await flush()

      const body = sentBody()
      expect(body.discount_percent).toBe(100)
      expect(typeof body.discount_percent).toBe('number')
    })

    it('an empty limit is sent as null, NOT as 0', async () => {
      // `form.limit ? Number(form.limit) : null` (MasterNewPromocodeView.vue:152).
      // Number('') is 0, and a max_uses of 0 would be a promo nobody can redeem.
      mount()
      await flush()
      typeCode('SUMMER')
      await flush()
      await pickDay(25)

      button('Создать промокод')?.click()
      await flush()

      expect(sentBody().max_uses).toBeNull()
    })

    it('valid_until is the END of the selected local day, not its start', async () => {
      // MasterNewPromocodeView.vue:151 anchors at 23:59:59 local. If it collapsed
      // to midnight, a code picked "valid until the 25th" would die a day early.
      // Read back via LOCAL getters -- the product parses local by design, so a
      // literal UTC string here would only pass in one timezone.
      mount()
      await flush()
      typeCode('SUMMER')
      await flush()
      await pickDay(25)

      button('Создать промокод')?.click()
      await flush()

      const until = new Date(sentBody().valid_until as string)
      expect(until.getFullYear()).toBe(2026)
      expect(until.getMonth()).toBe(6) // July, 0-indexed
      expect(until.getDate()).toBe(25)
      expect(until.getHours()).toBe(23)
      expect(until.getMinutes()).toBe(59)
    })

    it('valid_until is sent as a UTC ISO string, not a local-format string', async () => {
      mount()
      await flush()
      typeCode('SUMMER')
      await flush()
      await pickDay(25)

      button('Создать промокод')?.click()
      await flush()

      expect(sentBody().valid_until).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    })
  })

  describe('the usage-limit clamp (B1, MasterNewPromocodeView.vue:125-130)', () => {
    it('clamps 0 up to 1', async () => {
      // The number spinner lets a master reach 0; a 0-use promo is dead on
      // arrival and the master would not know why.
      mount()
      await flush()
      typeLimit('0')
      await flush()

      expect(host?.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('1')
    })

    it('clamps a negative up to 1', async () => {
      mount()
      await flush()
      typeLimit('-5')
      await flush()

      expect(host?.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('1')
    })

    it('clamps AGAIN when the field is already at 1 -- the second clamp is the one that used to break', async () => {
      // REGRESSION GUARD (T8, second site of the PROMPT №432 defect, found and
      // fixed in №434). This one was live and NOTHING caught it: the tests above
      // only ever exercise the FIRST clamp, where form.limit genuinely changes
      // ('' -> '0' -> '1'), so the child re-renders and the DOM syncs.
      //
      // Type 0 when the field ALREADY holds '1' and form.limit goes '1' -> '0' ->
      // '1' -- unchanged across the render. VInput's modelValue never changed, so
      // Vue skipped the child entirely and the field kept showing «0» while the
      // state said 1. The master then submits max_uses: 1 while looking at a 0.
      // Fixed in VInput (onInput re-asserts); contract pinned in VInput.test.ts.
      mount()
      await flush()

      typeLimit('0')
      await flush()
      expect(host?.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('1')

      typeLimit('0')
      await flush()
      expect(host?.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('1')
    })

    it('the clamped value is what actually reaches the API', async () => {
      // The field and the POST body must agree. While the desync was live the
      // master could be looking at «0» and shipping max_uses: 1.
      mount()
      await flush()
      typeCode('SUMMER')
      await flush()
      typeLimit('0')
      await flush()
      typeLimit('0')
      await flush()
      await pickDay(25)

      button('Создать промокод')?.click()
      await flush()

      expect(host?.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('1')
      expect(sentBody().max_uses).toBe(1)
    })

    it('leaves an empty limit empty -- empty means unlimited, not 1', async () => {
      // The watch bails on '' (MasterNewPromocodeView.vue:128). Clamping empty to
      // 1 would silently cap every promo the master left blank at a single use.
      mount()
      await flush()
      typeLimit('5')
      await flush()
      typeLimit('')
      await flush()

      expect(host?.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('')
    })

    it('leaves a valid limit alone', async () => {
      mount()
      await flush()
      typeLimit('25')
      await flush()

      expect(host?.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('25')
    })
  })

  describe('submit outcome', () => {
    it('on success: toasts and returns to the list', async () => {
      mount()
      await flush()
      typeCode('SUMMER')
      await flush()
      await pickDay(25)

      button('Создать промокод')?.click()
      await flush()

      expect(toastSuccess).toHaveBeenCalledWith('Промокод создан')
      expect(push).toHaveBeenCalledWith({ name: 'master-promocodes' })
    })

    it('surfaces the REAL backend detail on an ApiResponseError and STAYS on the form', async () => {
      // «Код уже занят» is the message that tells the master what to change.
      // Navigating away on failure would strand them with no promo and no reason.
      vi.mocked(promosApi.createPromo).mockRejectedValue(
        new ApiResponseError(409, 'Такой код уже существует', 'promo_code_taken'),
      )
      mount()
      await flush()
      typeCode('SUMMER')
      await flush()
      await pickDay(25)

      button('Создать промокод')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Такой код уже существует')
      expect(push).not.toHaveBeenCalled()
      expect(toastSuccess).not.toHaveBeenCalled()
    })

    it('falls back to a generic message on a non-API error', async () => {
      vi.mocked(promosApi.createPromo).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()
      typeCode('SUMMER')
      await flush()
      await pickDay(25)

      button('Создать промокод')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось создать промокод')
      expect(push).not.toHaveBeenCalled()
    })

    it('does NOT create two promos when the button is clicked twice while in flight', async () => {
      // The `creating` re-entry guard (MasterNewPromocodeView.vue:135). A double
      // POST here is a duplicate-code 409 at best.
      let resolve!: (v: PromoResponse) => void
      vi.mocked(promosApi.createPromo).mockReturnValue(
        new Promise((r) => {
          resolve = r
        }),
      )
      mount()
      await flush()
      typeCode('SUMMER')
      await flush()
      await pickDay(25)

      button('Создать промокод')?.click()
      await nextTick()
      button('Создать промокод')?.click()
      await nextTick()

      expect(promosApi.createPromo).toHaveBeenCalledTimes(1)

      resolve(created())
      await flush()
    })
  })
})
