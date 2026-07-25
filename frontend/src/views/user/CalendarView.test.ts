// =============================================================================
// VELO Frontend -- CalendarView Screen Tests (probekit-screen-test v1.9)
// =============================================================================
//
// 476 lines, no test. One store (useCalendarStore), a real loading/error/empty
// ladder with a length-guard (.vue:114), timezone-dependent date formatting,
// and a 6-kind filter-chip surface.
//
// PATTERN A -- cleaner than the last two screens, but confirmed by reading
// every import, not assumed: the ONLY store this screen touches is
// useCalendarStore (real, its one API seam @/api/practices mocked). There is
// NO second direct-call layer on THIS screen the way EditProfileView had
// submitMethodChangeRequest/updateMasterLanguages. There IS a second module
// needing a mock, same shape as EditProfileView's fourth layer: the real,
// unstubbed child CalendarFilterModal ALWAYS mounts (.vue's template has no
// v-if on it -- confirmed by reading the template, matching the child's own
// header comment "this component itself mounts as soon as CalendarView
// does") and fetches its OWN taxonomy catalog on mount via
// ensureTaxonomyCatalog() (@/utils/methodTaxonomy -> @/api/taxonomy's
// getActiveTaxonomy) -- independent of anything this screen's own script
// calls directly (this screen never calls the taxonomy API itself; it only
// reads the shared LABEL cache via directionLabel() for chip text). Mocked
// to reject, same reasoning as before: both catalogDirectionOptions(null)
// and directionLabel's fallback resolve to the identical hardcoded taxonomy
// on a failed fetch (checked directly in utils/practiceOptions.ts), so a
// rejection is the real offline code path, not a shortcut.
//
// THE LADDER'S GUARD, READ LITERALLY: loading is gated on
// `store.loading && store.weekPractices.length === 0` (.vue:114) -- checking
// whether ANY week data exists at all, not whether the CURRENTLY SELECTED
// day has any. Error and empty follow as v-else-if, so precedence is
// correct when they fire (a template ordering bug, the "one line apart"
// class this session keeps finding, is NOT present here -- error is checked
// before empty, and loadWeek()'s catch clears weekPractices alongside
// setting error, so an error never falls through to "Нет практик"; a
// dedicated test proves this ordering, not just assumes it from reading).
//
// A REAL FINDING lives in what that guard does NOT check (see the report,
// not fixed here): shiftWindow() (nextWeek/prevWeek) updates `selectedDate`
// SYNCHRONOUSLY, before the new week's fetch resolves -- so for the
// duration of that fetch, `weekPractices` still holds the OLD week's
// (non-empty) items while `selectedDate` already points at the NEW week.
// The loading guard's `weekPractices.length === 0` is therefore false (old
// data exists), loading does not render, and `dayPractices` (filtered
// against the NEW selectedDate) is empty -- so "Нет практик" renders while
// the app is still genuinely loading. Reproduced with hard evidence during
// authoring (a green test asserting exactly that DOM state) and PULLED from
// this commit -- reported to the navigator separately with the reproduction
// steps rather than landed silently in the batch (skill Step 6 / operator
// rule: a
// real find is reported, not silently patched inside a test task).
//
// TIMEZONE (SW2, fixed ПРОМТ №577): dayLabel now derives from the VIEWER's
// profile timezone (viewerTz, .vue:205-208), matching the store's own
// selectedDayPractices bucketing (store.ts:165-175) and CalendarPracticeCard's
// rendered time -- previously it read the FIRST practice's OWN `.timezone`
// field, which could disagree with the cards underneath the same header. A
// fixture below carries a practice timezone that differs from both the
// viewer's profile tz and UTC, landing on a DIFFERENT calendar day than the
// viewer-tz bucketing -- so only reading the viewer's tz produces the correct
// label. (dayLabel previously had a "no practices" fallback branch that was
// dead code -- unreachable because dayLabel is rendered ONLY inside the
// template's `v-else` content block, gated on `dayPractices.length > 0` --
// removed in the batch that added this banner note.)
//
// NAME TRAP (per the operator's explicit warning): this screen's OWN dayLabel
// uses formatDateShort (utils/format.ts). CalendarPracticeCard.vue -- the
// child rendering each row -- imports a DIFFERENT function, formatShortDate
// (this session's 98e9a94 bug lived there), but only calls it when its own
// `showDate` prop is true. CalendarView never passes `showDate` (default
// false), so formatShortDate is dead code IN THIS SCREEN'S CONTEXT -- the
// card's `time` computed uses formatTime instead. Verified by reading
// CalendarPracticeCard.vue's props usage, not assumed from the name.
//
// MONEY (NBSP, velo-idiom §11): CalendarPracticeCard's badge falls back to
// formatMoney(price_cents, currency) for a practice that is neither
// is_paid nor is_free (.vue:82-93) -- the one live money path in this
// screen's tree. A fixture priced over 999 is asserted through norm() with
// the ESCAPES from the skill, typed via the Write tool, never a heredoc.
//
// SC-13/SC-13b: CalendarFilterModal wraps VModal (Teleport + Transition,
// same as EditProfileView's delete modal). Purge in afterEach is load-
// bearing; overlay-open assertions use the leave-active check, not
// toBeNull() (SC-13b already cost two red assertions on the LAST screen --
// applied correctly from the start here).
//
// The OUTER Teleport (.vue:28, into `.mobile-layout__island`) is a DIFFERENT
// mechanism -- no <Transition>, and useFloatingHeader() returns false with
// no MobileLayout ancestor providing it (checked the composable directly:
// `inject(KEY, false)`), so `:disabled="!floating"` is true and this
// Teleport renders INLINE, at its natural DOM position, in every test here.
// No teleport-target crash risk, no purge needed for it.
//
// Guard: user-calendar has no per-route beforeEnter (checked router/
// index.ts) -- covered by the root roleRedirect guard already tested in
// guards.test.ts. Not duplicated.
//
// No order dependence: every test mounts its own app + fresh Pinia.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import CalendarView from '@/views/user/CalendarView.vue'
import * as practicesApi from '@/api/practices'
import * as taxonomyApi from '@/api/taxonomy'
import { useAuthStore } from '@/stores/auth'
import { ApiResponseError } from '@/api/client'
import type { PracticeResponse, PaginatedPracticesResponse, UserResponse } from '@/api/types'

