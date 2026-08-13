// =============================================================================
// VELO Frontend -- LanguageTimezoneView Screen Tests (probekit-screen-test)
// =============================================================================
//
// 255 lines, shared user/master settings screen (mounted on BOTH roles' routes,
// role-agnostic; no role-specific behaviour to split on).
//
// PATTERN A (store-backed): the one real seam is authStore.updateProfile
// (auth.ts:142), which calls updateMe (@/api/users, auth.ts:143) then stores the
// result. The REAL useAuthStore is used; @/api/users is mocked. Error branching
// is ApiResponseError from @/api/client (auth.ts import chain, .vue:80).
//
// CHILD SEAM CHECKED, NOT ASSUMED, AND CORRECTED: the real (unstubbed)
// TimezoneCityPicker was suspected of its own fetch seam (EditProfileView's
// MethodTaxonomyPicker precedent, per the operator recon). Read it end to end
// (TimezoneCityPicker.vue) -- it has NONE. Its city list is a static import
// (TIMEZONE_CITIES, @/utils/timezoneCities), no onMounted, no API call. It is
// driven for real throughout below: clicking a city row is what fires
// `@update:modelValue` on the child (TimezoneCityPicker.vue:97), exercising
// the real wiring instead of calling the handler off a fixture.
//
// ============================================================================
// A REAL BUG, FOUND BY THIS FILE, MUTATION-CONFIRMED, AND NOW FIXED (this same
// commit -- source + assertions together, unlike the coverage-only pass that
// found it).
// ============================================================================
// .vue:59 used to write BOTH `v-model="selectedTimezone"` AND an explicit
// `@update:modelValue="onTimezoneChange"` on the SAME <TimezoneCityPicker>
// tag. Compiling that template (checked directly via @vue/compiler-sfc's
// compileTemplate) showed Vue merging them into an ARRAY of two
// `onUpdate:modelValue` handlers: the auto-generated v-model setter
// (`selectedTimezone.value = $event`) FIRST, then `onTimezoneChange` SECOND.
// Vue invokes array-valued emit handlers in that order, unconditionally, on
// every emission -- `onTimezoneChange` never got to run before the raw setter
// had already applied the new value.
//
// Two consequences, both mutation-confirmed BEFORE the fix (temporarily
// edited the source, ran the suite, reverted -- see the prior commit's test
// banner for the full before-state):
//   (a) `const previous = selectedTimezone.value` (.vue:148) captured the
//       ALREADY-NEW value, so the catch-path `selectedTimezone.value =
//       previous` (.vue:156) was a no-op -- deleting it changed nothing.
//   (b) The `saving` guard (.vue:147) blocked a second API call but not the
//       raw setter, so a second tap mid-save could leave the UI showing the
//       second city while the first was what actually got persisted.
//
// THE FIX (.vue:59): `v-model="selectedTimezone"` -> `:model-value=
// "selectedTimezone"`, keeping the explicit `@update:modelValue=
// "onTimezoneChange"`. One-way binding removes the auto-generated setter
// entirely -- `onTimezoneChange` is now the ONLY writer of `selectedTimezone`,
// so `previous` (.vue:148) is the true prior value, the revert (.vue:156) is
// live, and the `saving` guard (.vue:147) now short-circuits BEFORE .vue:149
// ever runs, protecting the display too. Confirmed independently before
// editing: `selectedTimezone` has exactly one reader (init, .vue:142) and is
// written only inside `onTimezoneChange` (.vue:149,156) -- no other code
// relied on the implicit v-model setter.
//
// RE-MUTATED AFTER THE FIX, for the discriminating proof: deleting .vue:156
// now turns the revert test RED (was byte-identical GREEN before the fix --
// see the prior commit) -- proof the fix revived the line rather than the
// test merely re-asserting a claim. Guard-removal at .vue:147 still turns the
// reentrancy test RED (call count AND, now, the display-stays assertion).
// Both re-verified live, then restored -- not left in the tree.
// ============================================================================
//
// TIMEZONE_CITIES ITSELF DOES DOUBLE DUTY as the isValidIana probe. Its
// `generatedZones()` (timezoneCities.ts:177-192) walks the REAL
// `Intl.supportedValuesOf('timeZone')` and renders one row per zone this Node's
// ICU actually supports, keyed by iana. That is used directly (no Intl mock,
// per the operator recon) to observe .vue:129-142's two branches from the
// OUTSIDE: a valid-but-uncurated zone ('Pacific/Kiritimati', confirmed present
// via `Intl.supportedValuesOf('timeZone').includes(...)` in this repo's node)
// renders its generated row as active; a genuinely invalid string ('Not/AZone',
// confirmed to throw in `Intl.DateTimeFormat` in this repo's node) renders NO
// active row at all, because the FALLBACK_TIMEZONE 'UTC' constant is itself
// absent from TIMEZONE_CITIES (not in CURATED/ALIASES, and 'UTC' is excluded
// from Node's supportedValuesOf('timeZone') list) -- "no row is active" is the
// honest, network-free way to observe a fallback to a value nothing renders.
//
// LANGUAGE BRANCH -- A REAL, DOCUMENTED GAP, not silently skipped (recon
// flagged this; verified true by reading the file, not assumed): LANGUAGE_OPTIONS
// (.vue:96-98) currently renders ONLY 'ru' (English hidden 2026-06-19, available
// stub kept for later). onSelectLanguage's `!opt.available` toast branch
// (.vue:106-110) is therefore DEAD from the template's own perspective -- there
// is no second button to click, and the file has no defineExpose, so the
// handler cannot be invoked directly without changing production source, which
// is out of this task's scope (minimal-scope rule). The first test below in
// that describe block PROVES the branch is unreachable (asserts exactly one
// `.lang-tz__lang` button renders) rather than asserting nothing about it; the
// gap is reported as logic-covered-not-template-reachable, not swept under a
// green suite.
//
// MONEY: none on this screen. Nothing to NBSP-guard.
//
// No modal, no v-show (grepped this file and TimezoneCityPicker.vue -- both
// v-if only), no window.location / clipboard / IntersectionObserver /
// ResizeObserver seam. No order dependence -- every test mounts its own app +
// fresh Pinia.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import LanguageTimezoneView from '@/views/user/LanguageTimezoneView.vue'
import * as usersApi from '@/api/users'
import { useAuthStore } from '@/stores/auth'
import { ApiResponseError } from '@/api/client'
import type { UserResponse } from '@/api/types'

