// =============================================================================
// VELO Frontend -- MasterPracticeDetailView Screen Tests
// =============================================================================
//
// The master's «…» menu fires the two actions on this screen that CANNOT be
// walked back: cancelPractice (POST /practices/{id}/cancel -- the backend
// refunds every confirmed booking atomically; there is no un-refund endpoint)
// and deletePractice (DELETE -- soft-delete to status=deleted, no inverse
// wired to the client). Everything a bug here costs is somebody else's money or
// somebody else's practice, so the assertions that earn their keep are:
//
//   1. WHICH endpoint the destructive item hits. openDestructive branches on
//      isDraft ALONE (.vue:533-536): a draft deletes, anything else cancels.
//      Invert that branch and either a real scheduled practice is soft-deleted
//      with its participants still holding paid bookings, or a never-published
//      draft runs a refund sweep over bookings that do not exist. Both are
//      asserted in BOTH directions (the endpoint that must fire, and the one
//      that must NOT).
//   2. WITH WHAT ARGS. cancelPractice's `scope` decides whether the refund
//      stops at this occurrence or walks the whole series (.vue:538-552).
//      'this_and_future' reached by accident is a mass refund.
//   3. THAT THE MENU IS NOT THERE AT ALL on a finished practice -- isUpcoming
//      gates it (.vue:44). A completed practice's money is already settled.
//
// PATTERN: B (local-ref) with a store-DEPENDENCY layer. Called out because it
// reads like Pattern A and is not: practice / attendance / loading / error are
// this screen's OWN refs (.vue:356-359), filled by direct @/api/practices calls
// in load() (.vue:571-593). That module is the seam, auto-mocked. The two Pinia
// stores are not where the state lives -- masterStore contributes a warm CACHE
// to read through (.vue:575) plus refreshMyPractices() as a post-mutation
// side-effect, and diaryStore contributes the insights CACHE the PAST hero
// badges read. Both are dependencies, so both are mocked wholesale behind
// getters over mutable objects (velo-idiom §5). Mocking the API seam alone
// would leave the cache-hit branch unreachable; mocking the stores alone would
// leave every ladder rung unreachable.
//
// insightsCache is mocked as a REAL reactive(new Map()) and the loadInsights
// mock WRITES to it, mirroring the store (stores/diary.ts:363-380). The screen
// grabs the map once at setup and derives `insights` from it (.vue:371-372), so
// a plain Map would render the badges only if pre-seeded and would never prove
// the reactive read. The write path is the thing under test.
//
// TIME IS PINNED (vi.setSystemTime). whenLabel -> formatDateShort compares the
// practice against `new Date()` to emit «Сегодня»/«Завтра» (utils/format.ts:
// 65-85). Unpinned, the hero's date line is a different string every day and
// the «Завтра» test below would be green only on 2026-07-21. Fixtures are
// literals relative to the frozen instant.
//
// SC-13 -- THE OVERLAY REAP IS MANDATORY HERE. Both confirm dialogs
// (CancelPracticeDialog, VConfirmDialog) render through VModal, which is
// `Teleport to="body"` inside a <Transition> (VModal.vue:20-22). A CLOSED
// overlay is held by Vue pending a transitionend happy-dom never fires, and
// app.unmount() does not reap it -- it stays parked on document.body. The next
// test then finds the DEAD overlay first in document order and clicks a handler
// belonging to an unmounted app: the first dialog test passes, every later one
// fails, and the screen is innocent. afterEach purges .v-modal__overlay.
//
// No money is FORMATTED on this screen -- the «Цена» stat card was removed
// (operator 2026-06-18) and formatMoney is not imported, so the ru NBSP trap
// (velo-idiom §11) does not bite. text() normalises the three space variants
// anyway: Intl emits U+00A0 from the date/time formatters on some ICU builds,
// and the cost of the guard is nothing.
//
// No order dependence: every test mounts its own app and beforeEach resets all
// fixtures and mocks. Declaration order is execution order (no shuffle), but
// nothing here relies on it.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, reactive, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import MasterPracticeDetailView from '@/views/master/MasterPracticeDetailView.vue'
import * as practicesApi from '@/api/practices'
import { ApiResponseError } from '@/api/client'
import type {
  PracticeResponse,
  AttendanceResponse,
  AttendanceItemResponse,
  PracticeInsightsResponse,
  ReviewItem,
} from '@/api/types'

// The wrapper seam this screen imports (.vue:304-310). Auto-mocked: nothing in
// this module needs preserving -- ApiResponseError lives in @/api/client, which
// stays REAL so the error-detail branch is tested against the real class.
vi.mock('@/api/practices')

const push = vi.fn()
const back = vi.fn()
const routeParams: { id: string } = { id: 'p1' }
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back }),
  useRoute: () => ({ params: routeParams }),
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: vi.fn() }),
}))

// -- master store (dependency): the warm cache + the post-mutation refresh --
const masterState: { practices: PracticeResponse[] } = { practices: [] }
const refreshMyPractices = vi.fn()
vi.mock('@/stores/master', () => ({
  useMasterStore: () => ({
    get practices() {
      return masterState.practices
    },
    refreshMyPractices,
  }),
}))

// -- diary store (dependency): the insights cache the PAST hero badges read --
// A real reactive Map, exactly as the store holds it (stores/diary.ts:352). The
// screen captures it by reference at setup, so the mock must return the SAME
// object every call -- a fresh Map per useDiaryStore() would hand the screen a
// map nobody writes to.
const insightsCache = reactive(new Map<string, PracticeInsightsResponse>())
const loadInsights = vi.fn()
vi.mock('@/stores/diary', () => ({
  useDiaryStore: () => ({
    insightsCache,
    loadInsights,
  }),
}))

const NOW = new Date('2026-07-20T12:00:00Z')

function practice(overrides: Partial<PracticeResponse> = {}): PracticeResponse {
  return {
    id: 'p1',
    master_id: 'master_1',
    master_name: 'Мастер',
    practice_type: 'live',
    status: 'scheduled',
    title: 'Утренняя практика',
    description: null,
    what_to_prepare: null,
    contraindications: null,
    // Two days out: neither «Сегодня» nor «Завтра», so whenLabel is the stable
    // «22 июля, 10:00» that the content assertions read.
    scheduled_at: '2026-07-22T10:00:00Z',
    duration_minutes: 60,
    timezone: 'UTC',
    max_participants: 10,
    current_participants: 3,
    parent_practice_id: null,
    is_free: false,
    price_cents: 2500,
    currency: 'EUR',
    direction: 'yoga',
    style: null,
    difficulty: null,
    recurrence_days: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: null,
    ...overrides,
  } as PracticeResponse
}

