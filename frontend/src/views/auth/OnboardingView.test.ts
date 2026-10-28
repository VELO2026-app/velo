// =============================================================================
// VELO Frontend -- OnboardingView Screen Tests
// =============================================================================
//
// WHY THIS FILE EXISTS: a 5-step welcome flow (FE-101 grew the carousel by
// the «Дата рождения» and «К чему бы вы хотели прийти?» form steps) whose
// LAST step is also the finish step, with two re-entry guards (`advancing`,
// `finishArmed`) and a real persistence call (authStore.updateProfile) that
// must carry the DEVICE timezone plus whatever FE-101 answers were
// collected. There is no manual timezone step: the zone is auto-detected
// via Intl, IANA-validated, with a UTC fallback, and stays editable later
// in TimezoneSettingsView.
//
// PATTERN: real Pinia + real authStore. The API seam is @/api/users
// (updateMe), mocked one level down through the REAL auth store action (same
// idiom as MasterProfileView's logout test: mock the API boundary, keep the
// store real). `done` is a root-level emit with no router involved (App.vue
// owns what happens after) -- captured via `onDone` passed as a root prop to
// createApp(OnboardingView, { onDone }).use(createTestI18n()), which Vue treats identically to a
// parent's `@done` listener (emit() reads `vnode.props.onDone`).
//
// The device timezone is proven through the SUBMITTED PAYLOAD -- the only
// observable surface left now that the picker is gone. `Intl.DateTimeFormat`
// is spied only for its ZERO-ARG call (the OS-detected-zone read);
// isValidIana's validity checks (called WITH args) fall through to the real
// implementation so validity is asserted for real, not re-implemented in the
// mock.
//
// THE RACE THE GUARD DESCRIBES, PROVEN, NOT JUST READ: onPrimaryAction's
// non-final branch is fully synchronous UNLESS the step it's entering is the
// final one, in which case it awaits enterFinalStep(), which itself awaits a
// bare `Promise.resolve()` between `step.value = FINAL_STEP_INDEX` and
// `finishArmed.value = true`. Two clicks with NO await between them (SC-17
// idiom) land IN that window: click 1 flips the step synchronously then
// yields at the microtask; click 2 (still the same synchronous script) now
// reads isFinalStep===true but finishArmed===false and returns a no-op.
// Proven by asserting the outcome is "landed on the last step, nothing
// submitted" -- not by reading the refs (they are not exposed).
//
// FE-101 specifics proven here: the dots count ALL five steps on every
// screen (the reloaded progress indicator), the back arrow works on the two
// form steps and keeps the collected answers in memory, and the finish
// PATCH carries birth_date / goals / goals_custom exactly when they were
// chosen -- absent otherwise.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import OnboardingView from '@/views/auth/OnboardingView.vue'
import { useAuthStore } from '@/stores/auth'
import * as usersApi from '@/api/users'
import { ApiResponseError } from '@/api/client'
import type { UserResponse } from '@/api/types'

vi.mock('@/api/users')

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), info: vi.fn() }),
}))

function user(overrides: Partial<UserResponse> & Record<string, unknown> = {}): UserResponse {
  return {
    id: 'u1',
    telegram_id: 1,
    role: 'user',
    first_name: 'Настя',
    last_name: null,
    avatar_url: null,
    timezone: null,
    language: 'ru',
    is_active: true,
    balance_cents: 0,
    created_at: '2026-01-01T00:00:00Z',
    last_login_at: null,
    onboarding_completed: false,
    master_onboarding_completed: false,
    phone: null,
    bio: null,
    email: null,
    birth_date: null,
    goals: [],
    goals_custom: null,
    role_switch: null,
    ...overrides,
  } as UserResponse
}

/** Spies the ZERO-ARG `Intl.DateTimeFormat()` call only (the OS-zone read in
 *  detectDeviceTimezone) -- calls WITH args (isValidIana's validity checks,
 *  BirthDateSheet's month labels) fall through to the real constructor, so
 *  validity is proven for real. A `function` (not an arrow) so consumers
 *  that construct (`new Intl.DateTimeFormat(...)`) keep working under the
 *  spy -- returning an object from a constructable mock overrides `this`. */
