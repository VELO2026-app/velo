// =============================================================================
// VELO Frontend -- ExternalActivityCreateView Screen Tests (FE-70 / BE-27)
// =============================================================================
//
// The hand-entry form for an activity that happened outside velo. Real Pinia
// + real diary store (PATTERN A: the store owns the submit contract), only
// the network seam (@/api/diary) and the toast are mocked. vue-router is
// partially mocked (useRouter/useRoute spies), the DiaryFeedView.test
// convention -- the router singleton import chain stays real underneath.
//
// TIME IS PINNED to 2026-07-20T14:00:00Z and the PROFILE timezone is
// 'America/New_York' (EDT, UTC-4 in July -- 10:00 local at NOW). Every clock
// in the screen must run in the PROFILE zone: the sheet-default "today
// 12:00" is 16:00Z -- the FUTURE -- while a browser/UTC reading of the same
// wall time is 12:00Z, comfortably past. The future-block test below can
// therefore ONLY pass through the profile-zone path; a UTC-naive
// implementation would let the submit through.
//
// The date/time fields are driven through their REAL sheets (DatePickerSheet
// / TimePickerSheet, teleported to body) -- not by poking component refs --
// so the tests also pin the open -> pick -> save wiring end to end. The TIME
// always takes the sheet's own 12:00 default: VWheel only emits on a real
// `scroll` event debounced 140ms (VWheel.vue:78-89), which happy-dom never
// produces -- the documented harness limit CreatePracticeView.test.ts
// already works around the same way. The tap, the save and the
// update:modelValue -> form wiring are still genuinely exercised.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import ExternalActivityCreateView from '@/views/user/ExternalActivityCreateView.vue'
import UserShell from '@/views/shells/UserShell.vue'
import * as diaryApi from '@/api/diary'
import { ApiResponseError } from '@/api/client'

vi.mock('@/api/diary')

const push = vi.fn()
const replace = vi.fn()
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({ push, replace, back: vi.fn() }),
    useRoute: () => ({
      name: 'user-diary-activity-new',
      path: '/user/diary/activity/new',
      fullPath: '/user/diary/activity/new',
      query: {},
      meta: {},
    }),
  }
})

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: vi.fn() }),
}))

// Getter over a mutable module-scope object (velo-idiom §5): the REAL auth
// store imports @/platform eagerly; this screen only reads user?.timezone.
const authState: { user: { timezone: string } | null } = {
  user: { timezone: 'America/New_York' },
}
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    get user() {
      return authState.user
    },
  }),
}))

const NOW = new Date('2026-07-20T14:00:00Z') // 10:00 America/New_York

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(ExternalActivityCreateView)
  app.use(pinia)
  app.mount(host)
  return host
}

function unmount(): void {
  app?.unmount()
  host?.remove()
  app = null
  host = null
}

async function flush(): Promise<void> {
  // 12 ticks: the submit chain is POST -> feed.refresh() (useCursorPagination
  // has its own nextTick hops) -> result -> toast/push; 6 left the toast
  // unflushed (measured), 12 keeps the same margin DiaryComposer.test uses.
  for (let i = 0; i < 12; i++) await nextTick()
}

function screenText(): string {
  return host?.textContent ?? ''
}

function picker(index: 0 | 1): HTMLButtonElement {
  const el = host?.querySelectorAll<HTMLButtonElement>('.ea__picker')[index]
  if (!el) throw new Error(`picker #${index} did not render`)
  return el
}

function chipButtons(): HTMLButtonElement[] {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.ea__chips button') ?? [])
}

function chip(label: string): HTMLButtonElement {
  const el = chipButtons().find((b) => b.textContent?.trim() === label)
  if (!el) throw new Error(`chip «${label}» did not render`)
  return el
}

function customInput(): HTMLInputElement {
  const el = host?.querySelector<HTMLInputElement>('.ea__custom-input')
  if (!el) throw new Error('custom input did not render')
  return el
}

