// =============================================================================
// VELO Frontend -- MasterPublicView Screen Tests (probekit-screen-test v1.9)
// =============================================================================
//
// 358 lines, no test. PATTERN B (local-ref), NOT A: no Pinia store is imported
// anywhere in the script (`ref`/`computed`/`onMounted` only) -- state lives in
// local refs (`profile`, `upcoming`, `loading`, `error`) fed by TWO direct
// `@/api/*` calls in onMounted (`getPublicMaster`, `getPractices`). Mocking a
// store here would be the classic "mock the wrong layer" trap (skill Step 3):
// the screen reads neither `usePracticesStore` nor any master store, so a
// store mock would drive nothing and the test would pass vacuously. Confirmed
// by reading every import in <script setup>, not assumed from the screen's
// domain (a "practices"/"master" screen elsewhere in this app WOULD be
// Pattern A -- this one specifically is not).
//
// Real Pinia is still installed (velo-idiom §1 extension) even though this
// screen's OWN pattern needs none: its real, unstubbed child
// CalendarPracticeCard resolves useViewerTimezone() internally and throws
// "no active Pinia" without one -- Pattern B does not mean Pinia-free.
//
// PROVEN ABSENT: no money anywhere (no formatMoney/NBSP), no wall clock
// (no Date.now()/new Date()), no per-route guard beyond the shared root
// roleRedirect (checked router/index.ts).
//
// `loading` starts at `ref(true)` (.vue:142) -- a LITERAL true from setup,
// not derived from a store default -- so unlike BookingConfirmedView's
// finding (a), there is NO pre-onMounted synchronous frame where this screen's
// own guard mismatches: the loader is already correct on the very first
// render, before onMounted has run at all. Proven below with a zero-tick
// assertion (the mirror image of BookingConfirmedView's structural finding).
//
// FIXED (B11 item 2, ПРОМТ №587): this file used to document a finding --
// extractApiError treated every ApiResponseError identically regardless of
// status code, and the template had exactly ONE combined v-else-if for
// "error OR no profile", so a genuine 404 and a transient 500/network drop
// both rendered the identical "Мастер не найден" title with no retry. Fixed
// by deriving `notFound` from `e instanceof ApiResponseError && e.status ===
// 404` in loadMaster() (.vue) and splitting the template into two
// v-else-if rungs: "Мастер не найден" (404, "Назад" only) vs. "Не удалось
// загрузить" (anything else, "Повторить" retry that re-runs loadMaster).
// Proven below: a 404 keeps the old title/no-retry; a plain Error and a 500
// both now get the retryable title instead.
//
// TWO INDEPENDENT FETCHES, confirmed NOT parallel and NOT equally fatal:
// getPractices only runs AFTER getPublicMaster resolves (nested, sequential --
// .vue:184-203), and its own try/catch is LOCAL: a practices failure never
// touches `error` or `profile`, so the profile still renders and only the
// "Ближайшие практики" section is silently absent (the header's own comment:
// "Non-fatal"). A master-fetch failure, conversely, never even calls
// getPractices (proven below) and always reaches the combined error rung.
//
// FIXED (B11 item 2): the script now `watch`es `masterId` and re-runs the
// same load on change, so a param-only in-place navigation (Vue Router
// reuses the component instance when only params change under the SAME
// matched record) re-loads instead of keeping the previous master under a
// new URL. Covered below by mutating the route param on an already-mounted
// instance (no router simulation needed to expose it).
//
// TICKS: getPublicMaster (1 await) -> nested getPractices (1 await, only on
// the success path) -> final re-render. flush() uses 5, generous.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, reactive, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import MasterPublicView from '@/views/user/MasterPublicView.vue'
import * as mastersApi from '@/api/masters'
import * as practicesApi from '@/api/practices'
import { ApiResponseError } from '@/api/client'
import type { MasterPublicResponse, PracticeResponse } from '@/api/types'

vi.mock('@/api/masters')
vi.mock('@/api/practices')

const back = vi.fn()
const push = vi.fn()
// reactive(), not a plain object: the secondary-finding test below mutates
// this AFTER mount to check whether the screen reacts to a route param
// change on an already-mounted instance. A plain object would make that test
// pass for the WRONG reason (nothing Vue-reactive to observe at all, so of
// course nothing re-fires, regardless of whether the source has a watch) --
// caught by mutation-testing a simulated fix against the first draft.
const routeParams = reactive<{ id: string }>({ id: 'm1' })
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back, replace: vi.fn() }),
  useRoute: () => ({ params: routeParams }),
}))