function mockDetectedTimezone(zone: string): void {
  const RealDTF = Intl.DateTimeFormat
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (this: unknown, ...args: unknown[]) {
    if (args.length === 0) {
      return { resolvedOptions: () => ({ timeZone: zone }) } as unknown as Intl.DateTimeFormat
    }
    return new RealDTF(...(args as ConstructorParameters<typeof Intl.DateTimeFormat>))
  } as unknown as typeof Intl.DateTimeFormat)
}

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia

function mount(onDone: () => void = () => {}): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(OnboardingView, { onDone }).use(createTestI18n())
  app.use(pinia)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}

function primaryButton(): HTMLButtonElement {
  const b = host?.querySelector<HTMLButtonElement>('.onboarding__button')
  if (!b) throw new Error('.onboarding__button did not render')
  return b
}

function skipButton(): HTMLButtonElement | null {
  return host?.querySelector<HTMLButtonElement>('.onboarding__skip') ?? null
}

function backButton(): HTMLButtonElement | null {
  return host?.querySelector<HTMLButtonElement>('.onboarding__back') ?? null
}

function dots(): HTMLElement[] {
  return Array.from(host?.querySelectorAll('.v-pagination-dots__dot') ?? [])
}

function activeDotIndex(): number {
  return dots().findIndex((d) => d.classList.contains('v-pagination-dots__dot--active'))
}

/** Advances to the date step: three awaited «Далее» clicks. */
async function gotoDateStep(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    primaryButton().click()
    await flush()
  }
}

/** Advances to the last (finish) step: four awaited «Далее» clicks. */
async function gotoFinalStep(): Promise<void> {
  await gotoDateStep()
  primaryButton().click()
  await flush()
}

/** Opens the date sheet and saves its default position (1 января 2000). */
async function pickDefaultBirthDate(): Promise<void> {
  const field = host?.querySelector<HTMLButtonElement>('.ob-date__field')
  if (!field) throw new Error('.ob-date__field did not render')
  field.click()
  await flush()
  const save = document.body.querySelector<HTMLButtonElement>('.v-sheet__save')
  if (!save) throw new Error('the birth-date sheet did not open')
  save.click()
  await flush()
}

/** Toggles a goal checkbox by its visible label. */
async function toggleGoal(label: string): Promise<void> {
  const box = Array.from(host?.querySelectorAll('.ob-goals__option') ?? []).find(
    (el) => el.textContent?.trim() === label,
  )
  if (!(box instanceof HTMLButtonElement)) throw new Error(`goal "${label}" did not render`)
  box.click()
  await flush()
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)

  const authStore = useAuthStore()
  authStore.user = user()

  vi.mocked(usersApi.updateMe)
    .mockReset()
    .mockImplementation(async (body) =>
      user({
        timezone: body.timezone ?? undefined,
        onboarding_completed: body.onboarding_completed ?? undefined,
      }),
    )
  toastError.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.restoreAllMocks() // undoes any Intl.DateTimeFormat spy, not just clears calls
  // Sweep leftover teleported bottom sheets: a panel mid-LEAVE transition
  // outlives app.unmount() (removal waits for a transitionend happy-dom
  // never fires), and a later test's querySelector('.v-sheet__save') would
  // click the dead panel instead of its own. Remove what unmount left.
  document.body.querySelectorAll('.v-sheet__panel').forEach((el) => el.remove())
})