vi.mock('@/api/users')

const back = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ back }),
}))

const toastError = vi.fn()
const toastInfo = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, info: toastInfo, success: vi.fn() }),
}))

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function user(overrides: Partial<UserResponse> = {}): UserResponse {
  return {
    id: 'user_1',
    telegram_id: 1,
    role: 'user',
    first_name: 'Аня',
    last_name: 'Иванова',
    avatar_url: null,
    timezone: 'Europe/Moscow',
    language: 'ru',
    is_active: true,
    balance_cents: 0,
    created_at: '2026-01-01T00:00:00Z',
    last_login_at: null,
    onboarding_completed: true,
    master_onboarding_completed: false,
    phone: null,
    bio: null,
    email: null,
    master_notifications: null,
    role_switch: null,
    ...overrides,
  }
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(LanguageTimezoneView)
  app.use(pinia)
  app.mount(host)
  return host
}

// Mount itself is synchronous (init is off the store, see banner) but the SAVE
// chain is not: onTimezoneChange -> await authStore.updateProfile -> await
// updateMe, each a microtask hop, then the catch/finally re-render. COUNTED,
// not copied (SC-08): 2 awaits deep plus Vue's own scheduler flush -- 8 ticks
// is generous headroom, matching this repo's other Pattern-A screens.
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await nextTick()
}