vi.mock('@/api/practices')
// Rejected -- both CalendarFilterModal's ensureTaxonomyCatalog() and this
// screen's own directionLabel() calls fall back to the identical hardcoded
// taxonomy on a failed fetch (see banner).
vi.mock('@/api/taxonomy')

const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
}))

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const NOW = new Date('2026-07-20T12:00:00Z') // a Monday
const VIEWER_TZ = 'Europe/Moscow' // UTC+3 -- distinct from every fixture below

function user(overrides: Partial<UserResponse> = {}): UserResponse {
  return {
    id: 'user_1',
    telegram_id: 1,
    role: 'user',
    first_name: 'Аня',
    last_name: null,
    avatar_url: null,
    timezone: VIEWER_TZ,
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
    notifications: {} as UserResponse['notifications'],
    master_notifications: null,
    role_switch: null,
    ...overrides,
  }
}

function practice(id: string, overrides: Partial<PracticeResponse> = {}): PracticeResponse {
  return {
    id,
    master_id: 'master_1',
    master_name: 'Мастер',
    master_avatar_url: null,
    master_methods: [],
    practice_type: 'live',
    status: 'scheduled',
    title: `Практика ${id}`,
    description: null,
    scheduled_at: '2026-07-20T15:00:00Z', // NOW + 3h -- future, same UTC day as NOW
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
    style: null,
    difficulty: null,
    is_paid: false,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: null,
    ...overrides,
  }
}

function page(items: PracticeResponse[], total = items.length): PaginatedPracticesResponse {
  return { items, total, limit: 100, offset: 0 }
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
  app = createApp(CalendarView)
  app.use(pinia)
  app.mount(host)
  return host
}

// COUNTED (velo-idiom §3). onMounted -> store.init() -> await loadWeek() ->
// await getPractices (1) -> re-render (1). In PARALLEL, the always-mounted
// CalendarFilterModal child's own onMounted awaits ensureTaxonomyCatalog()
// -> getActiveTaxonomy (1) -> re-render (1). Neither awaited by the other.
// Generous, matching the last two screens' precedent for a multi-seam mount.
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await nextTick()
}