describe('OnboardingView', () => {
  describe('the timezone step is gone', () => {
    it('renders no «Часовой пояс» screen and no city picker on any step', async () => {
      mount()
      await flush()

      expect(text()).not.toContain('Часовой пояс')
      expect(host?.querySelector('.tz-picker')).toBeNull()

      // Walk to the last step: still no picker anywhere.
      await gotoFinalStep()
      expect(text()).not.toContain('Часовой пояс')
      expect(host?.querySelector('.tz-picker')).toBeNull()
      expect(activeDotIndex()).toBe(4)
    })
  })

  describe('the intro carousel (steps 0-2)', () => {
    it('starts on slide 0 with «Далее», dot 0 active of FIVE (FE-101), Skip visible', async () => {
      mount()
      await flush()

      expect(text()).toContain('Найдите свою практику')
      expect(primaryButton().textContent?.trim()).toBe('Далее')
      expect(primaryButton().disabled).toBe(false)
      expect(activeDotIndex()).toBe(0)
      // FE-101: the reloaded indicator counts every step of the flow.
      expect(dots()).toHaveLength(5)
      expect(skipButton()).not.toBeNull()
      expect(backButton()).toBeNull() // the intro slides have no back arrow
    })

    it('«Далее» advances one slide per (awaited) click', async () => {
      mount()
      await flush()

      primaryButton().click()
      await flush()
      expect(text()).toContain('Ведите дневник')
      expect(activeDotIndex()).toBe(1)

      primaryButton().click()
      await flush()
      expect(text()).toContain('Карта себя')
      expect(activeDotIndex()).toBe(2)
    })

    it('the 3rd «Далее» (from slide 2) reaches the date step -- «Далее» stays, Skip stays, the back arrow appears', async () => {
      mount()
      await flush()

      primaryButton().click()
      await flush()
      primaryButton().click()
      await flush()
      expect(text()).toContain('Карта себя') // sanity: really on slide 2

      primaryButton().click()
      await flush()

      expect(text()).toContain('Дата рождения')
      expect(primaryButton().textContent?.trim()).toBe('Далее')
      expect(skipButton()).not.toBeNull() // the date step is skippable
      expect(backButton()).not.toBeNull()
    })

    it('a same-tick second click that races the transition onto the last step is swallowed by finishArmed, not treated as Готово', async () => {
      mount()
      await flush()

      await gotoDateStep()
      expect(text()).toContain('Дата рождения') // sanity: really on step 3

      primaryButton().click()
      primaryButton().click() // no await between -- lands inside the race window
      await flush()

      // Landed on the last step exactly once -- not bounced past it, and
      // finish() was never reached (no persistence attempt).
      expect(text()).toContain('К чему бы вы хотели прийти?')
      expect(activeDotIndex()).toBe(4)
      expect(usersApi.updateMe).not.toHaveBeenCalled()
    })
  })
})