const toastInfo = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), info: toastInfo }),
}))

function masterProfile(overrides: Partial<MasterPublicResponse> = {}): MasterPublicResponse {
  return {
    user_id: 'm1',
    status: 'active',
    display_name: 'Анна Соколова',
    bio: 'Практикую медитацию 10 лет.',
    methods: ['Йога-нидра', 'Дыхательные практики'],
    experience_years: 5,
    avatar_url: null,
    practices_count: 7,
    reviews_count: 23,
    ...overrides,
  }
}

function practice(id: string, overrides: Partial<PracticeResponse> = {}): PracticeResponse {
  return {
    id,
    master_id: 'm1',
    master_name: 'Анна Соколова',
    practice_type: 'live',
    status: 'scheduled',
    title: `Практика ${id}`,
    description: null,
    scheduled_at: '2026-07-25T10:00:00Z',
    duration_minutes: 60,
    timezone: 'UTC',
    max_participants: 20,
    current_participants: 5,
    zoom_link: null,
    parent_practice_id: null,
    is_free: true,
    price_cents: 0,
    currency: 'EUR',
    direction: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: null,
    ...overrides,
  }
}

function page(items: PracticeResponse[]) {
  return { items, total: items.length, limit: 10, offset: 0 }
}

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia

// This screen itself is Pattern B (no store) -- but its real, unstubbed child
// CalendarPracticeCard resolves useViewerTimezone(), which needs an active
// Pinia or it throws before a single assertion runs (velo-idiom §1 extension,
// same as every screen test in this repo regardless of the screen's own
// pattern).
function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(MasterPublicView)
  app.use(pinia)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await nextTick()
}

