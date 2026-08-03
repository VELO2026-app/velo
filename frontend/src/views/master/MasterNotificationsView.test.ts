// =============================================================================
// VELO Frontend -- MasterNotificationsView Screen Tests (probekit-screen-test)
// =============================================================================
//
// Phase 6 / T1 REWIRE (the SC-10 changelog-as-red moment the previous
// banner promised): the screen now PERSISTS its category toggles and the
// delivery schedule through the comms proxy
// (GET/PUT /api/v1/notifications/prefs, @/api/notifications) -- so the old
// honest-stub assertions went red exactly as designed, and this file was
// updated with them. The seam is mocked below (vi.mock('@/api/notifications')).
//
// WHAT PERSISTS WHERE (mirror of the .vue header):
//   new_booking + booking_cancelled -> comms category `bookings` (ONE
//       category behind TWO rows: they flip together BY DESIGN -- the
//       locked grid §3 has a single bookings category; splitting it is a
//       profile edit later, not a UI bug)
//   reminder / msg_participants / msg_support -> their own categories
//   schedule {from,to,days} -> comms quiet hours (proxy converts semantics)
//   new_checkin / new_feedback / ai_summary / monthly_report -> STILL LOCAL
//       stubs (no comms types yet; explicit disposition, Master-chat
//       2026-07-28) -- their remount-loss behaviour is asserted below as the
//       real, current, honest state of those four rows.
//
// TimePickerSheet (.vue:68-74) wraps VBottomSheet, teleported to
// document.body, `v-if="open"` -- absent from the DOM entirely when closed,
// not just hidden. Its wheel (VWheel) only emits `update:modelValue` on a
// real `scroll` event debounced 140ms, which happy-dom does not fire in
// response to `el.scrollTo()` -- so a SPECIFIC non-default time cannot be
// dialled in through this DOM-only harness (same documented limitation as
// CreatePracticeView.test.ts's own TimePickerSheet coverage). Covered
// instead: opening the sheet for a given edge shows/commits THAT edge's
// current value via Save (proving `timePickerEdge` routes to the right
// field, not just that both fields exist), and the sheet closes afterward.
//
// Cyrillic fixtures/expected strings below were typed via the Write tool,
// never a shell heredoc.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import MasterNotificationsView from '@/views/master/MasterNotificationsView.vue'

const back = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ back, push: vi.fn() }),
}))

// The comms proxy seam. GET resolves the profile's five categories all-on
// with no schedule (screen keeps its defaults); PUT echoes a facade-shaped
// body. Individual tests override per-case via mockResolvedValueOnce.
const prefsGet = vi.fn()
const prefsPut = vi.fn()
vi.mock('@/api/notifications', () => ({
  getNotificationPrefs: (...a: unknown[]) => prefsGet(...a),
  updateNotificationPrefs: (...a: unknown[]) => prefsPut(...a),
}))

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), info: vi.fn() }),
}))

const FACADE = {
  categories: {
    bookings: true,
    reminders: true,
    finance: true,
    msg_participants: true,
    msg_support: true,
  },
  schedule: null,
  timezone: null,
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(MasterNotificationsView)
  app.mount(host)
  return host
}

function unmountOnly(): void {
  app?.unmount()
  host?.remove()
  app = null
  host = null
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function switchByRow(label: string): HTMLButtonElement {
  const row = Array.from(host?.querySelectorAll<HTMLElement>('.mn-card') ?? []).find(
    (r) => r.querySelector('.mn-card__title')?.textContent?.trim() === label,
  )
  const btn = row?.querySelector<HTMLButtonElement>('.v-switch')
  if (!btn) throw new Error(`no switch row labelled «${label}»`)
  return btn
}
function isOn(label: string): boolean {
  return switchByRow(label).getAttribute('aria-checked') === 'true'
}

function dayBtn(label: string): HTMLButtonElement {
  const btn = Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-day-picker__day') ?? []).find(
    (b) => b.textContent?.trim() === label,
  )
  if (!btn) throw new Error(`no day button labelled «${label}»`)
  return btn
}
function dayOn(label: string): boolean {
  return dayBtn(label).getAttribute('aria-pressed') === 'true'
}

function timeFields(): HTMLButtonElement[] {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.mn-sched__field') ?? [])
}
function fromField(): HTMLButtonElement {
  const b = timeFields()[0]
  if (!b) throw new Error('«from» time field did not render')
  return b
}
function toField(): HTMLButtonElement {
  const b = timeFields()[1]
  if (!b) throw new Error('«to» time field did not render')
  return b
}