describe('OnboardingView -- FE-101 form steps', () => {
  describe('the date step (3)', () => {
    it('opens the wheel sheet from the field, saves the default date, and shows it formatted', async () => {
      mount()
      await flush()

      await gotoDateStep()
      await pickDefaultBirthDate()

      // ICU ru spelling of the untouched default the sheet saves.
      expect(text()).toContain('1 января 2000 г.')
    })

    it('«Далее» without a date advances without sending birth_date anywhere later', async () => {
      mockDetectedTimezone('Europe/London')
      const onDone = vi.fn()
      mount(onDone)
      await flush()

      // No date picked on step 3 -- walk straight through to the finish.
      await gotoFinalStep()
      await toggleGoal('Лучше спать')
      primaryButton().click()
      await flush()

      expect(usersApi.updateMe).toHaveBeenCalledWith({
        timezone: 'Europe/London',
        onboarding_completed: true,
        goals: ['better_sleep'],
      })
      expect(onDone).toHaveBeenCalledTimes(1)
    })

    it('«Пропустить» from the date step finishes with the timezone-only payload', async () => {
      mockDetectedTimezone('Europe/London')
      const onDone = vi.fn()
      mount(onDone)
      await flush()

      await gotoDateStep()
      skipButton()?.click()
      await flush()

      expect(usersApi.updateMe).toHaveBeenCalledWith({
        timezone: 'Europe/London',
        onboarding_completed: true,
      })
      expect(onDone).toHaveBeenCalledTimes(1)
    })

    it('the back arrow from the goals step keeps the chosen date in memory', async () => {
      mount()
      await flush()

      await gotoDateStep()
      await pickDefaultBirthDate()
      primaryButton().click()
      await flush()
      expect(text()).toContain('К чему бы вы хотели прийти?')

      backButton()?.click()
      await flush()

      expect(text()).toContain('Дата рождения')
      // The answer survived the round trip -- nothing was persisted.
      expect(text()).toContain('1 января 2000 г.')
      expect(usersApi.updateMe).not.toHaveBeenCalled()
    })
  })

  describe('the goals step (4, finish)', () => {
    it('shows the goal list, hides Skip, and reveals the custom input only for «Свой вариант»', async () => {
      mount()
      await flush()

      await gotoFinalStep()

      expect(text()).toContain('К чему бы вы хотели прийти?')
      for (const label of [
        'Меньше тревоги и стресса',
        'Лучше спать',
        'Больше энергии',
        'Спокойный, ясный ум',
        'Лучше понимать и принимать себя',
        'Просто попробовать, любопытно',
        'Свой вариант',
      ]) {
        expect(text()).toContain(label)
      }
      expect(skipButton()).toBeNull() // hidden on the final step
      expect(backButton()).not.toBeNull()
      expect(host?.querySelector('.ob-goals__custom')).toBeNull()

      await toggleGoal('Свой вариант')
      expect(host?.querySelector('.ob-goals__custom')).not.toBeNull()
    })

    it('«Готово» persists the date, the goals, and the custom text in ONE PATCH', async () => {
      mockDetectedTimezone('Europe/London')
      const onDone = vi.fn()
      mount(onDone)
      await flush()

      await gotoDateStep()
      await pickDefaultBirthDate()
      primaryButton().click()
      await flush()

      await toggleGoal('Лучше спать')
      await toggleGoal('Свой вариант')
      const custom = host?.querySelector<HTMLInputElement>('.ob-goals__custom input')
      if (!custom) throw new Error('the custom input did not render')
      custom.value = 'Готовиться к ретриту'
      custom.dispatchEvent(new Event('input'))
      await flush()

      expect(primaryButton().textContent?.trim()).toBe('Готово')
      primaryButton().click()
      await flush()

      expect(usersApi.updateMe).toHaveBeenCalledTimes(1)
      expect(usersApi.updateMe).toHaveBeenCalledWith({
        timezone: 'Europe/London',
        onboarding_completed: true,
        birth_date: '2000-01-01',
        goals: ['better_sleep', 'custom'],
        goals_custom: 'Готовиться к ретриту',
      })
      expect(onDone).toHaveBeenCalledTimes(1)
    })

    it('unchecking «Свой вариант» drops the typed text from the payload', async () => {
      mockDetectedTimezone('Europe/London')
      mount()
      await flush()

      await gotoFinalStep()
      await toggleGoal('Свой вариант')
      const custom = host?.querySelector<HTMLInputElement>('.ob-goals__custom input')
      if (!custom) throw new Error('the custom input did not render')
      custom.value = 'осталось висеть'
      custom.dispatchEvent(new Event('input'))
      await flush()
      await toggleGoal('Свой вариант') // off again -- the text must not travel

      primaryButton().click()
      await flush()

      // 'custom' left the selection too, so neither key is sent.
      expect(usersApi.updateMe).toHaveBeenCalledWith({
        timezone: 'Europe/London',
        onboarding_completed: true,
      })
    })

    it('finishing with nothing picked sends no goals keys at all', async () => {
      mockDetectedTimezone('UTC')
      const onDone = vi.fn()
      mount(onDone)
      await flush()

      await gotoFinalStep()
      primaryButton().click()
      await flush()

      expect(usersApi.updateMe).toHaveBeenCalledWith({
        timezone: 'UTC',
        onboarding_completed: true,
      })
      expect(onDone).toHaveBeenCalledTimes(1)
    })
  })
})