function rosterItem(
  n: number,
  overrides: Partial<AttendanceItemResponse> = {},
): AttendanceItemResponse {
  return {
    booking_id: `b${n}`,
    user_id: `user_${n}0000000`,
    status: 'confirmed',
    joined_at: null,
    left_at: null,
    user_display_name: `Участник ${n}`,
    user_avatar_url: null,
    checkin: null,
    ...overrides,
  }
}

function attendance(overrides: Partial<AttendanceResponse> = {}): AttendanceResponse {
  return {
    practice_id: 'p1',
    total: 3,
    attended: 0,
    no_show: 0,
    pending: 3,
    items: [rosterItem(1), rosterItem(2), rosterItem(3)],
    ...overrides,
  }
}

function insights(fire: number, good: number, confused: number): PracticeInsightsResponse {
  return {
    practice_id: 'p1',
    participants: fire + good + confused,
    checkins: { high: 0, mid: 0, low: 0 },
    feedbacks: { fire, good, confused },
    comments_count: 0,
  }
}

function review(n: number, overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    user_id: `user_${n}`,
    reviewer_name: `Рецензент ${n}`,
    avatar_url: null,
    rating: 'fire',
    comment: null,
    created_at: '2026-07-19T10:00:00Z',
    ...overrides,
  }
}

function reviewsPage(items: ReviewItem[], total = items.length) {
  return { items, total, limit: 20, offset: 0 }
}

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia
// T24-38 (PROMPT №643): navigator.clipboard does not exist in happy-dom --
// defined per test, same pattern as MasterGroupDetailView.test.ts's
// writeText mock.
let writeText: ReturnType<typeof vi.fn>

// A real Pinia is installed even though BOTH stores this screen reads are
// module-mocked above. No child of this screen resolves a store today, but
// children are not stubbed (velo-idiom §2) and one that grows a store would
// otherwise kill the mount with "getActivePinia() was called but there was no
// active Pinia" -- a failure with nothing to do with the change that caused it.
// The mocked stores never reach Pinia, so the two coexist. ONE instance is
// handed to both setActivePinia and app.use (SC-03: two instances = the test
// mutates one store while the component renders another, and everything passes
// while proving nothing).
function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(MasterPracticeDetailView)
  app.use(pinia)
  app.mount(host)
  return host
}

// COUNTED, not copied (velo-idiom §3, SC-08). load() (.vue:571-593) spends:
// (1) await getPractice -> (2,3) await Promise.all over getAttendance +
// loadInsights (Promise.all costs a tick of its own beyond its members) ->
// (4) the fire-and-forget `void loadReviews()` awaits getPracticeReviews ->
// (5) reviewsLoading flips false -> (6) the final re-render. That is six on the
// PAST branch, the deepest one. Ten, because over-counting is free and this
// chain grows the moment anything else is added to that Promise.all.
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await nextTick()
}

// Intl groups with U+00A0 / U+202F / U+2009 depending on the Node/ICU build.
// Written as ESCAPES, never as literal characters: a literal NBSP is invisible
// in a diff and the next editor "tidies" it into a plain space without ever
// seeing what they broke.
function norm(s: string | null | undefined): string {
  return (s ?? '').replace(/[\u00A0\u202F\u2009]/g, ' ')
}

function text(): string {
  return norm(host?.textContent)
}

function byAria(label: string): HTMLButtonElement | null {
  return host?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? null
}

/** Open the «…» menu and hit the destructive (trash) item. */
async function openDestructive(): Promise<void> {
  const kebab = byAria('Меню')
  if (!kebab) throw new Error('the «…» menu is not rendered')
  kebab.click()
  await flush()

  const item = byAria('Удалить') ?? byAria('Отменить практику')
  if (!item) throw new Error('the destructive menu item is not rendered')
  item.click()
  await flush()
}

/**
 * A button inside the teleported dialog. Queried from document.body, NOT from
 * the mount root (SC-07: VModal teleports, so host.querySelector finds nothing
 * and the test would conclude the dialog never opened). Matched on the EXACT
 * trimmed label -- «Не отменять» and «Отменить» share a stem and a
 * `includes()` match would eventually pick the wrong one.
 */
function dialogButton(label: string): HTMLButtonElement | undefined {
  return Array.from(
    document.body.querySelectorAll<HTMLButtonElement>('.v-modal__overlay button'),
  ).find((b) => b.textContent?.trim() === label)
}

function dialogText(): string {
  return norm(document.body.querySelector('.v-modal__overlay')?.textContent)
}

/**
 * Whether the screen DISMISSED the dialog (showCancel/showDelete -> false).
 *
 * Deliberately not `querySelector('.v-modal__overlay') === null`: that is the
 * obvious assertion and it FAILS while the product is correct. VModal's overlay
 * is `v-if="open"` inside a <Transition>, so flipping `open` to false starts a
 * LEAVE that Vue completes on a transitionend -- which happy-dom never fires.
 * The node therefore lingers, stamped `v-modal-leave-active`, forever. (This is
 * SC-13's mechanism seen from the other side: the same stuck leave that makes
 * the afterEach purge mandatory also makes "is it gone?" unanswerable here.)
 *
 * So the observable is the leave STARTING, which is a real product state
 * change: an overlay that is absent, or present-and-leaving, is dismissed; one
 * sitting there with no leave class is not.
 */
function dialogDismissed(): boolean {
  const overlay = document.body.querySelector('.v-modal__overlay')
  return overlay === null || overlay.classList.contains('v-modal-leave-active')
}

beforeEach(() => {
  vi.setSystemTime(NOW)
  pinia = createPinia()
  setActivePinia(pinia)

  routeParams.id = 'p1'
  masterState.practices = []
  insightsCache.clear()

  vi.mocked(practicesApi.getPractice).mockReset().mockResolvedValue(practice())
  vi.mocked(practicesApi.getAttendance).mockReset().mockResolvedValue(attendance())
  vi.mocked(practicesApi.getPracticeReviews).mockReset().mockResolvedValue(reviewsPage([]))
  vi.mocked(practicesApi.cancelPractice)
    .mockReset()
    .mockResolvedValue(practice({ status: 'cancelled' }))
  vi.mocked(practicesApi.deletePractice).mockReset().mockResolvedValue(undefined)

  // Mirrors the real store (stores/diary.ts:363-380): fills the reactive cache
  // the screen reads. Tests that want badges seed `insightsFixture` first.
  loadInsights.mockReset().mockImplementation(async (id: string) => {
    if (insightsFixture) insightsCache.set(id, insightsFixture)
  })
  refreshMyPractices.mockReset().mockResolvedValue(undefined)

  push.mockReset()
  back.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
  insightsFixture = null

  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    writable: true,
    value: { writeText },
  })
})