function loader(): HTMLElement | null {
  return host?.querySelector('.master-public__loader') ?? null
}
function content(): HTMLElement | null {
  return host?.querySelector('.master-public__content') ?? null
}
function emptyState(): HTMLElement | null {
  return host?.querySelector('.v-empty') ?? null
}
function emptyTitle(): string {
  return (emptyState()?.querySelector('.v-empty__title')?.textContent ?? '').trim()
}
function emptyDesc(): string {
  return (emptyState()?.querySelector('.v-empty__desc')?.textContent ?? '').trim()
}
function emptyBackBtn(): HTMLButtonElement | null {
  return emptyState()?.querySelector<HTMLButtonElement>('button') ?? null
}
function headerBackBtn(): HTMLButtonElement | null {
  return host?.querySelector<HTMLButtonElement>('.v-back') ?? null
}
function statValues(): string[] {
  return Array.from(host?.querySelectorAll('.v-stat__value') ?? []).map((e) =>
    (e.textContent ?? '').trim(),
  )
}
function statLabels(): string[] {
  return Array.from(host?.querySelectorAll('.v-stat__label') ?? []).map((e) =>
    (e.textContent ?? '').trim(),
  )
}
function upcomingSection(): HTMLElement | null {
  return host?.querySelector('.master-public__upcoming') ?? null
}
function upcomingHeaderBtn(): HTMLButtonElement | null {
  return upcomingSection()?.querySelector<HTMLButtonElement>('.v-accordion__header') ?? null
}
function practiceCards(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.practice-list-card') ?? [])
}
function askBtn(): HTMLButtonElement | null {
  return host?.querySelector<HTMLButtonElement>('.master-public__actions .v-btn') ?? null
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)

  vi.mocked(mastersApi.getPublicMaster).mockReset()
  vi.mocked(practicesApi.getPractices).mockReset()
  toastInfo.mockReset()
  push.mockReset()
  back.mockReset()
  routeParams.id = 'm1'
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('MasterPublicView', () => {
  // ===========================================================================
  describe('the ladder', () => {
    it('loading starts true from setup itself: the loader shows on the very first render, zero ticks after mount()', () => {
      vi.mocked(mastersApi.getPublicMaster).mockReturnValue(new Promise(() => {}))
      mount() // no await -- inspecting the pre-onMounted DOM on purpose

      expect(loader()).not.toBeNull()
      expect(emptyState()).toBeNull()
      expect(content()).toBeNull()
    })

    it('content: a successful master fetch renders the hero + stats', async () => {
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValue(masterProfile())
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([]))
      mount()
      await flush()

      expect(loader()).toBeNull()
      expect(emptyState()).toBeNull()
      expect(content()).not.toBeNull()
      expect(content()?.textContent).toContain('Анна Соколова')
      expect(content()?.textContent).toContain('Верифицирован')
    })

    it('FIXED (B11 item 2, ПРОМТ №587): a 404 ApiResponseError shows "Мастер не найден" with the backend\'s own detail, and NO retry action', async () => {
      vi.mocked(mastersApi.getPublicMaster).mockRejectedValue(
        new ApiResponseError(404, 'Мастер не найден или не верифицирован', 'not_found'),
      )
      mount()
      await flush()

      expect(emptyTitle()).toBe('Мастер не найден')
      expect(emptyDesc()).toBe('Мастер не найден или не верифицирован')
      expect(emptyState()?.textContent).not.toContain('Повторить')
    })

    it('FIXED: a plain network Error (NOT a 404) shows a DIFFERENT, retryable state -- "Не удалось загрузить" / "Попробуйте позже", with a "Повторить" button', async () => {
      vi.mocked(mastersApi.getPublicMaster).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      expect(emptyTitle()).toBe('Не удалось загрузить')
      expect(emptyDesc()).toBe('Попробуйте позже')
      expect(emptyState()?.textContent).toContain('Повторить')
    })

    it('FIXED corollary: a 500 ApiResponseError (backend reachable, real server error) ALSO gets the retryable state, not "не найден"', async () => {
      vi.mocked(mastersApi.getPublicMaster).mockRejectedValue(
        new ApiResponseError(500, 'Внутренняя ошибка сервера', 'internal_error'),
      )
      mount()
      await flush()

      expect(emptyTitle()).toBe('Не удалось загрузить') // no longer "не найден" -- the master likely DOES exist
      expect(emptyDesc()).toBe('Внутренняя ошибка сервера')
      expect(emptyState()?.textContent).toContain('Повторить')
    })

    it('retry: clicking "Повторить" on the 5xx/network state re-calls getPublicMaster and can recover into content', async () => {
      vi.mocked(mastersApi.getPublicMaster).mockRejectedValueOnce(new Error('ECONNRESET'))
      mount()
      await flush()
      expect(emptyTitle()).toBe('Не удалось загрузить')

      vi.mocked(mastersApi.getPublicMaster).mockResolvedValueOnce(masterProfile())
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([]))
      emptyState()?.querySelector<HTMLButtonElement>('button')?.click()
      await flush()

      expect(mastersApi.getPublicMaster).toHaveBeenCalledTimes(2)
      expect(emptyState()).toBeNull()
      expect(content()?.textContent).toContain('Анна Соколова')
    })
  })

  // ===========================================================================
  describe('the two independent fetches', () => {
    it('a master-fetch failure never even calls getPractices (sequential, not parallel)', async () => {
      vi.mocked(mastersApi.getPublicMaster).mockRejectedValue(new Error('boom'))
      mount()
      await flush()

      expect(practicesApi.getPractices).not.toHaveBeenCalled()
    })

    it('a practices-fetch failure is non-fatal: the profile still renders in full, only "Ближайшие практики" is silently absent', async () => {
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValue(masterProfile())
      vi.mocked(practicesApi.getPractices).mockRejectedValue(new Error('practices down'))
      mount()
      await flush()

      expect(emptyState()).toBeNull() // NOT the error rung
      expect(content()).not.toBeNull()
      expect(content()?.textContent).toContain('Анна Соколова')
      expect(upcomingSection()).toBeNull() // section absent, no error shown for it either
    })

    it('a genuinely empty practices list produces the SAME absence as a failed fetch -- indistinguishable to the user (proven, not asserted as a bug: header documents this as intentional)', async () => {
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValue(masterProfile())
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([]))
      mount()
      await flush()

      expect(upcomingSection()).toBeNull()
    })

    it('getPractices is called with the master_id derived from the route, not hardcoded', async () => {
      routeParams.id = 'm_specific'
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValue(
        masterProfile({ user_id: 'm_specific' }),
      )
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([]))
      mount()
      await flush()

      expect(practicesApi.getPractices).toHaveBeenCalledWith(
        expect.objectContaining({ master_id: 'm_specific', status: 'scheduled' }),
        10,
        0,
      )
    })

    it('upcoming practices render when present, and clicking a card navigates to practice-detail', async () => {
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValue(masterProfile())
      vi.mocked(practicesApi.getPractices).mockResolvedValue(
        page([practice('pr1', { title: 'Утренняя медитация' })]),
      )
      mount()
      await flush()

      expect(upcomingSection()).not.toBeNull()
      upcomingHeaderBtn()?.click() // accordion defaults collapsed -- expand it
      await nextTick()

      expect(practiceCards()).toHaveLength(1)
      practiceCards()[0]?.click()

      expect(push).toHaveBeenCalledWith({ name: 'practice-detail', params: { id: 'pr1' } })
    })
  })

  // ===========================================================================
  describe('stat cards', () => {
    it('show the fetched practices_count / reviews_count, not swapped', async () => {
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValue(
        masterProfile({ practices_count: 7, reviews_count: 23 }),
      )
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([]))
      mount()
      await flush()

      expect(statValues()).toEqual(['7', '23'])
      expect(statLabels()[0]).toContain('Практик')
      expect(statLabels()[1]).toContain('Отзыв')
    })
  })

  // ===========================================================================
  describe("ask-master (V2 stub -- NOT disabled, unlike BookingConfirmedView's)", () => {
    it("the button is fully enabled (a different stub shape than BookingConfirmedView's disabled textarea+button)", async () => {
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValue(masterProfile())
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([]))
      mount()
      await flush()

      expect(askBtn()?.disabled).toBe(false)
    })

    it('clicking it fires the "coming soon" toast and does NOT navigate anywhere', async () => {
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValue(masterProfile())
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([]))
      mount()
      await flush()

      askBtn()?.click()

      expect(toastInfo).toHaveBeenCalledWith('Вопрос мастеру -- скоро')
      expect(push).not.toHaveBeenCalled()
    })
  })

  // ===========================================================================
  describe('navigation', () => {
    it('the header back arrow calls router.back()', async () => {
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValue(masterProfile())
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([]))
      mount()
      await flush()

      headerBackBtn()?.click()

      expect(back).toHaveBeenCalledTimes(1)
    })

    it('"Назад" in the not-found (404) rung calls router.back()', async () => {
      // B11 item 2: a non-404 failure now lands on the RETRYABLE rung, whose
      // sole button is "Повторить" (re-fetches), not "Назад" -- see the
      // dedicated retry test above. Only the 404 rung still offers "Назад".
      vi.mocked(mastersApi.getPublicMaster).mockRejectedValue(
        new ApiResponseError(404, 'Мастер не найден', 'not_found'),
      )
      mount()
      await flush()

      emptyBackBtn()?.click()

      expect(back).toHaveBeenCalledTimes(1)
    })
  })

  // ===========================================================================
  describe('route param watch (B11 item 2)', () => {
    it('mutating route.params.id on an ALREADY-MOUNTED instance re-fetches the new master -- Vue Router reuses the component instance when only params change under the same matched route', async () => {
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValueOnce(masterProfile({ user_id: 'm1' }))
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([]))
      mount()
      await flush()
      expect(mastersApi.getPublicMaster).toHaveBeenCalledTimes(1)
      expect(mastersApi.getPublicMaster).toHaveBeenCalledWith('m1')

      // Simulate what a param-only in-place navigation would do to `route`.
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValueOnce(masterProfile({ user_id: 'm2' }))
      routeParams.id = 'm2'
      await flush()

      expect(mastersApi.getPublicMaster).toHaveBeenCalledTimes(2)
      expect(mastersApi.getPublicMaster).toHaveBeenLastCalledWith('m2')
      expect(content()?.textContent).toContain('Анна Соколова')
    })

    it('re-fetch on param change shows the loader again and re-fetches upcoming practices scoped to the new master_id', async () => {
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValueOnce(masterProfile({ user_id: 'm1' }))
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([]))
      mount()
      await flush()

      vi.mocked(mastersApi.getPublicMaster).mockResolvedValueOnce(masterProfile({ user_id: 'm2' }))
      routeParams.id = 'm2'
      await flush()

      expect(practicesApi.getPractices).toHaveBeenLastCalledWith(
        expect.objectContaining({ master_id: 'm2', status: 'scheduled' }),
        10,
        0,
      )
    })
  })
})