function norm(s: string | null | undefined): string {
  return (s ?? '').replace(/[   ]/g, ' ')
}
function text(): string {
  return norm(host?.textContent)
}

function loader(): HTMLElement | null {
  return host?.querySelector('.calendar__loader') ?? null
}
function emptyByTitle(t: string): HTMLElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLElement>('.v-empty') ?? []).find(
    (e) => e.querySelector('.v-empty__title')?.textContent?.trim() === t,
  )
}
function dateHeader(): string {
  return norm(host?.querySelector('.calendar__date-header')?.textContent).trim()
}
function practiceCards(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.practice-list-card') ?? [])
}
function cardTitle(c: HTMLElement): string {
  return norm(c.querySelector('.practice-list-card__title')?.textContent).trim()
}
function cardBadge(c: HTMLElement): string {
  return norm(c.querySelector('.v-badge')?.textContent).trim()
}
function dayCellByNum(num: number): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.week-strip__day') ?? []).find(
    (b) => b.querySelector('.week-strip__num')?.textContent?.trim() === String(num),
  )
}
function dayCellHasDot(b: HTMLButtonElement): boolean {
  return !!b.querySelector('.week-strip__dot--visible')
}
function nextWeekBtn(): HTMLButtonElement | undefined {
  return host?.querySelector<HTMLButtonElement>('.week-strip__arrow[aria-label="Следующая неделя"]') ?? undefined
}
function prevWeekBtn(): HTMLButtonElement | undefined {
  return host?.querySelector<HTMLButtonElement>('.week-strip__arrow[aria-label="Предыдущая неделя"]') ?? undefined
}
function selectPill(): HTMLButtonElement | undefined {
  return host?.querySelector<HTMLButtonElement>('.calendar__select-pill') ?? undefined
}
function funnel(): HTMLElement | undefined {
  return host?.querySelector<HTMLElement>('.calendar__funnel') ?? undefined
}
function collapseBtn(): HTMLButtonElement | undefined {
  return host?.querySelector<HTMLButtonElement>('.calendar__collapse') ?? undefined
}
function activeChipEls(): HTMLButtonElement[] {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.calendar__chip--on') ?? [])
}
function activeChipTexts(): string[] {
  return activeChipEls().map((c) => norm(c.textContent).trim())
}
function chipByText(t: string): HTMLButtonElement | undefined {
  return activeChipEls().find((c) => norm(c.textContent).trim() === t)
}