function commitBtn(): HTMLButtonElement {
  const el = host?.querySelector<HTMLButtonElement>('.ea__custom-commit')
  if (!el) throw new Error('custom commit arrow did not render')
  return el
}

function saveBtn(): HTMLButtonElement {
  const el = host?.querySelector<HTMLButtonElement>('.ea__save')
  if (!el) throw new Error('glass save pill did not render')
  return el
}

function backBtn(): HTMLButtonElement {
  const el = host?.querySelector<HTMLButtonElement>('.v-back')
  if (!el) throw new Error('back button did not render')
  return el
}

function thoughtTextarea(): HTMLTextAreaElement {
  const el = host?.querySelector<HTMLTextAreaElement>('.ea__thoughts textarea')
  if (!el) throw new Error('thoughts textarea did not render')
  return el
}

// -- Sheet drivers (the real teleported pickers) -------------------------------
// All sheet queries are scoped to the LIVE overlay (`.v-sheet__overlay:not(
// .v-sheet-leave-active)`): a CLOSED sheet's <Transition> leave never fires
// in happy-dom (SC-13), so its corpse -- save button included -- stays in
// the DOM and a bare querySelector would click the dead one first.

function liveSheet(): HTMLElement {
  const el = Array.from(document.body.querySelectorAll<HTMLElement>('.v-sheet__overlay')).find(
    (o) => !o.classList.contains('v-sheet-leave-active'),
  )
  if (!el) throw new Error('no live bottom sheet is open')
  return el
}

function liveSheetSave(): HTMLButtonElement {
  const el = liveSheet().querySelector<HTMLButtonElement>('.v-sheet__save')
  if (!el) throw new Error('live sheet save did not render')
  return el
}

async function pickDate(day: number): Promise<void> {
  picker(0).click()
  await nextTick()
  const dayBtn = Array.from(liveSheet().querySelectorAll('.dps__day')).find(
    (b) => b.textContent?.trim() === String(day),
  )
  if (!(dayBtn instanceof HTMLButtonElement)) throw new Error(`day ${day} did not render`)
  dayBtn.click()
  liveSheetSave().click()
  await nextTick()
}

/**
 * Drive the REAL teleported TimePickerSheet -- and take its DEFAULT, 12:00.
 * Same documented harness limit CreatePracticeView.test.ts hits: VWheel
 * emits only on a real debounced scroll event happy-dom never fires, so the
 * sheet's own initFromModel default is the only reachable value. The tap,
 * the save and the wiring are still genuinely exercised.
 */
async function pickDefaultTime(): Promise<void> {
  picker(1).click()
  await nextTick()
  // Sanity: the two wheels did render (the sheet really opened).
  if (liveSheet().querySelectorAll('.v-wheel').length !== 2) {
    throw new Error('the time sheet did not open')
  }
  liveSheetSave().click()
  await nextTick()
}

function typeCustom(value: string): void {
  const el = customInput()
  el.value = value
  el.dispatchEvent(new Event('input'))
}

function typeThoughts(value: string): void {
  const el = thoughtTextarea()
  el.value = value
  el.dispatchEvent(new Event('input'))
}

/** A fully valid form: yesterday 12:00, Медитация, no thoughts. The mood
 *  block is hidden (owner 2026-09-10), so no state click -- the payload
 *  carries MOOD_WHEN_STATE_HIDDEN. */
async function fillValidForm(): Promise<void> {
  await pickDate(19)
  await pickDefaultTime()
  chip('Медитация').click()
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)

  pinia = createPinia()
  setActivePinia(pinia)

  authState.user = { timezone: 'America/New_York' }
  vi.mocked(diaryApi.createExternalActivity).mockReset().mockResolvedValue({
    id: 'ea_1',
    occurred_at: '2026-07-19T16:00:00Z',
    activity_type: 'meditation',
    custom_activity_name: null,
    mood: 6,
    thoughts: null,
    created_at: '2026-07-20T08:00:05Z',
  })
  vi.mocked(diaryApi.listDiaryFeed).mockReset().mockResolvedValue({ items: [], next_cursor: null })

  push.mockReset()
  replace.mockReset()
  toastSuccess.mockReset()
  toastError.mockReset()
})