/** The live (not mid-leave-transition) teleported sheet overlay. */
function liveSheet(): Element | null {
  return document.body.querySelector('.v-sheet__overlay:not(.v-sheet-leave-active)')
}
function sheetSaveBtn(): HTMLButtonElement | null {
  return liveSheet()?.querySelector<HTMLButtonElement>('.v-sheet__save') ?? null
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  back.mockReset()
  prefsGet.mockReset()
  prefsPut.mockReset()
  prefsGet.mockResolvedValue(structuredClone(FACADE))
  prefsPut.mockResolvedValue(structuredClone(FACADE))
  toastError.mockReset()
})

afterEach(() => {
  unmountOnly()
  document.body.querySelectorAll('.v-sheet__overlay').forEach((el) => el.remove())
  vi.clearAllMocks()
})

describe('MasterNotificationsView', () => {
  // ===========================================================================
  describe('THE PERSISTENCE ANSWER -- comms via the proxy for categories/schedule; four rows still local stubs', () => {
    it('mount loads prefs from the proxy and merges categories over the defaults', async () => {
      prefsGet.mockResolvedValueOnce({
        ...structuredClone(FACADE),
        categories: { ...FACADE.categories, bookings: false },
      })
      mount()
      await flush()

      // ONE category behind TWO rows: both render the server value.
      expect(isOn('Новое бронирование')).toBe(false)
      expect(isOn('Отмена бронирования')).toBe(false)
      // Stub rows keep their hardcoded defaults -- nothing to load.
      expect(isOn('Ежемесячный отчет')).toBe(false)
      expect(prefsGet).toHaveBeenCalledTimes(1)
    })

    it('toggling a CATEGORY row writes the category patch through the proxy', async () => {
      mount()
      await flush()

      switchByRow('Напоминание').click()
      await flush()

      expect(isOn('Напоминание')).toBe(false)
      expect(prefsPut).toHaveBeenCalledWith({ categories: { reminders: false } })
    })

    it('the bookings PAIR flips together -- one grid category behind two rows (by design, see banner)', async () => {
      mount()
      await flush()

      switchByRow('Новое бронирование').click()
      await flush()

      expect(isOn('Новое бронирование')).toBe(false)
      expect(isOn('Отмена бронирования')).toBe(false)
      expect(prefsPut).toHaveBeenCalledWith({ categories: { bookings: false } })
    })

    it('reverts the toggle and toasts when the save FAILS', async () => {
      prefsPut.mockRejectedValueOnce(new Error('500'))
      mount()
      await flush()
      expect(isOn('Напоминание')).toBe(true) // default on

      switchByRow('Напоминание').click()
      await flush()

      // Optimistic flip is rolled back to the accepted value; the user is
      // told, rather than left looking at a state the server refused.
      expect(isOn('Напоминание')).toBe(true)
      expect(toastError).toHaveBeenCalledWith('Не удалось сохранить настройку')
    })

    it('reverts BOTH bookings rows together when their save fails', async () => {
      prefsPut.mockRejectedValueOnce(new Error('500'))
      mount()
      await flush()

      switchByRow('Новое бронирование').click()
      await flush()

      expect(isOn('Новое бронирование')).toBe(true)
      expect(isOn('Отмена бронирования')).toBe(true)
      expect(toastError).toHaveBeenCalledWith('Не удалось сохранить настройку')
    })

    // H-R2 (3.6): the two formerly-silent catches now surface.
    it('toasts when the initial prefs LOAD fails (was a silent console.warn)', async () => {
      prefsGet.mockRejectedValueOnce(new Error('500'))
      mount()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось загрузить настройки уведомлений')
    })

    it('toasts when the schedule SAVE fails (was a silent console.warn)', async () => {
      prefsPut.mockRejectedValueOnce(new Error('500'))
      mount()
      await flush()

      dayBtn('ПН').click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось сохранить расписание')
    })

    it('happy path shows NO toasts -- load and schedule save both succeed', async () => {
      mount()
      await flush()

      dayBtn('ПН').click()
      await flush()

      expect(prefsPut).toHaveBeenCalled()
      expect(toastError).not.toHaveBeenCalled()
    })

    it('a STUB row (Ежемесячный отчет) writes NOTHING and is lost on remount -- still the honest local stub', async () => {
      mount()
      await flush()
      switchByRow('Ежемесячный отчет').click()
      await flush()
      expect(isOn('Ежемесячный отчет')).toBe(true)
      expect(prefsPut).not.toHaveBeenCalled()

      unmountOnly()
      mount() // fresh instance -- stub keys have no store behind them
      await flush()

      expect(isOn('Ежемесячный отчет')).toBe(false) // hardcoded default
    })

    it('a failed load (comms down / recipient unsynced) leaves the defaults on screen -- degrade, never crash', async () => {
      prefsGet.mockRejectedValueOnce(new Error('502'))
      mount()
      await flush()

      expect(isOn('Новое бронирование')).toBe(true) // defaults intact
      expect(dayOn('ПН')).toBe(true)
    })
  })

  // ===========================================================================
  describe('toggles (.vue:111-158) -- representative rows, both directions', () => {
    it('"Новое бронирование" (Практики, default ON) toggles off', async () => {
      mount()
      await flush()

      switchByRow('Новое бронирование').click()
      await flush()

      expect(isOn('Новое бронирование')).toBe(false)
    })

    it('"Ежемесячный отчет" (Аналитика, the ONE default-OFF row) toggles on', async () => {
      mount()
      await flush()

      expect(isOn('Ежемесячный отчет')).toBe(false) // default
      switchByRow('Ежемесячный отчет').click()
      await flush()

      expect(isOn('Ежемесячный отчет')).toBe(true)
    })

    it('toggling one row does not affect a sibling row with its OWN category (msg_* are independent)', async () => {
      mount()
      await flush()

      switchByRow('От участников').click() // msg_participants
      await flush()

      expect(isOn('От участников')).toBe(false)
      expect(isOn('От поддержки')).toBe(true) // msg_support, untouched
      expect(isOn('Новое бронирование')).toBe(true) // unrelated group, untouched
    })
  })

  // ===========================================================================
  describe('schedule days (.vue:190-193, VDayPicker)', () => {
    it('default: Mon-Fri on, Sat/Sun off', async () => {
      mount()
      await flush()

      expect(dayOn('ПН')).toBe(true)
      expect(dayOn('ПТ')).toBe(true)
      expect(dayOn('СБ')).toBe(false)
      expect(dayOn('ВС')).toBe(false)
    })

    it('removing a default day and adding a non-default day both work', async () => {
      mount()
      await flush()

      dayBtn('ПН').click() // remove Monday
      await flush()
      dayBtn('СБ').click() // add Saturday
      await flush()

      expect(dayOn('ПН')).toBe(false)
      expect(dayOn('СБ')).toBe(true)
      expect(dayOn('ВТ')).toBe(true) // the rest of the default set is untouched
      // T1: every day change persists the FULL schedule through the proxy.
      expect(prefsPut).toHaveBeenLastCalledWith({
        schedule: {
          from: '08:00',
          to: '22:00',
          days: ['tue', 'wed', 'thu', 'fri', 'sat'],
        },
      })
    })
  })

  // ===========================================================================
  describe('time picker (.vue:172-180, TimePickerSheet -- see banner for the wheel limitation)', () => {
    it('the fields show the current schedule.from/to by default', async () => {
      mount()
      await flush()

      expect(fromField().textContent?.trim()).toBe('08:00')
      expect(toField().textContent?.trim()).toBe('22:00')
    })

    it('opening the "from" field opens the REAL teleported sheet; Save commits back to "from" and closes it', async () => {
      mount()
      await flush()

      expect(liveSheet()).toBeNull()
      fromField().click()
      await flush()

      expect(liveSheet()).not.toBeNull()
      sheetSaveBtn()?.click()
      await flush()

      expect(liveSheet()).toBeNull() // closed
      expect(fromField().textContent?.trim()).toBe('08:00') // committed back to its OWN edge
      expect(toField().textContent?.trim()).toBe('22:00') // "to" untouched
    })

    it('opening the "to" field routes Save to "to", NOT "from" -- proves timePickerEdge, not just that both fields exist', async () => {
      mount()
      await flush()

      toField().click()
      await flush()
      sheetSaveBtn()?.click()
      await flush()

      expect(toField().textContent?.trim()).toBe('22:00') // its own edge, committed
      expect(fromField().textContent?.trim()).toBe('08:00') // NOT overwritten by the "to" commit
    })
  })
})