// Modal is teleported to document.body (SC-07).
function modalOverlay(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('.v-modal__overlay')
}
// SC-13b: a closing VModal is parked at `.v-modal-leave-active`, not removed.
function modalIsOpen(): boolean {
  const el = modalOverlay()
  return !!el && !el.classList.contains('v-modal-leave-active')
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)

  pinia = createPinia()
  setActivePinia(pinia)

  vi.mocked(practicesApi.getPractices).mockReset().mockResolvedValue(page([practice('p1')]))
  vi.mocked(taxonomyApi.getActiveTaxonomy).mockReset().mockRejectedValue(new Error('offline in test'))

  useAuthStore().user = user()

  push.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null

  document.body.querySelectorAll('.v-modal__overlay').forEach((el) => el.remove())

  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('CalendarView', () => {
  // ===========================================================================
  describe('the ladder', () => {
    it('loading (initial): shows the loader and nothing else while the first fetch is in flight', async () => {
      vi.mocked(practicesApi.getPractices).mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(loader()).not.toBeNull()
      expect(emptyByTitle('Не удалось загрузить')).toBeUndefined()
      expect(emptyByTitle('Нет практик')).toBeUndefined()
      expect(practiceCards()).toHaveLength(0)
    })

    it('error: shows the REAL backend message, and the ordering means error wins over empty (not "Нет практик")', async () => {
      // extractApiError only surfaces e.detail for a REAL ApiResponseError
      // (checked useApiError.ts directly) -- a plain Error always falls back
      // to the hardcoded string, so this has to be the real class to prove
      // backend-message propagation rather than the screen's own fallback.
      vi.mocked(practicesApi.getPractices).mockRejectedValue(
        new ApiResponseError(503, 'Сервис недоступен', 'service_unavailable'),
      )
      mount()
      await flush()

      const err = emptyByTitle('Не удалось загрузить')
      expect(err).toBeDefined()
      expect(norm(err?.querySelector('.v-empty__desc')?.textContent)).toBe('Сервис недоступен')
      // The same underlying condition (weekPractices=[]) that would show
      // "empty" is ALSO true here -- proving error precedes it, not just
      // that error renders in isolation.
      expect(emptyByTitle('Нет практик')).toBeUndefined()
    })

    it('error fallback: a non-ApiResponseError shows the hardcoded fallback, not a raw exception message (SC-05)', async () => {
      vi.mocked(practicesApi.getPractices).mockRejectedValue(new Error('ECONNRESET'))
      mount()
      await flush()

      const err = emptyByTitle('Не удалось загрузить')
      expect(norm(err?.querySelector('.v-empty__desc')?.textContent)).toBe('Не удалось загрузить календарь')
    })

    it('error: Retry re-calls loadWeek through the store (not a page reload)', async () => {
      vi.mocked(practicesApi.getPractices).mockRejectedValue(new Error('Сервис недоступен'))
      mount()
      await flush()
      vi.mocked(practicesApi.getPractices).mockClear().mockResolvedValue(page([practice('p1')]))

      const retryBtn = Array.from(
        emptyByTitle('Не удалось загрузить')?.querySelectorAll<HTMLButtonElement>('button') ?? [],
      ).find((b) => b.textContent?.trim() === 'Повторить')
      expect(retryBtn).toBeDefined()
      retryBtn?.click()
      await flush()

      expect(practicesApi.getPractices).toHaveBeenCalledTimes(1)
      expect(emptyByTitle('Не удалось загрузить')).toBeUndefined()
      expect(practiceCards()).toHaveLength(1)
    })

    it('empty: a genuinely empty day (no fetch error) shows "Нет практик", not the error state', async () => {
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([]))
      mount()
      await flush()

      expect(emptyByTitle('Нет практик')).toBeDefined()
      expect(emptyByTitle('Не удалось загрузить')).toBeUndefined()
      expect(loader()).toBeNull()
    })

    it('content: renders the selected day\'s practices with real titles and badges', async () => {
      vi.mocked(practicesApi.getPractices).mockResolvedValue(
        page([
          practice('p1', { title: 'Утренняя медитация', is_free: true }),
          practice('p2', { title: 'Вечерняя йога', is_free: false, is_paid: true }),
        ]),
      )
      mount()
      await flush()

      const cards = practiceCards()
      expect(cards).toHaveLength(2)
      const titles = cards.map(cardTitle)
      expect(titles).toEqual(['Утренняя медитация', 'Вечерняя йога'])
      expect(cardBadge(cards[0]!)).toBe('Бесплатно')
      expect(cardBadge(cards[1]!)).toBe('Оплачено')
    })
  })

  // ===========================================================================
  describe('day label + timezone', () => {
    it('SW2: uses the VIEWER profile timezone, not the practice\'s own -- distinguishing fixture', async () => {
      // 20:00 UTC on the 20th (after NOW=12:00Z, so not filtered as
      // already-started). In the VIEWER's Moscow (UTC+3) that's 23:00 on the
      // 20th -- the SAME calendar day as NOW there (15:00 on the 20th), which
      // is also the store's default selectedDate (bucketed in viewer tz,
      // store.ts:165-175) -- so this practice IS the day's content and the
      // correct label is "Сегодня". In the practice's OWN tz (Asia/
      // Yekaterinburg, UTC+5, no DST) the same instant is 01:00 on the 21st,
      // while NOW there is still 17:00 on the 20th -- so the OLD buggy
      // behaviour (reading practice.timezone) renders "Завтра" instead. Two
      // genuinely different strings -- unlike the previous version of this
      // test, "Сегодня" alone can't be produced by both branches by
      // coincidence.
      vi.mocked(practicesApi.getPractices).mockResolvedValue(
        page([practice('p1', { scheduled_at: '2026-07-20T20:00:00Z', timezone: 'Asia/Yekaterinburg' })]),
      )
      mount()
      await flush()

      expect(dateHeader()).toBe('Сегодня')
    })

    it('dot-marker bucketing uses the VIEWER profile timezone, not the practice\'s own -- distinguishing fixture', async () => {
      // 22:30 UTC on the 20th: in the practice's OWN tz (UTC, if unset -> the
      // fixture default) it's still the 20th, but in the VIEWER's Moscow
      // (UTC+3) it's already 01:30 on the 21st. daysWithPractices buckets by
      // VIEWER tz (store.ts's own comment, confirmed): the dot must land on
      // the 21st's cell, not the 20th's -- this is the one place a
      // viewerTz-vs-practice-tz mix-up would be directly observable.
      vi.mocked(practicesApi.getPractices).mockResolvedValue(
        page([practice('p_late', { scheduled_at: '2026-07-20T22:30:00Z', timezone: 'UTC' })]),
      )
      mount()
      await flush()

      const day20 = dayCellByNum(20)
      const day21 = dayCellByNum(21)
      expect(day20).toBeDefined()
      expect(day21).toBeDefined()
      expect(dayCellHasDot(day20!)).toBe(false)
      expect(dayCellHasDot(day21!)).toBe(true)
    })
  })

  // ===========================================================================
  describe('week navigation', () => {
    it('selecting a different day within the loaded week does NOT refetch (client-side slice)', async () => {
      vi.mocked(practicesApi.getPractices).mockResolvedValue(
        page([
          practice('today', { scheduled_at: '2026-07-20T15:00:00Z' }),
          practice('tomorrow', { scheduled_at: '2026-07-21T15:00:00Z', title: 'Завтрашняя' }),
        ]),
      )
      mount()
      await flush()
      expect(practicesApi.getPractices).toHaveBeenCalledTimes(1)
      expect(practiceCards()).toHaveLength(1)

      dayCellByNum(21)?.click()
      await flush()

      expect(practicesApi.getPractices).toHaveBeenCalledTimes(1) // still just the initial load
      expect(practiceCards().map(cardTitle)).toEqual(['Завтрашняя'])
    })

    it('next/prev week reload with a shifted date range; prev is disabled at the current (today-anchored) window', async () => {
      mount()
      await flush()

      expect(prevWeekBtn()?.disabled).toBe(true) // window starts today -- can't go earlier

      nextWeekBtn()?.click()
      await flush()

      expect(practicesApi.getPractices).toHaveBeenCalledTimes(2)
      expect(prevWeekBtn()?.disabled).toBe(false) // now one window ahead -- prev is live
    })

    it('next-week loading: while the shifted week\'s fetch is in flight, the loader shows and stale old-week data does not flash "Нет практик" (regression, BUG №461)', async () => {
      // shiftWindow() moves selectedDate SYNCHRONOUSLY; weekPractices still
      // holds the OLD week's (non-empty) items until the new fetch resolves.
      // A guard keyed on weekPractices.length would read that stale non-empty
      // list as "not loading" and fall through to dayPractices (now filtered
      // against the NEW date -- always empty, since a 7-day shift never
      // overlaps the old week) -- rendering "Нет практик" while genuinely
      // still loading.
      mount()
      await flush()
      expect(practiceCards()).toHaveLength(1) // sanity: current week has content

      vi.mocked(practicesApi.getPractices).mockReturnValue(new Promise(() => {}))
      nextWeekBtn()?.click()
      await flush()

      expect(loader()).not.toBeNull()
      expect(emptyByTitle('Нет практик')).toBeUndefined()
      expect(practiceCards()).toHaveLength(0)
    })
  })

  // ===========================================================================
  describe('the "Выбрать практики" selector', () => {
    it('collapsed by default: pill + funnel, no chips row', async () => {
      mount()
      await flush()

      expect(selectPill()).toBeDefined()
      expect(activeChipEls()).toHaveLength(0)
    })

    it('funnel opens the filter modal directly, WITHOUT expanding the chip row', async () => {
      mount()
      await flush()

      funnel()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()

      expect(modalIsOpen()).toBe(true)
      expect(selectPill()).toBeDefined() // still collapsed -- funnel didn't expand
    })

    it('tapping the pill body (not the funnel) expands to the chip row; collapse returns to the pill', async () => {
      mount()
      await flush()

      selectPill()?.click()
      await flush()

      expect(selectPill()).toBeUndefined()
      expect(text()).toContain('Фильтры не выбраны')

      collapseBtn()?.click()
      await flush()

      expect(selectPill()).toBeDefined()
    })
  })

  // ===========================================================================
  describe('active filter chips', () => {
    it('renders one chip per active facet, with the RIGHT label per kind (6 kinds, style deliberately excluded)', async () => {
      const store = (await import('@/stores/calendar')).useCalendarStore()
      store.filters.direction = ['meditation']
      store.filters.difficulty = ['beginner', 'high']
      store.filters.practice_type = ['live', 'replay']
      store.filters.duration_bucket = 'short'
      store.filters.time_of_day = 'morning'
      store.filters.style = ['silence'] // must NOT produce a visible chip
      mount()
      await flush()
      // Chips only render once expanded -- the collapsed pill shows neither
      // chips nor a count (.vue:49-61 vs :64-110, mutually exclusive v-if).
      selectPill()?.click()
      await flush()

      expect(activeChipTexts().sort()).toEqual(
        [
          'Медитация', // direction (directionLabel, hardcoded fallback)
          'Начальная', // difficulty
          'Высокая', // difficulty
          'Live', // practice_type
          'Записи', // practice_type
          'До 1 часа', // duration_bucket
          'Утро', // time_of_day
        ].sort(),
      )
      // Style never renders as its own chip (documented exclusion, .vue:261-264).
      expect(chipByText('silence')).toBeUndefined()
      expect(chipByText('Медитация')).toBeDefined()
    })

    it('no active filters: shows "Фильтры не выбраны" in the expanded row', async () => {
      mount()
      await flush()
      selectPill()?.click()
      await flush()

      expect(text()).toContain('Фильтры не выбраны')
      expect(activeChipEls()).toHaveLength(0)
    })

    it('removing a MULTI-select chip (difficulty) keeps the other value and every other facet', async () => {
      const store = (await import('@/stores/calendar')).useCalendarStore()
      store.filters.difficulty = ['beginner', 'high']
      store.filters.time_of_day = 'morning'
      mount()
      await flush()
      selectPill()?.click()
      await flush()
      vi.mocked(practicesApi.getPractices).mockClear()

      chipByText('Начальная')?.click()
      await flush()

      expect(store.filters.difficulty).toEqual(['high'])
      expect(store.filters.time_of_day).toBe('morning') // untouched
      expect(practicesApi.getPractices).toHaveBeenCalledTimes(1) // reloaded
    })

    it('removing a SINGLE-select chip (duration_bucket) clears just that axis', async () => {
      const store = (await import('@/stores/calendar')).useCalendarStore()
      store.filters.duration_bucket = 'short'
      store.filters.direction = ['yoga']
      mount()
      await flush()
      selectPill()?.click()
      await flush()

      chipByText('До 1 часа')?.click()
      await flush()

      expect(store.filters.duration_bucket).toBeUndefined()
      expect(store.filters.direction).toEqual(['yoga'])
    })

    it('removing the LAST direction cascades to clear style too (an orphaned style is meaningless)', async () => {
      const store = (await import('@/stores/calendar')).useCalendarStore()
      store.filters.direction = ['meditation']
      store.filters.style = ['silence']
      mount()
      await flush()
      selectPill()?.click()
      await flush()

      chipByText('Медитация')?.click()
      await flush()

      expect(store.filters.direction).toBeUndefined()
      expect(store.filters.style).toBeUndefined()
    })
  })

  // ===========================================================================
  describe('card navigation', () => {
    it('clicking a practice card routes to practice-detail with its id', async () => {
      vi.mocked(practicesApi.getPractices).mockResolvedValue(page([practice('p1')]))
      mount()
      await flush()

      practiceCards()[0]?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'practice-detail', params: { id: 'p1' } })
    })
  })

  // ===========================================================================
  describe('money (NBSP)', () => {
    it('a priced, non-free, non-paid practice renders the REAL formatted price above 999 (NBSP-safe)', async () => {
      vi.mocked(practicesApi.getPractices).mockResolvedValue(
        page([practice('p1', { is_free: false, is_paid: false, price_cents: 152350, currency: 'EUR' })]),
      )
      mount()
      await flush()

      expect(cardBadge(practiceCards()[0]!)).toContain('1 523,50')
    })
  })
})