function cityRow(cityLabel: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.tz-picker__row') ?? []).find(
    (r) => r.querySelector('.tz-picker__city')?.textContent?.trim() === cityLabel,
  )
}
function activeCityRows(): HTMLButtonElement[] {
  return Array.from(
    host?.querySelectorAll<HTMLButtonElement>('.tz-picker__row.tz-picker__row--active') ?? [],
  )
}
function languageButtons(): HTMLButtonElement[] {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.lang-tz__lang') ?? [])
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)

  vi.mocked(usersApi.updateMe)
    .mockReset()
    .mockImplementation(async (body) => user(body as Partial<UserResponse>))

  useAuthStore().user = user()

  back.mockReset()
  toastError.mockReset()
  toastInfo.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('LanguageTimezoneView', () => {
  // ===========================================================================
  describe('timezone: optimistic update with revert on failure', () => {
    it('success: selecting a city calls updateProfile with the new zone and toasts success', async () => {
      mount()
      await flush()

      cityRow('Берлин')?.click()
      await flush()

      expect(usersApi.updateMe).toHaveBeenCalledWith({ timezone: 'Europe/Berlin' })
      expect(toastInfo).toHaveBeenCalledWith('Часовой пояс сохранён')
      expect(cityRow('Берлин')?.classList.contains('tz-picker__row--active')).toBe(true)
    })

    it('failure: reverts the selection to the previous city and toasts the error (fixed -- see banner)', async () => {
      vi.mocked(usersApi.updateMe).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      expect(cityRow('Москва')?.classList.contains('tz-picker__row--active')).toBe(true)

      cityRow('Берлин')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось сохранить часовой пояс')
      // The :model-value fix restores the revert: `previous` is now the true
      // prior value, so the catch path (.vue:156) puts Moscow back and Berlin
      // -- the value that failed to save -- is no longer shown as selected.
      expect(cityRow('Москва')?.classList.contains('tz-picker__row--active')).toBe(true)
      expect(cityRow('Берлин')?.classList.contains('tz-picker__row--active')).toBe(false)
    })

    it('saving guard: a second selection while the first save is in flight is fully ignored -- no second API call, display stays on the first (committed) city', async () => {
      let resolveUpdate!: (u: UserResponse) => void
      vi.mocked(usersApi.updateMe)
        .mockReset()
        .mockImplementation(
          () =>
            new Promise<UserResponse>((resolve) => {
              resolveUpdate = resolve
            }),
        )
      mount()
      await flush()

      // No await between the two clicks -- `saving` must gate the second call
      // synchronously, in the same frame, not after a tick settles it.
      cityRow('Берлин')?.click()
      cityRow('Лондон')?.click()
      await flush()

      // The GUARD holds for the API call: only Berlin (the first tap) is ever
      // persisted. Mutation-confirmed: commenting out .vue:147's guard makes
      // this go from 1 call to 2 (Лондон's tap also reaching updateMe).
      expect(usersApi.updateMe).toHaveBeenCalledTimes(1)
      expect(usersApi.updateMe).toHaveBeenCalledWith({ timezone: 'Europe/Berlin' })

      resolveUpdate(user({ timezone: 'Europe/Berlin' }))
      await flush()

      // Fixed (see banner): with the raw setter gone, the second click's
      // ONLY effect was `onTimezoneChange` reading `saving.value === true`
      // and returning immediately (.vue:147) -- it never touched
      // `selectedTimezone`. Berlin, the first (and only persisted) tap, stays
      // shown as selected; London never gets applied to the display either.
      expect(toastInfo).toHaveBeenCalledWith('Часовой пояс сохранён')
      expect(cityRow('Берлин')?.classList.contains('tz-picker__row--active')).toBe(true)
      expect(cityRow('Лондон')?.classList.contains('tz-picker__row--active')).toBe(false)
    })
  })

  // ===========================================================================
  describe('timezone: save error branching (ApiResponseError vs generic)', () => {
    it('ApiResponseError WITH a detail surfaces the real backend message', async () => {
      vi.mocked(usersApi.updateMe).mockRejectedValue(
        new ApiResponseError(422, 'Некорректный часовой пояс', 'validation_error'),
      )
      mount()
      await flush()

      cityRow('Берлин')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Некорректный часовой пояс')
    })

    it('ApiResponseError with an EMPTY detail falls back to the generic message', async () => {
      vi.mocked(usersApi.updateMe).mockRejectedValue(new ApiResponseError(500, '', 'server_error'))
      mount()
      await flush()

      cityRow('Берлин')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось сохранить часовой пояс')
    })

    it('a non-ApiResponseError (network failure) also falls back to the generic message (SC-05)', async () => {
      vi.mocked(usersApi.updateMe).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      cityRow('Берлин')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось сохранить часовой пояс')
    })
  })

  // ===========================================================================
  describe('timezone: initial value via isValidIana (real Intl, no mock)', () => {
    it('a valid but uncurated IANA zone is kept as-is, not folded to the fallback', async () => {
      useAuthStore().user = user({ timezone: 'Pacific/Kiritimati' })
      mount()
      await flush()

      const row = cityRow('Kiritimati')
      expect(row).toBeDefined()
      expect(row?.classList.contains('tz-picker__row--active')).toBe(true)
    })

    it('a genuinely invalid zone string falls back to UTC, which renders NO active row', async () => {
      useAuthStore().user = user({ timezone: 'Not/AZone' })
      mount()
      await flush()

      // 'UTC' is absent from TIMEZONE_CITIES (not curated, and excluded from
      // this Node's Intl.supportedValuesOf('timeZone')) -- no row can be
      // active for it. This is the honest observation of the fallback.
      expect(activeCityRows()).toHaveLength(0)
    })
  })

  // ===========================================================================
  describe('language', () => {
    it('only Русский renders -- the unavailable/English branch is unreachable via the template (documented gap, see banner)', async () => {
      mount()
      await flush()

      expect(languageButtons()).toHaveLength(1)
      expect(languageButtons()[0]?.textContent).toContain('Русский')
    })

    it('Русский initialises active from the stored (available) language and stays active on click', async () => {
      useAuthStore().user = user({ language: 'ru' })
      mount()
      await flush()

      const ruBtn = languageButtons()[0]
      expect(ruBtn?.classList.contains('lang-tz__lang--active')).toBe(true)

      ruBtn?.click()
      await flush()

      expect(ruBtn?.classList.contains('lang-tz__lang--active')).toBe(true)
      // Only one real language today -- selecting it persists nothing.
      expect(usersApi.updateMe).not.toHaveBeenCalled()
    })

    it('a stored language with no matching available option still initialises to ru, not a crash', async () => {
      useAuthStore().user = user({ language: 'en' })
      mount()
      await flush()

      expect(languageButtons()[0]?.classList.contains('lang-tz__lang--active')).toBe(true)
    })
  })
})
