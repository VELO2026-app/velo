// =============================================================================
// VELO Frontend -- OnboardingView Screen Tests
// =============================================================================
//
// WHY THIS FILE EXISTS: a 3-step intro carousel whose LAST slide is also the
// finish step, with two re-entry guards (`advancing`, `finishArmed`) and a
// real persistence call (authStore.updateProfile) that must carry the DEVICE
// timezone. There is no manual timezone step anymore: the zone is auto-
// detected via Intl, IANA-validated, with a UTC fallback, and stays editable
// later in TimezoneSettingsView.
//
// PATTERN: real Pinia + real authStore. The API seam is @/api/users
// (updateMe), mocked one level down through the REAL auth store action (same
// idiom as MasterProfileView's logout test: mock the API boundary, keep the
// store real). `done` is a root-level emit with no router involved (App.vue
// owns what happens after) -- captured via `onDone` passed as a root prop to
// createApp(OnboardingView, { onDone }), which Vue treats identically to a
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
// intro-step branch is fully synchronous UNLESS the slide it's entering is
// the final one, in which case it awaits enterFinalStep(), which itself
// awaits a bare `Promise.resolve()` between `step.value = FINAL_STEP_INDEX`
// and `finishArmed.value = true`. Two clicks with NO await between them
// (SC-17 idiom) land IN that window: click 1 flips the step synchronously
// then yields at the microtask; click 2 (still the same synchronous script)
// now reads isFinalStep===true but finishArmed===false and returns a no-op.
// Proven by asserting the outcome is "landed on the last slide, nothing
// submitted" -- not by reading the refs (they are not exposed).
// =============================================================================

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
    role_switch: null,
    ...overrides,
  } as UserResponse
}

/** Spies the ZERO-ARG `Intl.DateTimeFormat()` call only (the OS-zone read in
 *  detectDeviceTimezone) -- calls WITH args (isValidIana's validity checks)
 *  fall through to the real constructor, so validity is proven for real. */
function mockDetectedTimezone(zone: string): void {
  const RealDTF = Intl.DateTimeFormat
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(((...args: unknown[]) => {
    if (args.length === 0) {
      return { resolvedOptions: () => ({ timeZone: zone }) } as unknown as Intl.DateTimeFormat
    }
    return new RealDTF(...(args as ConstructorParameters<typeof Intl.DateTimeFormat>))
  }) as unknown as typeof Intl.DateTimeFormat)
}

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia

function mount(onDone: () => void = () => {}): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(OnboardingView, { onDone })
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

function activeDotIndex(): number {
  const dots = Array.from(host?.querySelectorAll('.v-pagination-dots__dot') ?? [])
  return dots.findIndex((d) => d.classList.contains('v-pagination-dots__dot--active'))
}

/** Advances to the last (finish) slide: two awaited «Далее» clicks. */
async function gotoFinalSlide(): Promise<void> {
  primaryButton().click()
  await flush()
  primaryButton().click()
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
})

describe('OnboardingView', () => {
  describe('the timezone step is gone', () => {
    it('renders no «Часовой пояс» screen and no city picker on any slide', async () => {
      mount()
      await flush()

      expect(text()).not.toContain('Часовой пояс')
      expect(host?.querySelector('.tz-picker')).toBeNull()

      // Walk to the last slide: still no picker, and the slide count is 3.
      await gotoFinalSlide()
      expect(text()).not.toContain('Часовой пояс')
      expect(host?.querySelector('.tz-picker')).toBeNull()
      expect(activeDotIndex()).toBe(2)
    })
  })

  describe('the intro carousel (steps 0-2)', () => {
    it('starts on slide 0 with «Далее», dot 0 active, Skip visible', async () => {
      mount()
      await flush()

      expect(text()).toContain('Найдите свою практику')
      expect(primaryButton().textContent?.trim()).toBe('Далее')
      expect(primaryButton().disabled).toBe(false)
      expect(activeDotIndex()).toBe(0)
      expect(skipButton()).not.toBeNull()
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

    it('the 2nd «Далее» (from slide 1) reaches the last slide, relabels «Готово», hides Skip, and stays enabled', async () => {
      mount()
      await flush()

      primaryButton().click()
      await flush()
      expect(text()).toContain('Ведите дневник') // sanity: really on slide 1

      primaryButton().click()
      await flush()

      expect(text()).toContain('Карта себя')
      expect(primaryButton().textContent?.trim()).toBe('Готово')
      // No manual-pick gate anymore: the device zone is always available.
      expect(primaryButton().disabled).toBe(false)
      expect(skipButton()).toBeNull() // hidden on the final slide
    })

    it('a same-tick second click that races the transition onto the last slide is swallowed by finishArmed, not treated as Готово', async () => {
      mount()
      await flush()

      primaryButton().click()
      await flush()
      expect(text()).toContain('Ведите дневник') // sanity: really on slide 1

      primaryButton().click()
      primaryButton().click() // no await between -- lands inside the race window
      await flush()

      // Landed on the last slide exactly once -- not bounced past it, and
      // finish() was never reached (no persistence attempt).
      expect(text()).toContain('Карта себя')
      expect(activeDotIndex()).toBe(2)
      expect(usersApi.updateMe).not.toHaveBeenCalled()
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

      await gotoFinalSlide()
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

      await gotoFinalSlide()
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

      await gotoFinalSlide()
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
// =============================================================================