afterEach(() => {
  unmount()
  // Teleported sheets survive unmount (Transition leave never fires in
  // happy-dom, SC-13) -- purge so the next test clicks no corpse.
  document.body.querySelectorAll('.v-sheet__overlay').forEach((el) => el.remove())

  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('ExternalActivityCreateView', () => {
  describe('rendering + initial state', () => {
    it('renders the header, the legend, the visible sections in order and the exact copy', () => {
      mount()

      expect(host?.querySelector('.ea__title')?.textContent?.trim()).toBe('Новое событие')
      // No "..." placeholder on the header line (owner 2026-09-10).
      expect(host?.querySelector('.ea__header-slot')).toBeNull()
      expect(screenText()).toContain('— поля, обязательные для заполнения')
      const titles = Array.from(host?.querySelectorAll('.velo-section-title') ?? []).map((t) =>
        t.textContent?.trim(),
      )
      // «Мое состояние» is hidden for now (owner 2026-09-10).
      expect(titles).toEqual(['Когда произошло событие', 'Выбор активности', 'Мысли'])
      expect(thoughtTextarea().getAttribute('placeholder')).toBe(
        'Напишите, что это было и что с вами произошло. Вы можете вернуться к рефлексии позже',
      )
      expect(saveBtn().textContent?.trim()).toBe('Сохранить')
    })

    it('the save pill is the floating glass surface, not an in-flow footer', () => {
      mount()

      expect(host?.querySelector('.ea__save-wrap')).not.toBeNull()
      expect(host?.querySelector('.ea__footer')).toBeNull()
    })

    it('renders the six preset chips in the contract order', () => {
      mount()

      expect(chipButtons().map((b) => b.textContent?.trim())).toEqual([
        'Вокал',
        'Гвоздестояние',
        'Медитация',
        'Массаж',
        'Йога',
        'Танцы',
      ])
    })

    it('starts BLANK: no activity, no date, no time, no custom chip; the state block is hidden', () => {
      mount()

      expect(chipButtons().every((b) => b.getAttribute('aria-pressed') !== 'true')).toBe(true)
      expect(host?.querySelector('[aria-pressed="true"]')).toBeNull()
      expect(picker(0).textContent?.trim()).toBe('Дата')
      expect(picker(1).textContent?.trim()).toBe('Время')
      expect(screenText()).not.toContain('Свой вариант')
      // The mood icons (Есть вопросы / Хорошо / Огонь) are hidden for now.
      expect(host?.querySelector('[aria-label="Хорошо"]')).toBeNull()
      expect(host?.querySelector('[aria-label="Огонь"]')).toBeNull()
      expect(screenText()).not.toContain('Мое состояние')
    })

    it('required seals float in the layout gutter, outside the full-width fields', () => {
      mount()

      const seal = host?.querySelector<HTMLElement>('.ea__field .ea__seal--gutter')
      expect(seal).not.toBeNull()
      // No in-field seal rows left behind: the field row wrapper is gone.
      expect(host?.querySelector('.ea__field-row')).toBeNull()
      expect(host?.querySelector('.ea__seal-row')).toBeNull()
    })
  })

  describe('activity choice', () => {
    it('preset chips are single-select (aria-pressed moves, never stacks)', async () => {
      mount()
      chip('Медитация').click()
      await nextTick()
      expect(chip('Медитация').getAttribute('aria-pressed')).toBe('true')
      expect(chip('Вокал').getAttribute('aria-pressed')).toBe('false')

      chip('Йога').click()
      await nextTick()
      expect(chip('Йога').getAttribute('aria-pressed')).toBe('true')
      expect(chip('Медитация').getAttribute('aria-pressed')).toBe('false')
    })

    it('typing alone does NOT select custom; the arrow commits it onto the board as its OWN chip with an ×', async () => {
      mount()
      typeCustom('Скандинавская ходьба')
      await nextTick()

      expect(screenText()).not.toContain('Скандинавская ходьба')

      commitBtn().click()
      await nextTick()

      // The chip carries the variant's OWN text...
      expect(screenText()).toContain('Скандинавская ходьба')
      // ...and the input stays on screen but DISABLED: one custom chip at a
      // time, the draft is cleared, a new one only after the chip is removed.
      expect(host?.querySelector('.ea__custom')).not.toBeNull()
      expect(customInput().disabled).toBe(true)
      expect(customInput().value).toBe('')
      expect(host?.querySelector('.ea__chip-remove')).not.toBeNull()
    })

    it('Enter commits custom too', async () => {
      mount()
      typeCustom('Контрастный душ')
      customInput().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      await nextTick()

      expect(screenText()).toContain('Контрастный душ')
    })

    it('the × removes the chip, deselects custom and brings the input back', async () => {
      mount()
      typeCustom('Банные практики')
      commitBtn().click()
      await nextTick()
      expect(host?.querySelector('.ea__chip--custom')).not.toBeNull()

      host?.querySelector<HTMLButtonElement>('.ea__chip-remove')!.click()
      await nextTick()

      expect(host?.querySelector('.ea__chip--custom')).toBeNull()
      expect(host?.querySelector('.ea__custom')).not.toBeNull()
      // The × re-enables the input for the next custom variant.
      expect(customInput().disabled).toBe(false)
      expect(host?.querySelector('[aria-label="Убрать свой вариант"]')).toBeNull()
    })

    it('a preset click removes the custom chip; a new custom can be added afterwards', async () => {
      mount()
      typeCustom('Банные практики')
      commitBtn().click()
      await nextTick()
      expect(screenText()).toContain('Банные практики')

      chip('Массаж').click()
      await nextTick()
      // Single-select board: the preset replaces the custom chip entirely...
      expect(screenText()).not.toContain('Банные практики')
      expect(chip('Массаж').getAttribute('aria-pressed')).toBe('true')
      // ...and the input is available again -- a new custom can be added.
      typeCustom('Растяжка')
      commitBtn().click()
      await nextTick()
      expect(screenText()).toContain('Растяжка')
    })

    it('an EMPTY commit is refused with a field error and selects nothing', async () => {
      mount()
      commitBtn().click()
      await nextTick()

      expect(screenText()).toContain('Укажите ваш вариант')
      expect(host?.querySelector('.ea__chip--custom')).toBeNull()
    })
  })

  describe('Мое состояние (hidden for now, owner 2026-09-10)', () => {
    it('the mood block renders NOTHING: no icons, no seal, no section title', () => {
      mount()

      expect(host?.querySelector('[aria-label="Есть вопросы"]')).toBeNull()
      expect(host?.querySelector('[aria-label="Хорошо"]')).toBeNull()
      expect(host?.querySelector('[aria-label="Огонь"]')).toBeNull()
      expect(host?.querySelector('[data-field="state"]')).toBeNull()
    })

    it('validation does NOT demand a mood while the block is hidden', async () => {
      mount()
      await pickDate(19)
      await pickDefaultTime()
      chip('Медитация').click()
      await flush()

      saveBtn().click()
      await flush()

      expect(screenText()).not.toContain('Выберите состояние')
      // The neutral mood travels with the payload instead (asserted below).
      expect(diaryApi.createExternalActivity).toHaveBeenCalled()
    })
  })

  describe('validation (invalid submit never reaches the API)', () => {
    it('empty submit sets ALL visible required errors at once and calls nothing', async () => {
      mount()

      saveBtn().click()
      await flush()

      expect(screenText()).toContain('Выберите дату')
      expect(screenText()).toContain('Выберите время')
      expect(screenText()).toContain('Выберите активность')
      // The hidden mood block demands nothing on screen.
      expect(screenText()).not.toContain('Выберите состояние')
      expect(diaryApi.createExternalActivity).not.toHaveBeenCalled()
    })

    it('after the chip is removed, submit re-fails the section («Выберите активность»)', async () => {
      mount()
      typeCustom('Растяжка')
      commitBtn().click()
      await nextTick()
      expect(host?.querySelector('.ea__chip--custom')).not.toBeNull()

      host?.querySelector<HTMLButtonElement>('.ea__chip-remove')!.click()
      await nextTick()

      saveBtn().click()
      await flush()

      expect(screenText()).toContain('Выберите активность')
      expect(diaryApi.createExternalActivity).not.toHaveBeenCalled()
    })

    it('blocks a future timestamp in the PROFILE timezone (a UTC-naive check would let it through)', async () => {
      mount()
      // Today (2026-07-20) with the sheet-default 12:00 America/New_York is
      // 16:00Z -- the future at the pinned NOW (14:00Z). Read as UTC wall
      // time, 12:00Z is comfortably past: only the profile-zone path blocks.
      await pickDate(20)
      await pickDefaultTime()
      chip('Медитация').click()
      await flush()

      saveBtn().click()
      await flush()

      expect(screenText()).toContain('Событие не может быть в будущем')
      expect(diaryApi.createExternalActivity).not.toHaveBeenCalled()
    })
  })

  describe('submit -- success', () => {
    it('posts the exact contract payload (offset ISO in the profile zone, neutral mood while the block is hidden)', async () => {
      mount()
      await fillValidForm()
      typeThoughts('   ')
      await nextTick()

      saveBtn().click()
      await flush()

      expect(diaryApi.createExternalActivity).toHaveBeenCalledTimes(1)
      expect(diaryApi.createExternalActivity).toHaveBeenCalledWith({
        // 2026-07-19 12:00 America/New_York (EDT -04:00), built via Luxon.
        occurred_at: '2026-07-19T12:00:00.000-04:00',
        activity_type: 'meditation',
        custom_activity_name: null,
        // The mood block is hidden (owner 2026-09-10): the neutral zone
        // centre travels with the submit, nothing shown on screen.
        mood: 6,
        thoughts: null, // whitespace-only -> null, per the contract
      })
    })

    it('custom activity carries its trimmed name; thoughts travel verbatim-trimmed', async () => {
      mount()
      await pickDate(19)
      await pickDefaultTime()
      typeCustom('  Бальные танцы  ')
      commitBtn().click()
      typeThoughts('Прекрасный вечер')
      await flush()

      saveBtn().click()
      await flush()

      expect(diaryApi.createExternalActivity).toHaveBeenCalledWith({
        occurred_at: '2026-07-19T12:00:00.000-04:00',
        activity_type: 'custom',
        custom_activity_name: 'Бальные танцы',
        mood: 6,
        thoughts: 'Прекрасный вечер',
      })
    })

    it('refreshes the feed, toasts «Событие добавлено» and goes to the diary', async () => {
      mount()
      await fillValidForm()

      saveBtn().click()
      await flush()

      expect(diaryApi.listDiaryFeed).toHaveBeenCalled() // feed re-read, no optimistic insert
      expect(toastSuccess).toHaveBeenCalledWith('Событие добавлено')
      expect(push).toHaveBeenCalledWith({ name: 'user-diary' })
    })
  })

  describe('submit -- pending + failure', () => {
    it('a second tap while the POST is in flight changes nothing (one call)', async () => {
      let resolve!: (v: unknown) => void
      vi.mocked(diaryApi.createExternalActivity).mockReturnValue(
        new Promise((r) => {
          resolve = r
        }) as never,
      )
      mount()
      await fillValidForm()

      saveBtn().click()
      saveBtn().click()
      await flush()

      expect(diaryApi.createExternalActivity).toHaveBeenCalledTimes(1)

      resolve({})
      await flush()
    })

    it('an unknown failure: no navigation, one honest toast, the draft intact, loading released', async () => {
      vi.mocked(diaryApi.createExternalActivity).mockRejectedValue(
        new ApiResponseError(500, 'boom', 'internal_error'),
      )
      mount()
      await fillValidForm()
      typeThoughts('очень спокойно')
      await nextTick()

      saveBtn().click()
      await flush()

      expect(push).not.toHaveBeenCalled()
      expect(toastSuccess).not.toHaveBeenCalled()
      expect(toastError).toHaveBeenCalledWith('Не удалось сохранить событие')
      // The draft survived: values still on screen, the pill released.
      expect(chip('Медитация').getAttribute('aria-pressed')).toBe('true')
      expect(picker(1).textContent?.trim()).toBe('12:00')
      expect(thoughtTextarea().value).toBe('очень спокойно')
      expect(saveBtn().disabled).toBe(false)
      expect(host?.querySelector('.ea__save-spinner')).toBeNull()
    })

    it('field-level 422s land on their controls (several at once), with no toast', async () => {
      vi.mocked(diaryApi.createExternalActivity).mockRejectedValue(
        new ApiResponseError(422, 'Проверьте введённые данные', 'validation_error', [
          {
            loc: ['body', 'occurred_at'],
            msg: 'Value error, occurred_at cannot be in the future',
            type: 'value_error',
          },
          {
            loc: ['body', 'custom_activity_name'],
            msg: "Value error, custom_activity_name is required when activity_type is 'custom'",
            type: 'value_error',
          },
        ]),
      )
      mount()
      await pickDate(19)
      await pickDefaultTime()
      typeCustom('Йога-нидра')
      commitBtn().click()
      await flush()

      saveBtn().click()
      await flush()

      expect(screenText()).toContain('occurred_at cannot be in the future')
      expect(screenText()).toContain('custom_activity_name is required')
      // The rejected name comes back INTO the input for editing (the chip is
      // off the board), so nothing the person typed is lost.
      expect(customInput().value).toBe('Йога-нидра')
      expect(toastError).not.toHaveBeenCalled()
      expect(push).not.toHaveBeenCalled()
    })
  })

  describe('navigation + route/shell contract', () => {
    it('back always goes to the dashboard (deep-link safe), not router.back()', async () => {
      mount()

      backBtn().click()
      await nextTick()

      expect(push).toHaveBeenCalledWith({ name: 'user-dashboard' })
    })

    it('the route is registered under /user/diary/activity/new', async () => {
      const { default: appRouter } = await import('@/router')
      expect(appRouter.resolve({ name: 'user-diary-activity-new' }).path).toBe(
        '/user/diary/activity/new',
      )
    })

    it('UserShell hides the tab bar and renders fill mode for the route', async () => {
      // AdminShell.test.ts's pattern: a real memory router per mount; the
      // route names are the shell's own hardcoded lists' contract.
      const StubChild = { template: '<div class="stub-child" />' }
      const router: Router = createRouter({
        history: createMemoryHistory(),
        routes: [
          {
            path: '/user/diary/activity/new',
            name: 'user-diary-activity-new',
            component: StubChild,
          },
        ],
      })
      await router.push({ name: 'user-diary-activity-new' })

      const shellHost = document.createElement('div')
      document.body.appendChild(shellHost)
      const shellApp = createApp(UserShell)
      shellApp.use(pinia)
      shellApp.use(router)
      shellApp.mount(shellHost)

      try {
        expect(shellHost.querySelector('.mobile-layout--fill')).not.toBeNull()
        expect(shellHost.querySelector('.v-tabbar')).toBeNull()
      } finally {
        shellApp.unmount()
        shellHost.remove()
      }
    })
  })
})