// T-35: the view's local PracticeWithSharedLink extension is gone -- the
// field it stood in for is native on PracticeResponse after the T-35 regen,
// and it is OUR link now (zoom_public_link), never a raw Zoom URL.
function withPublicLink(p: PracticeResponse, url: string | null): PracticeResponse {
  return { ...p, zoom_public_link: url }
}

let insightsFixture: PracticeInsightsResponse | null = null

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null

  // SC-13. A CLOSED teleported overlay outlives app.unmount(): VModal wraps it
  // in a <Transition> (VModal.vue:21-22) and Vue holds the leaving element
  // pending a transitionend happy-dom never fires. Left behind, it is found
  // FIRST in document order by the next test, which then clicks a dead node
  // owned by an unmounted app -- the first dialog test passes and every later
  // one fails while the screen is perfectly healthy. Unconditional and
  // idempotent: cheap when unnecessary, load-bearing when not.
  document.body.querySelectorAll('.v-modal__overlay').forEach((el) => el.remove())
  document.body.querySelectorAll('.v-sheet__overlay').forEach((el) => el.remove())

  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('MasterPracticeDetailView', () => {
  describe('state ladder', () => {
    it('shows the loader while the practice is in flight', async () => {
      vi.mocked(practicesApi.getPractice).mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(host?.querySelector('.practice-detail__loader')).not.toBeNull()
      expect(host?.querySelector('.hero-card')).toBeNull()
    })

    it('error: surfaces the REAL backend detail, not a hardcoded fallback', async () => {
      // .vue:589 keeps e.detail when it is an ApiResponseError, and :description
      // binds it (.vue:83). The detail is what tells the master WHY.
      vi.mocked(practicesApi.getPractice).mockRejectedValue(
        new ApiResponseError(404, 'Практика не найдена или удалена', 'practice_not_found'),
      )
      mount()
      await flush()

      expect(text()).toContain('Не удалось загрузить практику')
      expect(text()).toContain('Практика не найдена или удалена')
    })

    it('error: falls back to a generic message on a non-API error', async () => {
      vi.mocked(practicesApi.getPractice).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()

      expect(text()).toContain('Ошибка загрузки')
    })

    it('a failing ATTENDANCE call errors the whole screen -- it is inside the try', async () => {
      // getAttendance sits in load()'s try (.vue:580-584), unlike loadReviews
      // which is deliberately non-fatal. Roster and stats are the point of this
      // screen, so a half-rendered hero would be worse than the error state.
      vi.mocked(practicesApi.getAttendance).mockRejectedValue(
        new ApiResponseError(500, 'Список участников недоступен', 'server_error'),
      )
      mount()
      await flush()

      expect(text()).toContain('Список участников недоступен')
      expect(host?.querySelector('.hero-card')).toBeNull()
    })

    it('«Повторить» re-runs the load and recovers', async () => {
      vi.mocked(practicesApi.getPractice)
        .mockRejectedValueOnce(new ApiResponseError(503, 'Сервис недоступен', 'unavailable'))
        .mockResolvedValue(practice({ title: 'Вечерняя йога' }))
      mount()
      await flush()
      expect(text()).toContain('Сервис недоступен')

      const retry = Array.from(host?.querySelectorAll('button') ?? []).find(
        (b) => b.textContent?.trim() === 'Повторить',
      )
      expect(retry).toBeDefined()
      retry?.click()
      await flush()

      expect(text()).toContain('Вечерняя йога')
      expect(text()).not.toContain('Сервис недоступен')
    })

    it('content: renders the practice the API actually returned', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({ title: 'Вечерняя йога', duration_minutes: 90 }),
      )
      mount()
      await flush()

      expect(text()).toContain('Вечерняя йога')
      expect(text()).toContain('90 мин')
      // formatDateShort + formatTime against the practice's own timezone.
      expect(text()).toContain('22 июля, 10:00')
    })

    it("fetches this route's practice, not a hardcoded one", async () => {
      routeParams.id = 'p42'
      mount()
      await flush()

      expect(practicesApi.getPractice).toHaveBeenCalledWith('p42')
      expect(practicesApi.getAttendance).toHaveBeenCalledWith('p42')
    })
  })

  describe('the master-store cache read (.vue:575)', () => {
    it('reads a warm cached practice INSTEAD of refetching it', async () => {
      masterState.practices = [practice({ id: 'p1', title: 'Из кэша' })]
      mount()
      await flush()

      expect(text()).toContain('Из кэша')
      expect(practicesApi.getPractice).not.toHaveBeenCalled()
      // Attendance is never cached -- it must still be fetched.
      expect(practicesApi.getAttendance).toHaveBeenCalledWith('p1')
    })

    it('falls through to the API when the cache holds a DIFFERENT practice', async () => {
      // .find() keys on id. A cache hit that ignored the id would render some
      // other master's practice under this route.
      masterState.practices = [practice({ id: 'p_other', title: 'Чужая практика' })]
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ title: 'Настоящая' }))
      mount()
      await flush()

      expect(text()).toContain('Настоящая')
      expect(text()).not.toContain('Чужая практика')
      expect(practicesApi.getPractice).toHaveBeenCalledWith('p1')
    })
  })

  describe('the status branch (isPast / isUpcoming, .vue:362-367)', () => {
    it.each(['draft', 'scheduled', 'live'] as const)(
      '%s renders the UPCOMING hub: «Практика» + the «…» menu',
      async (status) => {
        vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status }))
        mount()
        await flush()

        expect(text()).toContain('Практика')
        expect(text()).not.toContain('Прошедшая практика')
        expect(byAria('Меню')).not.toBeNull()
        expect(text()).toContain('Записалось')
      },
    )

    it.each(['completed', 'cancelled'] as const)(
      '%s renders the PAST read-only detail and NO «…» menu',
      async (status) => {
        // The menu is the only way to reach cancel/delete. A finished or
        // already-cancelled practice has settled money behind it -- offering
        // either action would be a refund sweep the backend rejects, or worse,
        // does not.
        vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status }))
        mount()
        await flush()

        expect(text()).toContain('Прошедшая практика')
        expect(byAria('Меню')).toBeNull()
        expect(text()).toContain('Присутствовало')
        expect(text()).toContain('Не пришли')
      },
    )

    it('the destructive item reads «Удалить» for a draft and «Отменить практику» otherwise', async () => {
      // destructiveLabel (.vue:368) is the ONLY thing telling the master which
      // irreversible action the trash glyph is about to run.
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status: 'draft' }))
      mount()
      await flush()
      byAria('Меню')?.click()
      await flush()
      expect(byAria('Удалить')).not.toBeNull()
      expect(byAria('Отменить практику')).toBeNull()

      app?.unmount()
      host?.remove()

      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status: 'scheduled' }))
      mount()
      await flush()
      byAria('Меню')?.click()
      await flush()
      expect(byAria('Отменить практику')).not.toBeNull()
      expect(byAria('Удалить')).toBeNull()
    })
  })

  describe('upcoming hub: stat cards', () => {
    it('«Записалось» shows the attendance total the API returned', async () => {
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(attendance({ total: 7 }))
      mount()
      await flush()

      const values = Array.from(host?.querySelectorAll('.v-stat') ?? []).map((c) =>
        norm(c.textContent),
      )
      expect(values.find((v) => v.includes('Записалось'))).toContain('7')
    })

    it('«Мест» shows the cap, and ∞ when the practice is UNCAPPED', async () => {
      // capacityStat (.vue:413-416): max_participants null = no limit. Rendering
      // a bare null (or 0) would read as a full practice.
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ max_participants: null }))
      mount()
      await flush()

      const seats = Array.from(host?.querySelectorAll('.v-stat') ?? []).find((c) =>
        c.textContent?.includes('Мест'),
      )
      expect(norm(seats?.textContent)).toContain('∞')
    })

    it('«Мест» shows the real cap when one is set', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ max_participants: 12 }))
      mount()
      await flush()

      const seats = Array.from(host?.querySelectorAll('.v-stat') ?? []).find((c) =>
        c.textContent?.includes('Мест'),
      )
      expect(norm(seats?.textContent)).toContain('12')
    })
  })

  // T-35: the master copies OUR link, never Zoom's. THE RISK THIS PINS is
  // not "wrong value" but "the raw Zoom URL comes back": handing a master a
  // guest link to paste into a channel is what produced NO_SHOW for booked
  // students who clicked it, so the assertion below is on the exact string
  // reaching the clipboard. Plus the two states around it -- absent when the
  // server sent no link, and an honest toast when the clipboard refuses.
  describe('upcoming hub: T-35 public practice link', () => {
    it('is ABSENT when the server sent no public link (a non-owner response, or a practice that has none)', async () => {
      mount()
      await flush()

      expect(host?.querySelector('.pd-shared-link')).toBeNull()
      expect(text()).not.toContain('Ссылка на практику')
    })

    it('RENDERS the label and Копировать button when the server sent our link', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        withPublicLink(practice(), 'https://velo.link/z/EREREStERERM0RETURVVVQ'),
      )
      mount()
      await flush()

      expect(host?.querySelector('.pd-shared-link')).not.toBeNull()
      expect(text()).toContain('Ссылка на практику')
      const copyBtn = Array.from(host?.querySelectorAll<HTMLElement>('button') ?? []).find(
        (b) => b.textContent?.trim() === 'Копировать',
      )
      expect(copyBtn).toBeDefined()
    })

    it('copying writes OUR link to the clipboard -- never a zoom.us URL, which is the whole point of the wrapper', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        withPublicLink(practice(), 'https://velo.link/z/EREREStERERM0RETURVVVQ'),
      )
      mount()
      await flush()

      const copyBtn = Array.from(host?.querySelectorAll<HTMLElement>('button') ?? []).find(
        (b) => b.textContent?.trim() === 'Копировать',
      )
      copyBtn?.click()
      await flush()

      expect(writeText).toHaveBeenCalledWith('https://velo.link/z/EREREStERERM0RETURVVVQ')
      expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining('zoom.us'))
      expect(toastSuccess).toHaveBeenCalledWith('Ссылка скопирована')
      expect(toastError).not.toHaveBeenCalled()
    })

    it('a REJECTED clipboard write surfaces the error toast, not a silent no-op', async () => {
      writeText.mockRejectedValue(new Error('clipboard denied'))
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        withPublicLink(practice(), 'https://velo.link/z/EREREStERERM0RETURVVVQ'),
      )
      mount()
      await flush()

      const copyBtn = Array.from(host?.querySelectorAll<HTMLElement>('button') ?? []).find(
        (b) => b.textContent?.trim() === 'Копировать',
      )
      copyBtn?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось скопировать ссылку')
      expect(toastSuccess).not.toHaveBeenCalled()
    })
  })

  describe('upcoming hub: the roster (Записались)', () => {
    it('renders the display names the API returned', async () => {
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(
        attendance({ items: [rosterItem(1, { user_display_name: 'Анна Петрова' })] }),
      )
      mount()
      await flush()

      expect(text()).toContain('Записались')
      expect(text()).toContain('Анна Петрова')
    })

    it('falls back to a short user id when the participant has no name', async () => {
      // displayName (.vue:429-431). A blank row would be a participant the
      // master cannot identify at the door.
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(
        attendance({
          items: [rosterItem(1, { user_display_name: null, user_id: 'abcdef1234567890' })],
        }),
      )
      mount()
      await flush()

      expect(text()).toContain('#abcdef12')
    })

    it('the section is HIDDEN entirely when nobody is enrolled', async () => {
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(attendance({ total: 0, items: [] }))
      mount()
      await flush()

      expect(text()).not.toContain('Записались')
      expect(host?.querySelectorAll('.pd-prow')).toHaveLength(0)
    })

    it('caps the preview at 5 and offers «+ ещё N участников» for the rest', async () => {
      const items = Array.from({ length: 8 }, (_, i) => rosterItem(i + 1))
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(attendance({ total: 8, items }))
      mount()
      await flush()

      expect(host?.querySelectorAll('.pd-prow')).toHaveLength(5)
      expect(text()).toContain('+ ещё 3 участников')
      expect(text()).toContain('Участник 5')
      expect(text()).not.toContain('Участник 6')
    })

    it('expanding reveals every participant and retires the pill', async () => {
      const items = Array.from({ length: 8 }, (_, i) => rosterItem(i + 1))
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(attendance({ total: 8, items }))
      mount()
      await flush()

      host?.querySelector<HTMLButtonElement>('.v-show-more')?.click()
      await flush()

      expect(host?.querySelectorAll('.pd-prow')).toHaveLength(8)
      expect(text()).toContain('Участник 8')
      expect(host?.querySelector('.v-show-more')).toBeNull()
    })

    it('exactly 5 participants shows no pill -- the boundary is not off by one', async () => {
      const items = Array.from({ length: 5 }, (_, i) => rosterItem(i + 1))
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(attendance({ total: 5, items }))
      mount()
      await flush()

      expect(host?.querySelectorAll('.pd-prow')).toHaveLength(5)
      expect(host?.querySelector('.v-show-more')).toBeNull()
    })

    it('a BROKEN avatar falls back to initials instead of a dead glyph', async () => {
      // .vue:437-442 (2026-07-14): this roster paints <img> directly rather than
      // going through VAvatar, so it carries its own broken-image guard. The
      // t.me userpic host was pulled at the registry level, so this is the
      // common case, not the edge.
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(
        attendance({
          items: [
            rosterItem(1, {
              user_display_name: 'Анна Петрова',
              user_avatar_url: 'https://t.me/i/userpic/dead.jpg',
            }),
          ],
        }),
      )
      mount()
      await flush()

      const img = host?.querySelector<HTMLImageElement>('.pd-prow__ava-img')
      expect(img).not.toBeNull()

      img?.dispatchEvent(new Event('error'))
      await flush()

      expect(host?.querySelector('.pd-prow__ava-img')).toBeNull()
      expect(norm(host?.querySelector('.pd-prow__ava')?.textContent).trim()).toBe('А')
    })

    it('one broken avatar does NOT blank out the others -- the guard is keyed by booking', async () => {
      // brokenAvatars is a Set keyed on booking_id (.vue:442). A boolean flag
      // would take the whole roster down with one dead image.
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(
        attendance({
          items: [
            rosterItem(1, { user_avatar_url: 'https://t.me/dead.jpg' }),
            rosterItem(2, { user_avatar_url: 'https://t.me/alive.jpg' }),
          ],
        }),
      )
      mount()
      await flush()

      expect(host?.querySelectorAll('.pd-prow__ava-img')).toHaveLength(2)
      host
        ?.querySelectorAll<HTMLImageElement>('.pd-prow__ava-img')[0]
        ?.dispatchEvent(new Event('error'))
      await flush()

      expect(host?.querySelectorAll('.pd-prow__ava-img')).toHaveLength(1)
    })
  })

  describe('upcoming hub: hero meta', () => {
    it('«Завтра» is relative to the FROZEN clock, not to whenever this runs', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({ scheduled_at: '2026-07-21T08:30:00Z' }),
      )
      mount()
      await flush()

      expect(text()).toContain('Завтра, 08:30')
    })

    it("renders the practice's OWN timezone, not the runner's", async () => {
      // whenLabel passes practice.timezone into both formatters (.vue:375-380).
      // 10:00 UTC is 13:00 in Moscow; a master in Lisbon must still see the time
      // their Moscow practice actually starts at.
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({ scheduled_at: '2026-07-22T10:00:00Z', timezone: 'Europe/Moscow' }),
      )
      mount()
      await flush()

      expect(text()).toContain('13:00')
    })

    it.each([
      ['beginner', 1],
      ['medium', 2],
      ['high', 3],
    ] as const)('difficulty %s fills %i dot(s)', async (difficulty, expected) => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ difficulty }))
      mount()
      await flush()

      expect(host?.querySelectorAll('.hero-card__difficulty-dot--on')).toHaveLength(expected)
    })

    it('no difficulty hides the block entirely (0 dots, not 3 empty ones)', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ difficulty: null }))
      mount()
      await flush()

      expect(host?.querySelector('.hero-card__difficulty')).toBeNull()
    })

    it('a SERIES shows its recurrence days', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({ practice_type: 'series', recurrence_days: [1, 3, 5] }),
      )
      mount()
      await flush()

      expect(text()).toContain('Пн, Ср, Пт')
    })

    it('a SERIES with no day list falls back to «Регулярная»', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({ practice_type: 'series', recurrence_days: [] }),
      )
      mount()
      await flush()

      expect(text()).toContain('Регулярная')
    })

    it('a NON-series hides the chip -- recurrenceLabel is null (FORK2)', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({ practice_type: 'live', recurrence_days: [1, 3, 5] }),
      )
      mount()
      await flush()

      // recurrence_days is deliberately POPULATED here: the gate is
      // practice_type, not the day list (.vue:389-392). Anchored on the hero
      // rendering so "no chip" cannot pass against a blank screen.
      expect(text()).toContain('Утренняя практика')
      expect(text()).not.toContain('Пн, Ср, Пт')
      expect(text()).not.toContain('Регулярная')
    })
  })

  describe('upcoming hub: the accordions', () => {
    it('renders the text and opens all three by default (operator PD-C1)', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({
          description: 'Мягкая утренняя разминка',
          contraindications: 'Травмы спины',
          what_to_prepare: 'Коврик и плед',
        }),
      )
      mount()
      await flush()

      expect(host?.querySelectorAll('.pd-acc--open')).toHaveLength(3)
      expect(text()).toContain('Мягкая утренняя разминка')
      expect(text()).toContain('Травмы спины')
      expect(text()).toContain('Коврик и плед')
    })

    it('collapsing one hides its body and leaves the others open', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({ description: 'Мягкая разминка', contraindications: 'Травмы спины' }),
      )
      mount()
      await flush()

      host?.querySelector<HTMLButtonElement>('.pd-acc__hd')?.click()
      await flush()

      expect(text()).not.toContain('Мягкая разминка')
      expect(text()).toContain('Травмы спины')
      expect(host?.querySelector('.pd-acc__hd')?.getAttribute('aria-expanded')).toBe('false')
    })

    it('the whole section is gone when the practice carries none of the three', async () => {
      mount()
      await flush()

      expect(host?.querySelector('.pd-acc')).toBeNull()
      expect(text()).not.toContain('Описание')
    })

    it('only the fields that exist get a card', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({ description: 'Только описание' }),
      )
      mount()
      await flush()

      expect(host?.querySelectorAll('.pd-acc')).toHaveLength(1)
      expect(text()).toContain('Описание')
      expect(text()).not.toContain('Противопоказания')
    })
  })

  describe('past detail: stats and rating badges', () => {
    it('renders attended / no_show from the attendance the API returned', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status: 'completed' }))
      vi.mocked(practicesApi.getAttendance).mockResolvedValue(
        attendance({ total: 10, attended: 7, no_show: 3, items: [] }),
      )
      mount()
      await flush()

      const cards = Array.from(host?.querySelectorAll('.v-stat') ?? []).map((c) =>
        norm(c.textContent),
      )
      expect(cards.find((c) => c.includes('Присутствовало'))).toContain('7')
      expect(cards.find((c) => c.includes('Не пришли'))).toContain('3')
    })

    it('loads insights for the PAST branch and renders the distribution as PERCENTAGES', async () => {
      // ratingPct (.vue:450-455) turns raw counts into percents. 6/3/1 of 10 ->
      // 60/30/10. Rendering the raw counts as "%" would be a silent lie about
      // how the practice landed.
      insightsFixture = insights(6, 3, 1)
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status: 'completed' }))
      mount()
      await flush()

      expect(loadInsights).toHaveBeenCalledWith('p1')
      const badges = norm(host?.querySelector('.v-rating-badges')?.textContent)
      expect(badges).toContain('60%')
      expect(badges).toContain('30%')
      expect(badges).toContain('10%')
    })

    it('rounds rather than truncates (1/3 -> 33/33/33)', async () => {
      insightsFixture = insights(1, 1, 1)
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status: 'completed' }))
      mount()
      await flush()

      expect(norm(host?.querySelector('.v-rating-badges')?.textContent)).toContain('33%')
    })

    it('ZERO feedbacks hides the badges -- it does not render 0/0/0', async () => {
      // hasRating gates on totalFeedbacks > 0 (.vue:449). 0/0/0 would read as a
      // practice everyone hated rather than one nobody rated.
      insightsFixture = insights(0, 0, 0)
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status: 'completed' }))
      mount()
      await flush()

      expect(host?.querySelector('.v-rating-badges')).toBeNull()
    })

    it('no insights at all hides the badges', async () => {
      insightsFixture = null
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status: 'completed' }))
      mount()
      await flush()

      expect(host?.querySelector('.v-rating-badges')).toBeNull()
    })

    it('does NOT load insights or reviews for an UPCOMING practice', async () => {
      // .vue:580-587 gates both on isPast. An upcoming practice has no feedback
      // and no reviews; fetching them is two dead round-trips per open.
      mount()
      await flush()

      expect(loadInsights).not.toHaveBeenCalled()
      expect(practicesApi.getPracticeReviews).not.toHaveBeenCalled()
    })
  })

  describe('past detail: named reviews', () => {
    it('renders reviewer names and comments from the API', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status: 'completed' }))
      vi.mocked(practicesApi.getPracticeReviews).mockResolvedValue(
        reviewsPage([review(1, { reviewer_name: 'Анна', comment: 'Очень мягко' })]),
      )
      mount()
      await flush()

      expect(text()).toContain('Анна')
      expect(text()).toContain('«Очень мягко»')
    })

    it('asks for the first page: limit 20, offset 0', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status: 'completed' }))
      mount()
      await flush()

      expect(practicesApi.getPracticeReviews).toHaveBeenCalledWith('p1', 20, 0)
    })

    it('shows the empty note when the practice has no reviews', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status: 'completed' }))
      vi.mocked(practicesApi.getPracticeReviews).mockResolvedValue(reviewsPage([]))
      mount()
      await flush()

      expect(text()).toContain('Отзывов пока нет')
    })

    it('a FAILING reviews call is non-fatal -- the rest of the screen survives', async () => {
      // loadReviews swallows (.vue:495-497) and is fired with `void` outside the
      // Promise.all. The detail must stay usable.
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({ status: 'completed', title: 'Прошедшая йога' }),
      )
      vi.mocked(practicesApi.getPracticeReviews).mockRejectedValue(
        new ApiResponseError(500, 'reviews down', 'server_error'),
      )
      mount()
      await flush()

      expect(text()).toContain('Прошедшая йога')
      expect(text()).toContain('Присутствовало')
      expect(text()).toContain('Отзывов пока нет')
      expect(text()).not.toContain('Не удалось загрузить практику')
    })

    it('caps the preview at 10 and offers «посмотреть еще»', async () => {
      const items = Array.from({ length: 15 }, (_, i) => review(i + 1))
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status: 'completed' }))
      vi.mocked(practicesApi.getPracticeReviews).mockResolvedValue(reviewsPage(items, 15))
      mount()
      await flush()

      expect(host?.querySelectorAll('.practice-detail__review')).toHaveLength(10)
      expect(text()).toContain('посмотреть еще')
    })

    it('expanding a fully-loaded page reveals the rest without another call', async () => {
      const items = Array.from({ length: 15 }, (_, i) => review(i + 1))
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status: 'completed' }))
      vi.mocked(practicesApi.getPracticeReviews).mockResolvedValue(reviewsPage(items, 15))
      mount()
      await flush()

      host?.querySelector<HTMLButtonElement>('.v-show-more')?.click()
      await flush()

      expect(host?.querySelectorAll('.practice-detail__review')).toHaveLength(15)
      // hasMoreReviews is false (15 loaded of 15) -> expandReviews must not
      // fetch a page that does not exist (.vue:479-482).
      expect(practicesApi.getPracticeReviews).toHaveBeenCalledTimes(1)
    })

    it('expanding a PARTIAL page fetches the next one at the right offset', async () => {
      const first = Array.from({ length: 20 }, (_, i) => review(i + 1))
      const second = [review(21), review(22), review(23), review(24), review(25)]
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status: 'completed' }))
      vi.mocked(practicesApi.getPracticeReviews)
        .mockResolvedValueOnce(reviewsPage(first, 25))
        .mockResolvedValueOnce({ items: second, total: 25, limit: 20, offset: 20 })
      mount()
      await flush()

      host?.querySelector<HTMLButtonElement>('.v-show-more')?.click()
      await flush()

      // offset = reviews.length at call time (.vue:506), i.e. 20 -- not a page
      // counter, and not 0 again.
      expect(practicesApi.getPracticeReviews).toHaveBeenLastCalledWith('p1', 20, 20)
      expect(host?.querySelectorAll('.practice-detail__review')).toHaveLength(25)
      expect(text()).toContain('Рецензент 25')
    })

    it('does NOT re-fetch the same page when «Показать ещё» is hit twice in flight', async () => {
      // The reviewsLoading re-entry guard (.vue:503). A double hit would append
      // the SAME page twice -- duplicate reviews on screen.
      const first = Array.from({ length: 20 }, (_, i) => review(i + 1))
      let resolveSecond!: (v: unknown) => void
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status: 'completed' }))
      vi.mocked(practicesApi.getPracticeReviews)
        .mockResolvedValueOnce(reviewsPage(first, 40))
        .mockReturnValueOnce(
          new Promise((r) => {
            resolveSecond = r as (v: unknown) => void
          }) as ReturnType<typeof practicesApi.getPracticeReviews>,
        )
      mount()
      await flush()

      host?.querySelector<HTMLButtonElement>('.v-show-more')?.click()
      await nextTick()
      const more = Array.from(host?.querySelectorAll('button') ?? []).find(
        (b) => b.textContent?.trim() === 'Показать ещё',
      )
      // Without this the guard is never exercised: a missing button makes the
      // second click a no-op and the call count lands on 2 regardless.
      expect(more).toBeDefined()
      more?.click()
      await nextTick()

      expect(practicesApi.getPracticeReviews).toHaveBeenCalledTimes(2)

      resolveSecond(reviewsPage([review(21)], 40))
      await flush()
    })
  })

  describe('CANCEL -- the refund path (irreversible)', () => {
    it('opens the cancel dialog, NOT the delete one, for a scheduled practice', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status: 'scheduled' }))
      mount()
      await flush()
      await openDestructive()

      expect(dialogText()).toContain('Отменить практику?')
      expect(dialogText()).not.toContain('Удалить черновик практики?')
      // Doubles as the discrimination check for dialogDismissed(): an OPEN
      // dialog must report false, or the two «closes the dialog» tests below
      // are asserting a helper that always says yes.
      expect(dialogDismissed()).toBe(false)
    })

    it('the dialog names the practice and its participant count before the master commits', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({ status: 'scheduled', title: 'Утренняя йога', current_participants: 4 }),
      )
      mount()
      await flush()
      await openDestructive()

      expect(dialogText()).toContain('Утренняя йога')
      expect(dialogText()).toContain('4 участников')
      expect(dialogText()).toContain('Оплаты вернутся автоматически')
    })

    it('confirming hits cancelPractice with THIS id and scope «this» for a non-series', async () => {
      routeParams.id = 'p42'
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({ id: 'p42', status: 'scheduled', practice_type: 'live' }),
      )
      mount()
      await flush()
      await openDestructive()

      dialogButton('Отменить')?.click()
      await flush()

      expect(practicesApi.cancelPractice).toHaveBeenCalledWith('p42', 'this')
      // The other irreversible endpoint must stay untouched.
      expect(practicesApi.deletePractice).not.toHaveBeenCalled()
    })

    it('a SERIES defaults to «this» -- the wider refund is never the default', async () => {
      // CancelPracticeDialog seeds scope='one' (CancelPracticeDialog.vue:83) and
      // maps it to 'this'. A default of 'this_and_future' would refund every
      // future occurrence on a single mis-tap.
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({ status: 'scheduled', practice_type: 'series', recurrence_days: [1, 3] }),
      )
      mount()
      await flush()
      await openDestructive()

      expect(dialogText()).toContain('Это регулярная практика')
      dialogButton('Отменить')?.click()
      await flush()

      expect(practicesApi.cancelPractice).toHaveBeenCalledWith('p1', 'this')
    })

    it('choosing «Эту и будущие» sends scope «this_and_future»', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({ status: 'scheduled', practice_type: 'series', recurrence_days: [1, 3] }),
      )
      mount()
      await flush()
      await openDestructive()

      const future = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>('.v-modal__overlay [role="radio"]'),
      ).find((b) => b.textContent?.includes('Эту и будущие'))
      expect(future).toBeDefined()
      future?.click()
      await flush()

      dialogButton('Отменить')?.click()
      await flush()

      expect(practicesApi.cancelPractice).toHaveBeenCalledWith('p1', 'this_and_future')
    })

    it('a NON-series never offers the scope radio -- it has no siblings to refund', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({ status: 'scheduled', practice_type: 'live' }),
      )
      mount()
      await flush()
      await openDestructive()

      // Anchored on the dialog being OPEN: "no radio" is trivially true of a
      // dialog that never rendered.
      expect(dialogText()).toContain('Отменить практику?')
      expect(dialogText()).not.toContain('Это регулярная практика')
      expect(document.body.querySelectorAll('.v-modal__overlay [role="radio"]')).toHaveLength(0)
    })

    it('on success: toasts, refreshes the master cache, and leaves the screen', async () => {
      // refreshMyPractices matters: the cache this very screen reads through
      // (.vue:575) would otherwise keep serving the practice as `scheduled`
      // after it was cancelled.
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status: 'scheduled' }))
      mount()
      await flush()
      await openDestructive()

      dialogButton('Отменить')?.click()
      await flush()

      expect(toastSuccess).toHaveBeenCalledWith('Практика отменена')
      expect(refreshMyPractices).toHaveBeenCalled()
      expect(back).toHaveBeenCalled()
    })

    it('«Не отменять» closes the dialog and calls NOTHING', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status: 'scheduled' }))
      mount()
      await flush()
      await openDestructive()

      // Asserted DEFINED before clicking: `?.click()` on an undefined button is
      // a silent no-op, and a not.toHaveBeenCalled() below it would then pass
      // for the wrong reason. Every negative-space test in this file anchors on
      // the control existing first.
      expect(dialogButton('Не отменять')).toBeDefined()
      dialogButton('Не отменять')?.click()
      await flush()

      expect(practicesApi.cancelPractice).not.toHaveBeenCalled()
      expect(back).not.toHaveBeenCalled()
      expect(dialogDismissed()).toBe(true)
    })

    it('surfaces the REAL backend detail on failure and does NOT claim success', async () => {
      // Telling a master their practice is cancelled when it is not leaves
      // participants showing up to a session nobody runs.
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status: 'scheduled' }))
      vi.mocked(practicesApi.cancelPractice).mockRejectedValue(
        new ApiResponseError(409, 'Практика уже началась', 'practice_live'),
      )
      mount()
      await flush()
      await openDestructive()

      dialogButton('Отменить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Практика уже началась')
      expect(toastSuccess).not.toHaveBeenCalled()
      expect(back).not.toHaveBeenCalled()
      expect(refreshMyPractices).not.toHaveBeenCalled()
    })

    it('falls back to a generic message on a non-API error', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status: 'scheduled' }))
      vi.mocked(practicesApi.cancelPractice).mockRejectedValue(new TypeError('offline'))
      mount()
      await flush()
      await openDestructive()

      dialogButton('Отменить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось отменить практику')
      expect(back).not.toHaveBeenCalled()
    })

    it('does NOT fire two refunds when the button is hit twice in flight', async () => {
      // The `cancelling` re-entry guard (.vue:539). Two POSTs to /cancel is two
      // refund sweeps over the same bookings.
      let resolve!: (v: PracticeResponse) => void
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status: 'scheduled' }))
      vi.mocked(practicesApi.cancelPractice).mockReturnValue(
        new Promise((r) => {
          resolve = r
        }),
      )
      mount()
      await flush()
      await openDestructive()

      dialogButton('Отменить')?.click()
      await nextTick()
      dialogButton('Отменить')?.click()
      await nextTick()

      expect(practicesApi.cancelPractice).toHaveBeenCalledTimes(1)

      resolve(practice({ status: 'cancelled' }))
      await flush()
    })
  })

  describe('DELETE -- the draft path (irreversible)', () => {
    it('opens the delete confirm, NOT the cancel dialog, for a draft', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status: 'draft' }))
      mount()
      await flush()
      await openDestructive()

      expect(dialogText()).toContain('Удалить черновик практики? Это действие необратимо.')
      expect(dialogText()).not.toContain('Отменить практику?')
    })

    it('confirming hits deletePractice with THIS id and never cancelPractice', async () => {
      // The branch that matters most on this screen (.vue:533-536). A draft has
      // no bookings and no money: routing it to /cancel would run a refund
      // sweep over nothing while leaving the draft alive.
      routeParams.id = 'p42'
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({ id: 'p42', status: 'draft' }),
      )
      mount()
      await flush()
      await openDestructive()

      dialogButton('Удалить')?.click()
      await flush()

      expect(practicesApi.deletePractice).toHaveBeenCalledWith('p42')
      expect(practicesApi.cancelPractice).not.toHaveBeenCalled()
    })

    it('on success: toasts, refreshes the master cache, and leaves the screen', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status: 'draft' }))
      mount()
      await flush()
      await openDestructive()

      dialogButton('Удалить')?.click()
      await flush()

      expect(toastSuccess).toHaveBeenCalledWith('Черновик удалён')
      expect(refreshMyPractices).toHaveBeenCalled()
      expect(back).toHaveBeenCalled()
    })

    it('«Отмена» closes the confirm and calls NOTHING', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status: 'draft' }))
      mount()
      await flush()
      await openDestructive()

      expect(dialogButton('Отмена')).toBeDefined()
      dialogButton('Отмена')?.click()
      await flush()

      expect(practicesApi.deletePractice).not.toHaveBeenCalled()
      expect(back).not.toHaveBeenCalled()
      expect(dialogDismissed()).toBe(true)
    })

    it('surfaces the REAL backend detail on failure and does NOT claim success', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status: 'draft' }))
      vi.mocked(practicesApi.deletePractice).mockRejectedValue(
        new ApiResponseError(409, 'Черновик уже опубликован', 'not_a_draft'),
      )
      mount()
      await flush()
      await openDestructive()

      dialogButton('Удалить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Черновик уже опубликован')
      expect(toastSuccess).not.toHaveBeenCalled()
      expect(back).not.toHaveBeenCalled()
    })

    it('falls back to a generic message on a non-API error', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status: 'draft' }))
      vi.mocked(practicesApi.deletePractice).mockRejectedValue(new TypeError('offline'))
      mount()
      await flush()
      await openDestructive()

      dialogButton('Удалить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось удалить практику')
      expect(back).not.toHaveBeenCalled()
    })

    it('does NOT double-delete when the button is hit twice in flight', async () => {
      let resolve!: () => void
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ status: 'draft' }))
      vi.mocked(practicesApi.deletePractice).mockReturnValue(
        new Promise<void>((r) => {
          resolve = r
        }),
      )
      mount()
      await flush()
      await openDestructive()

      dialogButton('Удалить')?.click()
      await nextTick()
      dialogButton('Удалить')?.click()
      await nextTick()

      expect(practicesApi.deletePractice).toHaveBeenCalledTimes(1)

      resolve()
      await flush()
    })
  })

  describe('navigation', () => {
    it('«Изменить» goes to the edit screen for THIS practice', async () => {
      routeParams.id = 'p42'
      vi.mocked(practicesApi.getPractice).mockResolvedValue(practice({ id: 'p42' }))
      mount()
      await flush()

      byAria('Меню')?.click()
      await flush()
      byAria('Редактировать')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({
        name: 'master-practice-edit',
        params: { id: 'p42' },
      })
    })

    it('Check-ins and Посещаемость go to their own routes (PAST branch)', async () => {
      routeParams.id = 'p42'
      vi.mocked(practicesApi.getPractice).mockResolvedValue(
        practice({ id: 'p42', status: 'completed' }),
      )
      mount()
      await flush()

      const btn = (label: string) =>
        Array.from(host?.querySelectorAll('button') ?? []).find(
          (b) => b.textContent?.trim() === label,
        )

      btn('Check-ins')?.click()
      await flush()
      expect(push).toHaveBeenCalledWith({ name: 'master-attendance', params: { id: 'p42' } })

      btn('Посещаемость')?.click()
      await flush()
      expect(push).toHaveBeenCalledWith({
        name: 'master-attendance-roster',
        params: { id: 'p42' },
      })
    })

    it('the header back button goes back', async () => {
      mount()
      await flush()

      byAria('Назад')?.click()
      await flush()

      expect(back).toHaveBeenCalled()
    })

    it('the UPCOMING hub deliberately offers NO «Начать практику» (going live is automatic)', async () => {
      // .vue:15-18: the backend lifecycle worker flips scheduled -> live by the
      // clock, and PATCH status='live' is a 422. A button here would be a dead
      // end the master would keep pressing. Pinned so nobody re-adds it.
      mount()
      await flush()

      // Anchored: the hub must actually be on screen, or "no button" is true of
      // an error state too.
      expect(text()).toContain('Записалось')
      expect(text()).not.toContain('Начать практику')
      expect(text()).not.toContain('Опубликовать')
    })
  })

  // NOT COVERED, deliberately -- stated rather than faked:
  //
  // 1. Route reuse. `practiceId` is read ONCE from route.params during setup
  //    (.vue:353) and there is no watch on it, so this screen relies on Vue
  //    Router remounting it between practices. `useRoute` is mocked as a plain
  //    object (velo-idiom §6 -- never build a real router), so a test here
  //    would only assert the mock's own mutation. This is a real fragility of
  //    the screen, but proving it needs the routing layer, not this file.
  //
  // 2. The insights cache's LRU eviction and its already-loading skip
  //    (stores/diary.ts:363-374) belong to the store's own tests. The mock here
  //    reproduces only the write, which is all this screen observes.
})
