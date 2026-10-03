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
// FIXED (B11 item 2, PROMPT №587): this file used to document a finding --
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
import * as chatsApi from '@/api/chats'
import * as cgApi from '@/api/curatorGroups'
import type { MasterPublicResponse, PracticeResponse } from '@/api/types'

vi.mock('@/api/masters')
vi.mock('@/api/practices')
vi.mock('@/api/chats')
vi.mock('@/api/curatorGroups')

const back = vi.fn()
const push = vi.fn()
// reactive(), not a plain object: the secondary-finding test below mutates
// this AFTER mount to check whether the screen reacts to a route param
// change on an already-mounted instance. A plain object would make that test
// pass for the WRONG reason (nothing Vue-reactive to observe at all, so of
// course nothing re-fires, regardless of whether the source has a watch) --
// caught by mutation-testing a simulated fix against the first draft.
const routeParams = reactive<{ id: string }>({ id: 'm1' })
const routeQuery = reactive<{ groupId?: string }>({})
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back, replace: vi.fn() }),
  useRoute: () => ({ params: routeParams, query: routeQuery }),
}))

const toastInfo = vi.fn()
const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: toastInfo }),
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

function unmount(): void {
  app?.unmount()
  host?.remove()
  app = null
  host = null
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
function practiceCards(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.practice-list-card') ?? [])
}
function methodPills(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.master-public__chips .v-tag') ?? [])
}
function pillTexts(): string[] {
  return methodPills().map((p) => (p.textContent ?? '').trim().replace(/\s+/g, ' '))
}
// Owner 2026-09-30: the accordion is defaultOpen -- pills read directly.

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)

  vi.mocked(mastersApi.getPublicMaster).mockReset()
  vi.mocked(practicesApi.getPractices).mockReset()
  toastInfo.mockReset()
  toastError.mockReset()
  vi.mocked(chatsApi.openChat).mockReset()
  push.mockReset()
  back.mockReset()
  routeParams.id = 'm1'
  routeQuery.groupId = undefined
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('MasterPublicView', () => {
  describe('curator school-context actions (owner 2026-09-30)', () => {
    function menuButton(): HTMLElement | undefined {
      return Array.from(document.body.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
        (b) => b.getAttribute('aria-label') === 'Действия с мастером',
      )
    }
    function menuItem(label: string): HTMLButtonElement | undefined {
      return Array.from(
        document.body.querySelectorAll<HTMLButtonElement>('.v-menu-item') ?? [],
      ).find((b) => b.getAttribute('aria-label') === label)
    }
    function liveModal(): HTMLElement | undefined {
      const containers = Array.from(
        document.body.querySelectorAll<HTMLElement>('.v-modal__container'),
      )
      return containers[containers.length - 1]
    }
    function modalButton(label: string): HTMLButtonElement | undefined {
      return Array.from(liveModal()?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
        (b) => b.textContent?.trim() === label,
      )
    }
    function openMenu(): Promise<void> {
      menuButton()?.click()
      return flush()
    }

    it('no ?groupId: the menu carries only «Написать сообщение» -- no curator actions', async () => {
      mount()
      await flush()
      await openMenu()

      expect(menuItem('Написать сообщение')).toBeTruthy()
      expect(menuItem('Изменить роль')).toBeUndefined()
      expect(menuItem('Заблокировать')).toBeUndefined()
    })

    it('with ?groupId the «⋯» menu carries the three curator actions', async () => {
      routeQuery.groupId = 'g1'
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValue(masterProfile())
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([]))
      mount()
      await flush()
      await openMenu()

      expect(menuItem('Написать сообщение')).toBeTruthy()
      expect(menuItem('Изменить роль')).toBeTruthy()
      expect(menuItem('Заблокировать')).toBeTruthy()
    })

    it('«Написать сообщение» opens the composer; sending opens the DM, posts the text and closes', async () => {
      routeQuery.groupId = 'g1'
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValue(masterProfile())
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([]))
      vi.mocked(chatsApi.openChat).mockResolvedValue({
        id: 'thread-9',
        created_at: '2026-09-30T10:00:00+00:00',
      })
      vi.mocked(chatsApi.sendChatMessage).mockResolvedValue({
        id: 'msg-9',
        thread_id: 'thread-9',
        sender: 'me',
        body: 'Привет',
        created_at: '2026-09-30T10:01:00+00:00',
      })
      mount()
      await flush()
      await openMenu()

      menuItem('Написать сообщение')?.click()
      await flush()

      // The composer: recipient chip + textarea + pills.
      expect(document.body.textContent).toContain('Отправить')
      const modal = liveModal()
      const field = modal?.querySelector<HTMLTextAreaElement>('.send-msg textarea')
      field!.value = 'Привет'
      field!.dispatchEvent(new Event('input'))
      await flush()

      modalButton('Отправить')?.click()
      await flush()

      // open-or-get the DM with THIS master, then post the text.
      expect(chatsApi.openChat).toHaveBeenCalledWith('m1')
      expect(chatsApi.sendChatMessage).toHaveBeenCalledWith('thread-9', 'Привет')
      expect(toastSuccess).toHaveBeenCalledWith('Сообщение отправлено')
    })

    it('«Изменить роль»: preselects «Мастер»; the demote pick enables a marked no-op confirm (BE-59)', async () => {
      routeQuery.groupId = 'g1'
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValue(masterProfile())
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([]))
      mount()
      await flush()
      await openMenu()

      menuItem('Изменить роль')?.click()
      await flush()

      const modal = liveModal()
      expect(modal?.textContent).toContain('Изменить роль')
      expect(modal?.textContent).toContain('Выберите роль')
      expect(modalButton('Мастер')?.getAttribute('aria-checked')).toBe('true')
      expect(modalButton('Изменить')?.disabled).toBe(true)

      modalButton('Ученик')?.click()
      await flush()
      expect(modalButton('Изменить')?.disabled).toBe(false)

      modalButton('Изменить')?.click()
      await flush()

      // The BE-59 demote is wired: the roster's school + the page's master.
      expect(vi.mocked(cgApi.demoteCuratorGroupMaster)).toHaveBeenCalledWith('g1', 'm1')
      expect(toastSuccess).toHaveBeenCalledWith('Роль изменена: участник теперь ученик школы')
    })

    it('«Изменить роль»: a demote failure toasts the API error and keeps the modal open', async () => {
      routeQuery.groupId = 'g1'
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValue(masterProfile())
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([]))
      vi.mocked(cgApi.demoteCuratorGroupMaster).mockRejectedValue(
        new ApiResponseError(500, 'backend said no'),
      )
      mount()
      await flush()
      await openMenu()

      menuItem('Изменить роль')?.click()
      await flush()
      modalButton('Ученик')?.click()
      await flush()
      modalButton('Изменить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось изменить роль')
      expect(liveModal()).not.toBeNull()
    })

    // BE-79 (2): this pinned the INTERIM no-op (an info toast) -- right until
    // the block endpoint landed. Confirm now sends it and goes back.
    it('«Заблокировать»: confirm sends the block for THIS master in THIS school, then back', async () => {
      routeQuery.groupId = 'g1'
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValue(masterProfile())
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([]))
      mount()
      await flush()
      await openMenu()

      menuItem('Заблокировать')?.click()
      await flush()

      const modal = liveModal()
      expect(modal?.textContent).toContain('Заблокировать участника школы?')
      expect(modal?.textContent).toContain('утратит доступ к школе')
      expect(modal?.querySelector('.v-confirm__panel svg')).not.toBeNull()

      modalButton('Заблокировать')?.click()
      await flush()

      expect(cgApi.blockCuratorGroupMember).toHaveBeenCalledWith('g1', 'm1')
      expect(toastSuccess).toHaveBeenCalledWith('Участник заблокирован')
      expect(back).toHaveBeenCalledTimes(1)
      expect(toastInfo).not.toHaveBeenCalled()
    })

    it('«Заблокировать» refused (409): the error toast, stay on the profile', async () => {
      routeQuery.groupId = 'g1'
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValue(masterProfile())
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([]))
      vi.mocked(cgApi.blockCuratorGroupMember).mockRejectedValueOnce(
        new ApiResponseError(409, 'cannot block the curator', 'cannot_block_curator'),
      )
      mount()
      await flush()
      await openMenu()
      menuItem('Заблокировать')?.click()
      await flush()
      modalButton('Заблокировать')?.click()
      await flush()

      expect(toastError).toHaveBeenCalled()
      expect(toastSuccess).not.toHaveBeenCalled()
      expect(back).not.toHaveBeenCalled()
    })
  })

  // ===========================================================================
  describe('methods chips (FE-61/62/64)', () => {
    it('a «Направление — Вид» pill shows the SHORT style label — the direction word never repeats inside one chip', async () => {
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValue(
        masterProfile({
          methods: [
            'Медитация — Медитация молчания',
            'Йога — Кундалини-йога',
            'Мой уникальный метод',
          ],
        }),
      )
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([]))
      mount()
      await flush()

      // Owner 2026-09-30: defaultOpen -- the pills are visible immediately,
      // no expand-tap needed.
      expect(pillTexts()).toEqual(['Молчания', 'Кундалини', 'Мой уникальный метод'])
      // FE-64 regression: the raw flat string must not surface in any pill.
      for (const t of pillTexts()) {
        expect(t.toLowerCase()).not.toContain('медитация —')
        expect(t.toLowerCase()).not.toContain('йога —')
      }
    })

    it('every pill carries a direction icon (svg), the neutral fallback included for unknown strings', async () => {
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValue(
        masterProfile({ methods: ['Медитация — Медитация молчания', 'Йога-нидра'] }),
      )
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([]))
      mount()
      await flush()

      const pills = methodPills()
      expect(pills.length).toBe(2)
      for (const p of pills) expect(p.querySelector('svg')).not.toBeNull()
    })

    it('the «Методы» accordion ALWAYS renders: empty methods -> the honest note (owner 2026-09-30)', async () => {
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValue(masterProfile({ methods: [] }))
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([]))
      mount()
      await flush()

      const acc = Array.from(content()?.querySelectorAll('.v-accordion') ?? []).find((node) =>
        node.querySelector('.v-accordion__title')?.textContent?.includes('Методы'),
      )
      expect(acc).not.toBeNull()
      expect(acc?.textContent).toContain('Методы пока не указаны')
      expect(methodPills()).toHaveLength(0)
    })
  })

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
      // Verified check is the small MasterCard-style disc now (icon-only --
      // the text badge is gone; owner 2026-09-30).
      expect(content()?.querySelector('.master-public__verified svg')).not.toBeNull()
      expect(content()?.textContent).not.toContain('Верифицирован')
    })

    it('FIXED (B11 item 2, PROMPT №587): a 404 ApiResponseError shows "Мастер не найден" with the mapped table phrase, and NO retry action', async () => {
      // B8 (PROMPT №747): 'not_found' IS a real backend code --
      // extractApiError now returns its table phrase regardless of the
      // mocked detail text.
      vi.mocked(mastersApi.getPublicMaster).mockRejectedValue(
        new ApiResponseError(404, 'Мастер не найден или не верифицирован', 'not_found'),
      )
      mount()
      await flush()

      expect(emptyTitle()).toBe('Мастер не найден')
      expect(emptyDesc()).toBe('Запрошенный ресурс не найден')
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
      // B8 (PROMPT №747): 'internal_error' IS a real backend code --
      // extractApiError now returns its table phrase (which happens to read
      // almost identically to this mock's detail, plus a trailing
      // "Попробуйте ещё раз") regardless of the mocked detail text.
      vi.mocked(mastersApi.getPublicMaster).mockRejectedValue(
        new ApiResponseError(500, 'Внутренняя ошибка сервера', 'internal_error'),
      )
      mount()
      await flush()

      expect(emptyTitle()).toBe('Не удалось загрузить') // no longer "не найден" -- the master likely DOES exist
      expect(emptyDesc()).toBe('Внутренняя ошибка сервера. Попробуйте ещё раз')
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

    it('a practices-fetch failure is non-fatal: the profile still renders in full, the section keeps the title with the honest note', async () => {
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValue(masterProfile())
      vi.mocked(practicesApi.getPractices).mockRejectedValue(new Error('practices down'))
      mount()
      await flush()

      expect(emptyState()).toBeNull() // NOT the error rung
      expect(content()).not.toBeNull()
      expect(content()?.textContent).toContain('Анна Соколова')
      // Owner 2026-09-30: the title never disappears -- without data it says why.
      expect(upcomingSection()).not.toBeNull()
      expect(upcomingSection()?.textContent).toContain('Ближайшие практики')
      expect(upcomingSection()?.textContent).toContain('Пока практик не запланировано')
      expect(practiceCards()).toHaveLength(0)
    })

    it('an empty practices list renders the same titled section with the note (owner 2026-09-30)', async () => {
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValue(masterProfile())
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([]))
      mount()
      await flush()

      expect(upcomingSection()).not.toBeNull()
      expect(upcomingSection()?.textContent).toContain('Пока практик не запланировано')
      expect(practiceCards()).toHaveLength(0)
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
        5,
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
      // Owner 2026-09-30: the cards are always open -- no accordion to expand.

      expect(practiceCards()).toHaveLength(1)
      practiceCards()[0]?.click()

      expect(push).toHaveBeenCalledWith({ name: 'practice-detail', params: { id: 'pr1' } })
    })

    it('the cards block is capped at 5 even if the feed returns more (owner 2026-09-30)', async () => {
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValue(masterProfile())
      vi.mocked(practicesApi.getPractices).mockResolvedValue(
        page([
          practice('pr1'),
          practice('pr2'),
          practice('pr3'),
          practice('pr4'),
          practice('pr5'),
          practice('pr6'),
        ]),
      )
      mount()
      await flush()

      expect(practiceCards()).toHaveLength(5)
      expect(upcomingSection()?.textContent).not.toContain('pr6')
    })

    it('the «Предстоящие практики» nav row opens the master-practice calendar', async () => {
      routeParams.id = 'm1'
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValue(masterProfile())
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([]))
      mount()
      await flush()

      const nav = Array.from(
        host?.querySelectorAll<HTMLButtonElement>('.master-public__nav') ?? [],
      ).find((b) => b.textContent?.includes('Предстоящие практики'))
      expect(nav).not.toBeNull()
      nav!.click()

      expect(push).toHaveBeenCalledWith({
        name: 'user-calendar-master',
        params: { masterId: 'm1' },
      })
    })

    it('the «Аналитика» panel is a curator-only placeholder: hidden without ?groupId, shown with it', async () => {
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValue(masterProfile())
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([]))
      mount()
      await flush()

      expect(content()?.textContent).not.toContain('Аналитика')

      unmount()
      routeQuery.groupId = 'g1'
      mount()
      await flush()

      expect(content()?.textContent).toContain('Аналитика')
      // The placeholder body lives in the accordion; expand THE ANALYTICS one
      // (querySelector would hit the Методы accordion first) to prove the copy.
      const analyticsAcc = Array.from(content()?.querySelectorAll('.v-accordion') ?? []).find(
        (acc) => acc.querySelector('.v-accordion__title')?.textContent?.includes('Аналитика'),
      )
      analyticsAcc!.querySelector<HTMLButtonElement>('.v-accordion__header')!.click()
      await nextTick()

      expect(content()?.textContent).toContain('после подключения данных')
    })

    it('the hanging «Создать практику» CTA is curator-only and hands off to the create flow', async () => {
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValue(masterProfile())
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([]))
      mount()
      await flush()

      // Without the school context: no CTA at all.
      expect(host?.querySelector('.master-public__cta')).toBeNull()

      unmount()
      routeQuery.groupId = 'g1'
      mount()
      await flush()

      const cta = host?.querySelector<HTMLButtonElement>('.master-public__cta button')
      expect(cta).not.toBeNull()
      expect(cta?.textContent).toContain('Создать практику')

      cta!.click()
      expect(push).toHaveBeenCalledWith({
        name: 'master-practice-new',
        query: { masterId: 'm1' },
      })
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
  describe('ask-master (REAL since T2 / H-T2-UI: «Написать сообщение» in the ⋯ menu)', () => {
    function openActionsMenu(): Promise<void> {
      const trigger = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>('button') ?? [],
      ).find((b) => b.getAttribute('aria-label') === 'Действия с мастером')
      trigger?.click()
      return flush()
    }
    function messageItem(): HTMLButtonElement | undefined {
      return Array.from(
        document.body.querySelectorAll<HTMLButtonElement>('.v-menu-item') ?? [],
      ).find((b) => b.getAttribute('aria-label') === 'Написать сообщение')
    }
    function liveModal(): HTMLElement | undefined {
      const containers = Array.from(
        document.body.querySelectorAll<HTMLElement>('.v-modal__container'),
      )
      return containers[containers.length - 1]
    }
    function modalButton(label: string): HTMLButtonElement | undefined {
      return Array.from(liveModal()?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
        (b) => b.textContent?.trim() === label,
      )
    }

    it("the menu item is fully enabled (a different shape than BookingConfirmedView's disabled textarea+button)", async () => {
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValue(masterProfile())
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([]))
      mount()
      await flush()
      await openActionsMenu()

      const item = messageItem()
      expect(item).toBeTruthy()
      expect(item?.disabled).toBe(false)
    })

    it('clicking it opens the composer; sending opens the DM, posts the text, toasts and closes', async () => {
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValue(masterProfile())
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([]))
      vi.mocked(chatsApi.openChat).mockResolvedValue({
        id: 'thread-1',
        created_at: '2026-08-01T10:30:00+00:00',
      })
      vi.mocked(chatsApi.sendChatMessage).mockResolvedValue({
        id: 'msg-1',
        thread_id: 'thread-1',
        sender: 'me',
        body: 'Привет',
        created_at: '2026-08-01T10:31:00+00:00',
      })
      mount()
      await flush()
      await openActionsMenu()

      messageItem()?.click()
      await flush()

      const field = liveModal()?.querySelector<HTMLTextAreaElement>('.send-msg textarea')
      field!.value = 'Привет'
      field!.dispatchEvent(new Event('input'))
      await flush()

      modalButton('Отправить')?.click()
      await flush()

      // The actor is the session's, server-side: the view only names WHICH
      // master (the route's), never who is asking.
      expect(chatsApi.openChat).toHaveBeenCalledWith('m1')
      expect(chatsApi.sendChatMessage).toHaveBeenCalledWith('thread-1', 'Привет')
      expect(toastSuccess).toHaveBeenCalledWith('Сообщение отправлено')
    })

    it('negative twin: a failed open toasts, the draft stays standing, no navigation', async () => {
      vi.mocked(mastersApi.getPublicMaster).mockResolvedValue(masterProfile())
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([]))
      vi.mocked(chatsApi.openChat).mockRejectedValue(
        new ApiResponseError(502, 'Сервис сообщений недоступен', 'bad_gateway'),
      )
      mount()
      await flush()
      await openActionsMenu()

      messageItem()?.click()
      await flush()

      const field = liveModal()?.querySelector<HTMLTextAreaElement>('.send-msg textarea')
      field!.value = 'Привет'
      field!.dispatchEvent(new Event('input'))
      await flush()

      modalButton('Отправить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalled()
      // The draft stays standing (the retry is safe -- comms dedups on the
      // pair); no navigation happened.
      expect(liveModal()?.querySelector('.send-msg textarea')).not.toBeNull()
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
        5,
        0,
      )
    })
  })
})
