// =============================================================================
// VELO Frontend -- OnboardingView Screen Tests
// =============================================================================
//
// WHY THIS FILE EXISTS (probekit-screen-test audit, rank 6): a 4-step state
// machine (3 intro slides + a timezone form) with two re-entry guards the
// screen's own comments (.vue:100-112) call out by name -- `advancing` and
// `finishArmed` -- and a real persistence call (authStore.updateProfile) on
// finish. One store import (useAuthStore, real Pinia), zero API-seam import
// of its own -- the seam is @/api/users (updateMe), one level down through
// the REAL auth store action (same idiom as MasterProfileView's logout test:
// mock the API boundary, keep the store real).
//
// PATTERN: real Pinia + real authStore. TimezoneCityPicker (child) is REAL,
// not stubbed (SC-12) -- driven by clicking its actual rendered rows.
// `done` is a root-level emit with no router involved (App.vue owns what
// happens after) -- captured via `onDone` passed as a root prop to
// createApp(OnboardingView, { onDone }), which Vue treats identically to a
// parent's `@done` listener (emit() reads `vnode.props.onDone`). No existing
// screen test in this repo emits from the root, so this is spelled out
// rather than copied from a precedent.
//
// THE RACE THE COMMENT DESCRIBES, PROVEN, NOT JUST READ: onPrimaryAction's
// intro-step branch is fully synchronous UNLESS the step it's entering is the
// timezone step, in which case it awaits enterTimezoneStep(), which itself
// awaits a bare `Promise.resolve()` between `step.value = TIMEZONE_STEP_INDEX`
// and `finishArmed.value = true` (.vue:201-206). Two clicks with NO await
// between them (SC-17 idiom) land IN that window: click 1 flips step
// synchronously then yields at the microtask; click 2 (still same synchronous
// script) now reads isTimezoneStep===true but finishArmed===false, and
// returns a no-op (.vue:216). Proven by asserting the outcome is "landed on
// the timezone step, nothing submitted" -- not by reading the refs (they are
// not exposed).
//
// detectDefaultTimezone()'s three branches (.vue:163-181) are proven through
// the PRE-SELECTED row TimezoneCityPicker renders (`.tz-picker__row--active`),
// not by reaching into the ref -- `Intl.DateTimeFormat` is spied only for its
// ZERO-ARG call (the OS-detected-zone read); `isValidIana`'s validity checks
// (called WITH args) fall through to the real implementation so validity is
// asserted for real, not re-implemented in the mock.
//
// TRAPS PRESENT:
//  - Explicit-selection gate: «Готово» stays disabled until a city is TAPPED,
//    even though a default is pre-selected (.vue:185-188) -- so the
//    auto-detect branches are provable only through the pre-selection, never
//    through a submitted payload (the button is unreachable without a tap).
//
// TRAPS ABSENT:
//  - NO VModal/VBottomSheet, no wall clock (system time), no money, no list.
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
 *  detectDefaultTimezone) -- calls WITH args (isValidIana's validity checks)
 *  fall through to the real constructor, so validity is proven for real. */
function mockDetectedTimezone(zone: string): void {
  const RealDTF = Intl.DateTimeFormat
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(((...args: unknown[]) => {
    if (args.length === 0) {
      return { resolvedOptions: () => ({ timeZone: zone }) } as unknown as Intl.DateTimeFormat
    }
    return new RealDTF(
      ...(args as ConstructorParameters<typeof Intl.DateTimeFormat>),
    ) as Intl.DateTimeFormat
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

function tzRow(zoneOrCity: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.tz-picker__row') ?? []).find((r) =>
    r.textContent?.includes(zoneOrCity),
  )
}

function activeTzZone(): string | null {
  return (
    host?.querySelector('.tz-picker__row--active .tz-picker__zone')?.textContent?.trim() ?? null
  )
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

    it('«Пропустить» jumps straight to the timezone step, skipping slides 1-2', async () => {
      mount()
      await flush()

      skipButton()?.click()
      await flush()

      expect(text()).toContain('Часовой пояс')
      expect(activeDotIndex()).toBe(3)
      expect(skipButton()).toBeNull() // hidden on the timezone step
    })
  })

  describe('entering the timezone step (the guarded transition)', () => {
    it('the 3rd «Далее» (from the last intro slide) enters the timezone form and relabels the button', async () => {
      mount()
      await flush()
      primaryButton().click()
      await flush()
      primaryButton().click()
      await flush()
      expect(text()).toContain('Карта себя') // sanity: really on slide 2

      primaryButton().click()
      await flush()

      expect(text()).toContain('Часовой пояс')
      expect(primaryButton().textContent?.trim()).toBe('Готово')
      expect(primaryButton().disabled).toBe(true) // gated: no city tapped yet
    })

    it('a same-tick second click that races the transition is swallowed by finishArmed, not treated as Готово', async () => {
      // On slide 2 (last intro). Two clicks with NO await between: click 1's
      // enterTimezoneStep() sets step=3 synchronously then yields at
      // `await Promise.resolve()`; click 2 runs in that same synchronous
      // script, sees isTimezoneStep=true / finishArmed=false, and no-ops
      // (.vue:216) instead of calling finish().
      mount()
      await flush()
      primaryButton().click()
      await flush()
      primaryButton().click()
      await flush()
      expect(text()).toContain('Карта себя')

      primaryButton().click()
      primaryButton().click() // no await between -- lands inside the race window
      await flush()

      // Landed on the timezone step exactly once -- not bounced past it, and
      // finish() was never reached (no persistence attempt, no navigation).
      expect(text()).toContain('Часовой пояс')
      expect(activeDotIndex()).toBe(3)
      expect(usersApi.updateMe).not.toHaveBeenCalled()
    })
  })

  describe('detectDefaultTimezone (pre-selected row, not a submitted payload)', () => {
    it('a valid profile timezone wins and is pre-selected', async () => {
      const authStore = useAuthStore()
      authStore.user = user({ timezone: 'Europe/Moscow' })
      mount()
      await flush()
      skipButton()?.click()
      await flush()

      expect(activeTzZone()).toBe('Europe/Moscow')
    })

    it('an invalid/missing profile zone falls back to the OS-detected zone', async () => {
      mockDetectedTimezone('Europe/London')
      const authStore = useAuthStore()
      authStore.user = user({ timezone: 'not-a-real-zone' })
      mount()
      await flush()
      skipButton()?.click()
      await flush()

      expect(activeTzZone()).toBe('Europe/London')
    })

    it('no profile zone AND an unusable OS zone falls back to UTC (no city pre-selected)', async () => {
      // UTC has no entry in the curated city list, so the picker shows no
      // active row -- the honest signature of the UTC fallback, checked
      // against the positive case above so this is not vacuous (SC-15).
      mockDetectedTimezone('')
      const authStore = useAuthStore()
      // UserResponse.timezone is a non-null string (a real account always has
      // SOME value) -- an empty string is the honest "nothing usable" fixture,
      // not null; isValidIana('') is false via its own `if (!zone)` guard.
      authStore.user = user({ timezone: '' })
      mount()
      await flush()
      skipButton()?.click()
      await flush()

      expect(host?.querySelector('.tz-picker__row--active')).toBeNull()
    })
  })

  describe('picking a city and finishing', () => {
    it('tapping a city arms «Готово» and finishing persists timezone + onboarding_completed, then emits done', async () => {
      const onDone = vi.fn()
      mount(onDone)
      await flush()
      skipButton()?.click()
      await flush()
      expect(primaryButton().disabled).toBe(true)

      tzRow('Лондон')?.click()
      await flush()
      expect(primaryButton().disabled).toBe(false)

      primaryButton().click()
      await flush()

      expect(usersApi.updateMe).toHaveBeenCalledWith({
        timezone: 'Europe/London',
        onboarding_completed: true,
      })
      expect(onDone).toHaveBeenCalledTimes(1)
    })

    it('a failed save toasts the REAL backend message and does NOT emit done', async () => {
      vi.mocked(usersApi.updateMe).mockRejectedValue(
        new ApiResponseError(500, 'Сервис недоступен', 'server_error'),
      )
      const onDone = vi.fn()
      mount(onDone)
      await flush()
      skipButton()?.click()
      await flush()
      tzRow('Лондон')?.click()
      await flush()

      primaryButton().click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Сервис недоступен')
      expect(onDone).not.toHaveBeenCalled()
      // Stays on the timezone step so the user can retry, not bounced back
      // to slide 0.
      expect(text()).toContain('Часовой пояс')
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
      skipButton()?.click()
      await flush()
      tzRow('Лондон')?.click()
      await flush()

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
// - TimezoneCityPicker's own search filtering / offset display: the picker's
//   own logic, not this screen's; only its selection contract (v-model) is
//   exercised here.
// - App.vue's gate that decides WHEN this screen mounts (onboarding_completed
//   === false): that is App.vue's own branching, out of this screen's surface.
// =============================================================================