describe('OnboardingView', () => {
  describe('the device timezone payload', () => {
    it('«Готово» persists the OS-detected zone + onboarding_completed, then emits done', async () => {
      mockDetectedTimezone('Europe/London')
      const onDone = vi.fn()
      mount(onDone)
      await flush()

      await gotoFinalStep()
      primaryButton().click()
      await flush()

      expect(usersApi.updateMe).toHaveBeenCalledWith({
        timezone: 'Europe/London',
        onboarding_completed: true,
      })
      expect(onDone).toHaveBeenCalledTimes(1)
    })

    it('an unusable OS zone falls back to UTC in the payload', async () => {
      // An empty string is the honest "nothing usable" fixture;
      // isValidIana('') is false via its own `if (!zone)` guard.
      mockDetectedTimezone('')
      const onDone = vi.fn()
      mount(onDone)
      await flush()

      await gotoFinalStep()
      primaryButton().click()
      await flush()

      expect(usersApi.updateMe).toHaveBeenCalledWith({
        timezone: 'UTC',
        onboarding_completed: true,
      })
      expect(onDone).toHaveBeenCalledTimes(1)
    })
  })

  describe('«Пропустить» finishes onboarding outright', () => {
    it('persists the device timezone + flag from slide 0 and emits done once', async () => {
      mockDetectedTimezone('Europe/London')
      const onDone = vi.fn()
      mount(onDone)
      await flush()

      skipButton()?.click()
      await flush()

      expect(usersApi.updateMe).toHaveBeenCalledWith({
        timezone: 'Europe/London',
        onboarding_completed: true,
      })
      expect(onDone).toHaveBeenCalledTimes(1)
    })
  })

  describe('failure and double-submit', () => {
    it('a failed save toasts the generic fallback (unmapped code) and does NOT emit done', async () => {
      // B8 (PROMPT №747): 'server_error' is not a real backend code --
      // unmapped, lands on the call site's own fallback.
      vi.mocked(usersApi.updateMe).mockRejectedValue(
        new ApiResponseError(500, 'Сервис недоступен', 'server_error'),
      )
      const onDone = vi.fn()
      mount(onDone)
      await flush()

      skipButton()?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось сохранить. Попробуйте ещё раз.')
      expect(onDone).not.toHaveBeenCalled()
      // Stays on the screen so the user can retry (Skip / «Готово»).
      expect(text()).toContain('Найдите свою практику')
    })

    it('does not finish twice on a same-tick double tap of «Готово» (the `submitting` guard)', async () => {
      let resolve!: (v: UserResponse) => void
      vi.mocked(usersApi.updateMe).mockReturnValue(
        new Promise<UserResponse>((r) => {
          resolve = r
        }),
      )
      const onDone = vi.fn()
      mount(onDone)
      await flush()

      await gotoFinalStep()
      const btn = primaryButton()
      btn.click()
      btn.click() // no await between -- :disabled has not re-rendered yet
      await flush()

      expect(usersApi.updateMe).toHaveBeenCalledTimes(1)

      resolve(user({ timezone: 'Europe/London', onboarding_completed: true }))
      await flush()
      expect(onDone).toHaveBeenCalledTimes(1)
    })
  })
})

// =============================================================================
// NOT COVERED, deliberately
// =============================================================================
// - The Intl fallback chain beyond the two payload cases above (e.g. a
//   throwing resolvedOptions): detectDeviceTimezone's try/catch collapses to
//   the same empty-string path already covered.
// - App.vue's gate that decides WHEN this screen mounts (onboarding_completed
//   === false): that is App.vue's own branching, out of this screen's surface.
// - TimezoneSettingsView: the post-onboarding manual timezone editor keeps its
//   own test file; onboarding no longer competes with it.
// - Driving the birth-date WHEELS by scroll (choosing a non-default date
//   through gestures): happy-dom fires no scroll events, the same limitation
//   every wheel consumer documents (see BirthDateSheet.test.ts).
// =============================================================================
