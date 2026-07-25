// =============================================================================
// VELO Frontend -- MasterPracticesView Screen Tests
// =============================================================================
//
// The master's own practice list -- the screen they navigate their whole
// inventory from. Nothing here is irreversible, but everything here is a
// FILTER, a SORT or a ROUTE, and all three fail silently:
//
//   1. The two tabs are not a view toggle, they are a STATUS PARTITION.
//      Upcoming = draft|scheduled|live, Past = completed ONLY, and `cancelled`
//      / `deleted` are in NEITHER (.vue:204-217, operator 2026-06-25). A
//      practice that falls through the partition is simply invisible to its own
//      owner -- no error, no empty state, just a row that is not there. Both
//      tabs are asserted for what they include AND what they must exclude.
//   2. The order is now whatever the SERVER returns (T22-3/T22-5, ПРОМТ
//      №561) -- the view's old client-side localSortKey re-sort is gone by
//      owner decision. The "renders the SERVER order verbatim" test below is
//      built so the absolute-instant order and the old local-wall-clock order
//      DISAGREE -- it is the one assertion that can catch a re-sort creeping
//      back in.
//   3. goDetail pushes an id (.vue:291-293). A wrong id opens somebody else's
//      practice; assertions are on the ROUTE OBJECT, not that push fired.
//
// PATTERN A (store-backed), with one local view-state ref.
//   - DATA: masterStore.practices/practicesLoading/practicesError/
//     practicesHasMore (.vue:50-160) and diaryStore.insightsCache (.vue:194).
//     Both stores are REAL, seamed at the two API modules they import
//     (@/api/masters, @/api/diary) -- one mock pair covers both. The stores are
//     NOT mocked, deliberately: `insightsCache` is grabbed BY REFERENCE at
//     setup (.vue:194) and the rating badges derive off that reactive Map, so a
//     hand-rolled fake Map risks being quietly non-reactive and the badge tests
//     would then prove the fixture instead of the screen.
//   - LOCAL: activeTab (.vue:199) is the screen's own ref, and it is driven
//     ONLY by clicking the real tab button -- never assigned. Setting it
//     directly would skip the watch (.vue:300-306) that is half its behaviour.
// One pinia instance goes to setActivePinia AND app.use (SC-03).
//
// TIME IS PINNED to 2026-07-20T12:00:00Z. whenLabel -> formatDateShort compares
// each practice against `new Date()` for «Сегодня»/«Завтра» (utils/format.ts:
// 65-85), so unpinned the card sub-line is a different string every day and the
// «Завтра» assertion would be green only on 2026-07-21 (SC-04). Every fixture
// date is a LITERAL chosen against that frozen instant, never `Date.now() + n`,
// and every fixture carries an explicit `timezone`.
//
// TRAP -- v-if, NOT v-show, so SC-14 does not bite the PANES: only one tab's
// list is ever in the DOM (.vue:72,120) and `.mp-card` cannot span both tabs.
// (Grepped: zero `v-show` in this SFC. AnalyticsView, the sibling tab screen,
// is the opposite and must be read the other way -- do not copy across.)
// The CHROME is a different story: the tab STRIP is always mounted, so both
// labels «Предстоящие» and «Прошедшие» are in host.textContent before you touch
// anything. `expect(text()).toContain('Прошедшие')` is therefore an assertion
// that cannot fail -- SC-14's shape without SC-14's cause. Which tab is live is
// read off aria-selected and off the rendered list, never off host text.
//
// NO OVERLAY, so no SC-13 reap -- and this was verified, not assumed: the
// children are VHeader / VButton / VLoader / VEmptyState / VSegmentTrack /
// VRatingBadges, none of which is VModal or VBottomSheet (the only two
// overlay-teleporting DS components). VHeader DOES hold a `Teleport defer
// to=".mobile-layout__island"`, but it is `:disabled="!floating"` and floating
// is `inject(KEY, false)` (useFloatingHeader.ts:34-36) -- no MobileLayout
// ancestor here, so it renders inline and the «+» button is reachable in `host`.
// An unconditional purge would be dead code justified by a false claim; when a
// sheet lands on this screen, add it.
//
// NO MONEY is formatted -- formatMoney is not imported (.vue:185), so the ru
// NBSP trap (velo-idiom §11) cannot bite through a price. tidy() still
// normalises U+00A0/U+202F/U+2009 anyway, because Intl.DateTimeFormat emits
// NBSP around times on some ICU builds and the guard is free.
//
// The router is mocked flat: `replace` does NOT write back into `routeQuery`,
// so the tab->URL mirror is asserted on the single transition it makes, not
// round-tripped. Stated because a reader will otherwise expect route.query to
// move.
//
// No order dependence: every test mounts its own app, beforeEach rebuilds pinia
// and all fixtures. Declaration order is execution order (no shuffle).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import MasterPracticesView from '@/views/master/MasterPracticesView.vue'
// The REAL store, read in two tests -- the data always survived a failed
// load-more; it was the template that hid it (fixed №441, see «Показать ещё»).
import { useMasterStore } from '@/stores/master'
import * as mastersApi from '@/api/masters'
import * as diaryApi from '@/api/diary'
import { ApiResponseError } from '@/api/client'
import type { PracticeResponse, PracticeInsightsResponse } from '@/api/types'

// The two seams under the two REAL stores: useMasterStore reads @/api/masters
// (stores/master.ts:12), useDiaryStore reads @/api/diary. ApiResponseError is
// left REAL (it lives in @/api/client, unmocked) so the error rung asserts
// against the real class.
vi.mock('@/api/masters')
vi.mock('@/api/diary')

const push = vi.fn()
const replace = vi.fn()
// The screen reads route.query.tab at SETUP (.vue:199) to pick the initial tab,
// and again inside the watch (.vue:302). Mutable module-scope object behind a
// getter (velo-idiom §5) so a test can seed the URL BEFORE mount -- seeding
// after is too late, the ref initialiser has already run.
let routeQuery: Record<string, string> = {}
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, replace, back: vi.fn() }),
  useRoute: () => ({
    get query() {
      return routeQuery
    },
  }),
}))

// The load-more failure path toasts rather than blanking the list (.vue:301-306),
// so the toast IS the master-facing half of that behaviour and has to be asserted.
const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), info: vi.fn() }),
}))

// -----------------------------------------------------------------------------
// The frozen instant
// -----------------------------------------------------------------------------

const NOW = new Date('2026-07-20T12:00:00Z')

// -----------------------------------------------------------------------------
// Fixtures. Every date is a literal picked against NOW:
//   2026-07-20 = Сегодня, 2026-07-21 = Завтра, anything else = «N июля».
// -----------------------------------------------------------------------------

function practice(id: string, overrides: Partial<PracticeResponse> = {}): PracticeResponse {
  return {
    id,
    master_id: 'm1',
    practice_type: 'live',
    status: 'scheduled',
    title: `Практика ${id}`,
    description: null,
    scheduled_at: '2026-07-21T09:00:00Z',
    duration_minutes: 60,
    timezone: 'UTC',
    max_participants: 20,
    current_participants: 5,
    zoom_link: null,
    parent_practice_id: null,
    is_free: true,
    price_cents: 0,
    currency: 'EUR',
    created_at: '2026-07-01T00:00:00Z',
    updated_at: null,
    ...overrides,
  }
}

// -- Upcoming: one of EACH status the tab claims (draft | scheduled | live).
//    A tab that quietly dropped drafts would still look healthy without all
//    three (.vue:206).
const U_LIVE = practice('u-live', {
  title: 'Сегодняшняя',
  status: 'live',
  scheduled_at: '2026-07-20T15:00:00Z',
})
const U_SCHED = practice('u-sched', {
  title: 'Завтрашняя',
  status: 'scheduled',
  scheduled_at: '2026-07-21T09:00:00Z',
})
const U_DRAFT = practice('u-draft', {
  title: 'Черновик',
  status: 'draft',
  scheduled_at: '2026-07-25T10:00:00Z',
})

// A4 V5 (ПРОМТ №571): status is still 'live' (the backend has not yet run its
// autofinalize transition to 'completed') but scheduled_at + duration_minutes
// is already BEHIND NOW -- started 11:00Z, 60 min, ends 12:00Z, frozen instant
// is 12:00:00Z exactly. practiceHasEnded is `nowMs >= end`, so this is the
// boundary case: ended AT this instant, not merely approaching it.
const U_JUST_ENDED = practice('u-just-ended', {
  title: 'Только что закончилась',
  status: 'live',
  scheduled_at: '2026-07-20T11:00:00Z',
  duration_minutes: 60,
})

// -- Past: completed only.
const P_RECENT = practice('p-recent', {
  title: 'Недавняя',
  status: 'completed',
  scheduled_at: '2026-07-18T12:00:00Z',
  current_participants: 5,
})
const P_OLD = practice('p-old', {
  title: 'Давняя',
  status: 'completed',
  scheduled_at: '2026-07-10T08:00:00Z',
  current_participants: 2,
})

// -- The two statuses that must reach NEITHER tab. Both are dated INSIDE the
//    upcoming window on purpose: if the filter leaked, they would sort straight
//    into the middle of the visible list rather than off the end where a lazy
//    assertion might miss them.
const X_CANCELLED = practice('x-cancelled', {
  title: 'Отменённая',
  status: 'cancelled',
  scheduled_at: '2026-07-22T10:00:00Z',
})
const X_DELETED = practice('x-deleted', {
  title: 'Удалённая',
  status: 'deleted',
  scheduled_at: '2026-07-19T10:00:00Z',
})

// Deliberately shuffled: the screen must sort both tabs itself (.vue:207,216).
const ALL = [U_DRAFT, P_RECENT, X_CANCELLED, U_LIVE, P_OLD, X_DELETED, U_SCHED]

function insights(
  practiceId: string,
  participants: number,
  feedbacks: { fire: number; good: number; confused: number },
): PracticeInsightsResponse {
  return {
    practice_id: practiceId,
    participants,
    checkins: { high: 0, mid: 0, low: 0 },
    feedbacks,
    comments_count: 0,
  }
}

// p-recent: 3/1/1 of 5 -> 60/20/20.  p-old: 1/2/1 of 4 -> 25/50/25.
// Different on every bucket, so a card rendering the WRONG practice's insights
// cannot pass.
const INSIGHTS: Record<string, PracticeInsightsResponse> = {
  'p-recent': insights('p-recent', 5, { fire: 3, good: 1, confused: 1 }),
  'p-old': insights('p-old', 4, { fire: 1, good: 2, confused: 1 }),
}

function page(items: PracticeResponse[], total = items.length, offset = 0) {
  return { items, total, limit: 20, offset }
}

// T22-3/T22-5 (ПРОМТ №561): the server now owns the filter AND the ordering
// per bucket -- the view no longer re-filters/re-sorts client-side, so the
// fake server must actually behave like one. Mirrors
// listing_service.py's bucket semantics: "upcoming" = draft/scheduled/live,
// nearest first; "past" = completed only, most-recent first. Cancelled/
// deleted match neither filter, same as the real backend.
function mockBucketedPractices(items: PracticeResponse[]): void {
  vi.mocked(mastersApi.getMyPractices).mockImplementation(
    async (bucket: 'upcoming' | 'past', limit = 20, offset = 0) => {
      const filtered = items
        .filter((p) =>
          bucket === 'upcoming'
            ? p.status === 'draft' || p.status === 'scheduled' || p.status === 'live'
            : p.status === 'completed',
        )
        .sort((a, b) => {
          const diff = new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime()
          return bucket === 'upcoming' ? diff : -diff
        })
      return page(filtered.slice(offset, offset + limit), filtered.length, offset)
    },
  )
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
  app = createApp(MasterPracticesView)
  app.use(pinia)
  app.mount(host)
  return host
}

// COUNTED, not copied (velo-idiom §3, SC-08). The deepest chain onMounted
// (.vue:308-311) kicks off is the PAST tab's practices -> insights one:
//   (1) await getMyPractices inside usePagination.loadMore
//   (2) loadMore's continuation resolves -> (3) refresh's await loadMore
//   (4) fetchMyPractices' await refresh -> onMounted resumes, calls loadTabData
//   (5) await getPracticeInsights inside diaryStore.loadInsights
//   (6) loadInsights' own continuation -> (7) the Promise.all over them
//   (8) loadTabInsights resolves -> (9) loadTabData's await resumes
//   (10) onMounted resumes -> (11) re-render.
// Eleven counted; twelve used. Over-counting is free and this chain grows the
// moment anything else joins that onMounted. The UPCOMING tab is shallower
// (loadTabInsights short-circuits to Promise.resolve([]), .vue:276) -- one
// number for both, sized to the deeper one.
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await nextTick()
}

// Intl emits U+00A0 / U+202F / U+2009 around times depending on the Node/ICU
// build, so all three are flattened rather than pinning one and breaking on a
// runtime upgrade. Written as ESCAPES, never as literal characters: a literal
// NBSP is invisible in a diff and the next editor "tidies" it into a plain
// space without ever seeing what they broke. The second replace collapses the
// template's own newlines/indentation, plus the whitespace text nodes inside
// the inline <svg> icons.
function tidy(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/[\u00A0\u202F\u2009]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// -----------------------------------------------------------------------------
// Queries
// -----------------------------------------------------------------------------

function text(): string {
  return tidy(host?.textContent)
}
function cards(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.mp-card') ?? [])
}
function cardTitles(): string[] {
  return cards().map((c) => tidy(c.querySelector('.mp-card__title')?.textContent))
}
function cardById(title: string): HTMLElement | undefined {
  return cards().find((c) => tidy(c.querySelector('.mp-card__title')?.textContent) === title)
}
function subOf(card: HTMLElement): string {
  return tidy(card.querySelector('.mp-card__sub')?.textContent)
}
/** Every `.mp-stat` chip in the card's meta rows, in document order. */
function statsOf(card: HTMLElement): string[] {
  return Array.from(card.querySelectorAll<HTMLElement>('.mp-stat')).map((s) => tidy(s.textContent))
}
function badgesOf(card: HTMLElement): string[] {
  return Array.from(card.querySelectorAll('.v-rating-badges__badge')).map((b) =>
    tidy(b.textContent),
  )
}

/**
 * A tab button. Which tab is ACTIVE is read from aria-selected
 * (VSegmentTrack.vue:38) or from the rendered list -- never from host text: the
 * strip is always mounted, so both labels are in host.textContent from the
 * first paint and a text assertion on them cannot fail.
 */
function tab(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-segment-track__btn') ?? []).find(
    (b) => tidy(b.textContent) === label,
  )
}
function activeTabLabel(): string | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-segment-track__btn') ?? [])
    .filter((b) => b.getAttribute('aria-selected') === 'true')
    .map((b) => tidy(b.textContent))[0]
}

function buttonWith(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (b) => tidy(b.textContent) === label,
  )
}
function addButton(): HTMLButtonElement | null | undefined {
  return host?.querySelector<HTMLButtonElement>('.master-practices__add-btn')
}
function loader(): HTMLElement | null | undefined {
  return host?.querySelector('.master-practices__loader')
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  // Fake timers, not a bare setSystemTime (A4 V5, mirrors
  // MasterDashboardView.test.ts): the screen now installs a 60s setInterval
  // (.vue) that the clock test below drives directly. Nothing in the mount
  // chain awaits a timer (the API is mocked and usePagination holds none),
  // and microtasks are not faked, so flush() is unaffected.
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  pinia = createPinia()
  setActivePinia(pinia)
  routeQuery = {}

  vi.mocked(mastersApi.getMyPractices).mockReset()
  mockBucketedPractices(ALL)

  // The real store writes whatever this resolves into its reactive cache; a
  // practice with no fixture REJECTS, which is the honest shape of an insights
  // fetch that failed (stores/diary.ts:363-380 swallows it into
  // insightsErrorMap, leaving the id absent from the cache).
  vi.mocked(diaryApi.getPracticeInsights)
    .mockReset()
    .mockImplementation(async (id: string) => {
      const found = INSIGHTS[id]
      if (!found) throw new ApiResponseError(404, 'Нет данных', 'insights_not_found')
      return found
    })

  push.mockReset()
  replace.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.useRealTimers()
  vi.clearAllMocks()
})

/** Mount already switched to «Прошедшие», the way a user gets there. */
async function mountOnPast(): Promise<void> {
  mount()
  await flush()
  tab('Прошедшие')?.click()
  await flush()
}

describe('MasterPracticesView', () => {
  // ===========================================================================
  describe('the ladder', () => {
    it('loading: shows the loader and no cards, with the tab strip still usable', async () => {
      vi.mocked(mastersApi.getMyPractices).mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(loader()).not.toBeNull()
      expect(cards()).toHaveLength(0)
      // The chrome is outside the ladder (.vue:44-46) -- a master must be able
      // to switch tabs while the first page is still in flight.
      expect(tab('Предстоящие')).toBeDefined()
      expect(text()).not.toContain('Нет предстоящих практик')
    })

    it('error: surfaces the REAL backend detail, not a hardcoded fallback', async () => {
      // Meaningful, unlike SC-05's swallow-and-substitute case: usePagination
      // sets `error = e.message` (usePagination.ts:69) and ApiResponseError
      // does `super(detail)` (api/client.ts:34), so the backend's own words
      // reach `:description="masterStore.practicesError"` (.vue:61).
      vi.mocked(mastersApi.getMyPractices).mockRejectedValue(
        new ApiResponseError(503, 'Хранилище практик недоступно', 'db_down'),
      )
      mount()
      await flush()

      expect(text()).toContain('Не удалось загрузить практики')
      expect(text()).toContain('Хранилище практик недоступно')
      expect(cards()).toHaveLength(0)
      expect(loader()).toBeNull()
    })

    it('error: a non-API failure leaks its raw JS message to the master', async () => {
      // Asserted because it is what the screen DOES, not because it is right.
      // `e.message` is taken verbatim off ANY Error (usePagination.ts:69) -- so
      // a fetch failure puts English engine text into a Russian UI. Reported as
      // a finding; this test is the tripwire for the day it is repaired.
      vi.mocked(mastersApi.getMyPractices).mockRejectedValue(new TypeError('Failed to fetch'))
      mount()
      await flush()

      expect(text()).toContain('Failed to fetch')
    })

    it('error: «Повторить» re-fetches and recovers into the real list', async () => {
      vi.mocked(mastersApi.getMyPractices).mockRejectedValueOnce(new TypeError('boom'))
      mount()
      await flush()
      expect(cards()).toHaveLength(0)

      buttonWith('Повторить')?.click()
      await flush()

      expect(text()).not.toContain('Не удалось загрузить практики')
      expect(cardTitles()).toEqual(['Сегодняшняя', 'Завтрашняя', 'Черновик'])
    })

    it('empty: a master with no practices is invited to create the first one', async () => {
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(page([]))
      mount()
      await flush()

      expect(cards()).toHaveLength(0)
      expect(text()).toContain('Нет предстоящих практик')
      expect(text()).toContain('Создайте первую практику')
      expect(buttonWith('Создать')).toBeDefined()
    })

    it('empty: the PAST tab has its own copy, and no «Создать» way out', async () => {
      mockBucketedPractices([U_SCHED])
      await mountOnPast()

      expect(cards()).toHaveLength(0)
      expect(text()).toContain('Нет прошедших практик')
      expect(text()).toContain('Здесь появятся завершённые практики')
      // A past practice cannot be created -- the empty state must not offer to
      // (.vue:151-156 passes no action slot).
      expect(buttonWith('Создать')).toBeUndefined()
    })

    it('empty is PER TAB: a master with only completed practices sees both truths', async () => {
      // The whole partition in one test: upcoming reads empty while past holds
      // the same two rows. An "empty" that spanned both tabs would fail here.
      mockBucketedPractices([P_RECENT, P_OLD])
      mount()
      await flush()
      expect(text()).toContain('Нет предстоящих практик')

      tab('Прошедшие')?.click()
      await flush()

      expect(cardTitles()).toEqual(['Недавняя', 'Давняя'])
      expect(text()).not.toContain('Нет прошедших практик')
    })

    it('content: renders what the store said, not a count', async () => {
      mount()
      await flush()

      expect(cardTitles()).toEqual(['Сегодняшняя', 'Завтрашняя', 'Черновик'])
    })
  })

  // ===========================================================================
  describe('the tabs', () => {
    it('opens on «Предстоящие» when the URL says nothing', async () => {
      mount()
      await flush()

      expect(activeTabLabel()).toBe('Предстоящие')
      expect(cardTitles()).toEqual(['Сегодняшняя', 'Завтрашняя', 'Черновик'])
    })

    it('opens straight on «Прошедшие» when the URL carries ?tab=past', async () => {
      // .vue:199 -- read at SETUP, so the query must be seeded before mount.
      // This is what makes router.back() from a detail restore the tab the
      // master left from instead of dumping them on «Предстоящие».
      routeQuery = { tab: 'past' }
      mount()
      await flush()

      expect(activeTabLabel()).toBe('Прошедшие')
      expect(cardTitles()).toEqual(['Недавняя', 'Давняя'])
    })

    it('does not re-mirror a tab the URL already agrees with', async () => {
      // The watch is guarded on `route.query.tab !== tab` (.vue:302); the ref
      // never changes on this mount, so nothing should be replaced.
      routeQuery = { tab: 'past' }
      mount()
      await flush()

      // Pinned that the mount really did land on past first -- otherwise
      // `replace` not firing proves nothing but a dead component.
      expect(activeTabLabel()).toBe('Прошедшие')
      expect(replace).not.toHaveBeenCalled()
    })

    it('treats any other ?tab value as «Предстоящие», not as an error', async () => {
      // `=== 'past' ? 'past' : 'upcoming'` (.vue:199) -- a hand-edited URL must
      // land somewhere sane rather than on a blank third tab.
      routeQuery = { tab: 'nonsense' }
      mount()
      await flush()

      expect(activeTabLabel()).toBe('Предстоящие')
      expect(cardTitles()).toEqual(['Сегодняшняя', 'Завтрашняя', 'Черновик'])
    })

    it('switching swaps the LIST, not just the highlight', async () => {
      mount()
      await flush()

      tab('Прошедшие')?.click()
      await flush()

      expect(activeTabLabel()).toBe('Прошедшие')
      expect(cardTitles()).toEqual(['Недавняя', 'Давняя'])
      expect(cardTitles()).not.toContain('Завтрашняя')
    })

    it('switching back returns the upcoming list', async () => {
      await mountOnPast()

      tab('Предстоящие')?.click()
      await flush()

      expect(cardTitles()).toEqual(['Сегодняшняя', 'Завтрашняя', 'Черновик'])
    })

    it('mirrors the tab into the URL, PRESERVING the rest of the query', async () => {
      // A call-shape assertion, and the only kind possible: the URL is the
      // behaviour and nothing rendered can distinguish it. `{ ...route.query }`
      // (.vue:303) is the load-bearing half -- drop the spread and this
      // replace() silently eats every other param on the route.
      routeQuery = { from: 'dashboard' }
      mount()
      await flush()

      tab('Прошедшие')?.click()
      await flush()

      expect(replace).toHaveBeenCalledWith({ query: { from: 'dashboard', tab: 'past' } })
    })

    it('fetches each bucket ONCE on first activation, never again on repeat switches (T22-3/T22-5, ПРОМТ №561)', async () => {
      // Was "does NOT re-fetch ... one dataset partitioned client-side": that
      // premise is gone by design -- the two tabs are now two independent
      // server queries (ensureBucketLoaded, .vue), each fetched lazily ON
      // ACTIVATION. What must still hold is the guard: a bucket already
      // loaded is never re-fetched, which is what protects the master's
      // «Показать ещё» progress from being reset by a stray tab tap.
      mount()
      await flush()
      expect(mastersApi.getMyPractices).toHaveBeenCalledTimes(1) // upcoming, first activation

      tab('Прошедшие')?.click()
      await flush()
      expect(mastersApi.getMyPractices).toHaveBeenCalledTimes(2) // past, first activation
      expect(cards()).toHaveLength(2)

      tab('Предстоящие')?.click()
      await flush()
      expect(mastersApi.getMyPractices).toHaveBeenCalledTimes(2) // upcoming already loaded -- no re-fetch

      tab('Прошедшие')?.click()
      await flush()
      expect(mastersApi.getMyPractices).toHaveBeenCalledTimes(2) // past already loaded -- no re-fetch
      expect(cards()).toHaveLength(2)
    })
  })

  // ===========================================================================
  describe('what each tab filters', () => {
    it('upcoming admits draft, scheduled AND live -- all three', async () => {
      mount()
      await flush()

      expect(cardTitles()).toEqual(['Сегодняшняя', 'Завтрашняя', 'Черновик'])
    })

    it('upcoming excludes completed practices', async () => {
      mount()
      await flush()

      // The positive pin comes FIRST, and it is not decoration: `not.toContain`
      // on an empty list always passes, so a mount that silently rendered
      // nothing would make every exclusion assertion in this block vacuous.
      expect(cardTitles()).toEqual(['Сегодняшняя', 'Завтрашняя', 'Черновик'])
      expect(cardTitles()).not.toContain('Недавняя')
      expect(cardTitles()).not.toContain('Давняя')
    })

    it('past admits completed ONLY', async () => {
      await mountOnPast()

      expect(cardTitles()).toEqual(['Недавняя', 'Давняя'])
      expect(cardTitles()).not.toContain('Сегодняшняя')
      expect(cardTitles()).not.toContain('Черновик')
    })

    it('a CANCELLED practice appears in NEITHER tab', async () => {
      // .vue:9-11,210-212 -- a cancelled practice did not happen, so it is not
      // upcoming and it is not history. Its date (2026-07-22) sits inside the
      // upcoming window, so a leak would land it mid-list, not off the end.
      mount()
      await flush()
      // Both tabs are pinned to their FULL expected list, not just probed for
      // absence: an exclusion assertion over an empty list cannot fail.
      expect(cardTitles()).toEqual(['Сегодняшняя', 'Завтрашняя', 'Черновик'])
      expect(cardTitles()).not.toContain('Отменённая')

      tab('Прошедшие')?.click()
      await flush()

      expect(cardTitles()).toEqual(['Недавняя', 'Давняя'])
      expect(cardTitles()).not.toContain('Отменённая')
    })

    it('a DELETED practice appears in NEITHER tab', async () => {
      // Neither filter names `deleted` (.vue:206,214), so it falls out of both
      // by omission rather than by decision -- worth pinning, because the day
      // someone widens the upcoming filter to "not completed" it comes back.
      mount()
      await flush()
      expect(cardTitles()).toEqual(['Сегодняшняя', 'Завтрашняя', 'Черновик'])
      expect(cardTitles()).not.toContain('Удалённая')

      tab('Прошедшие')?.click()
      await flush()

      expect(cardTitles()).toEqual(['Недавняя', 'Давняя'])
      expect(cardTitles()).not.toContain('Удалённая')
    })

    it('A4 V5: a status=live practice whose time has already ended does not show as upcoming', async () => {
      // The backend has not YET run autofinalize (status is still 'live'
      // server-side) -- the frontend must not wait for that round-trip to
      // stop calling it "Предстоящие". U_JUST_ENDED ends AT the frozen
      // instant exactly (practiceHasEnded's own boundary: nowMs >= end).
      mockBucketedPractices([U_LIVE, U_SCHED, U_DRAFT, U_JUST_ENDED])
      mount()
      await flush()

      expect(cardTitles()).toEqual(['Сегодняшняя', 'Завтрашняя', 'Черновик'])
      expect(cardTitles()).not.toContain('Только что закончилась')
    })

    it('A4 V5: a DRAFT past its scheduled_at is NOT swept by the time filter -- only scheduled/live are', async () => {
      // The clock filter is deliberately narrower than Dashboard's: a draft's
      // scheduled_at going stale is not something the backend's autofinalize
      // worker ever resolves (drafts are never live), so it must stay visible
      // until the master publishes or deletes it.
      const staleDraft = practice('u-stale-draft', {
        title: 'Старый черновик',
        status: 'draft',
        scheduled_at: '2026-07-01T09:00:00Z', // 19 days before NOW
      })
      mockBucketedPractices([staleDraft])
      mount()
      await flush()

      expect(cardTitles()).toEqual(['Старый черновик'])
    })

    it('A4 V5: the 60s clock drops a card the moment its practice ends, without a re-fetch', async () => {
      // The whole point of `now` being a REACTIVE ref on a 60s interval,
      // mirroring MasterDashboardView's nearestPractices clock test: a master
      // who leaves the list open must not keep seeing a practice that ended
      // while they were looking at it -- and this must NOT require a second
      // getMyPractices call (the store's cache is untouched; only the LOCAL
      // filter re-evaluates).
      const aboutToEnd = practice('u-about-to-end', {
        title: 'Скоро закончится',
        status: 'live',
        scheduled_at: '2026-07-20T11:14:00Z',
        duration_minutes: 60, // ends 12:14Z -- one minute after NOW (12:00Z)
      })
      mockBucketedPractices([aboutToEnd])
      mount()
      await flush()
      expect(cardTitles()).toEqual(['Скоро закончится'])
      const fetchCallsBeforeTick = vi.mocked(mastersApi.getMyPractices).mock.calls.length

      vi.setSystemTime(new Date('2026-07-20T12:15:00Z'))
      await vi.advanceTimersByTimeAsync(60_000)
      await flush()

      expect(cardTitles()).toEqual([])
      expect(vi.mocked(mastersApi.getMyPractices).mock.calls.length).toBe(fetchCallsBeforeTick)
    })
  })

  // ===========================================================================
  describe('ordering', () => {
    it('upcoming is ascending -- soonest first', async () => {
      // ALL is shuffled (u-draft, p-recent, x-cancelled, u-live, ...): the API
      // order is not the screen order.
      mount()
      await flush()

      expect(cardTitles()).toEqual(['Сегодняшняя', 'Завтрашняя', 'Черновик'])
    })

    it('past is descending -- newest first', async () => {
      await mountOnPast()

      expect(cardTitles()).toEqual(['Недавняя', 'Давняя'])
    })

    it('renders the SERVER order verbatim -- no client re-sort (T22-3/T22-5, ПРОМТ №561)', async () => {
      // Was CR-1 ("orders by LOCAL wall-clock"): the view used to re-derive its
      // own order via localSortKey, comparing each practice's wall-clock in ITS
      // OWN timezone. That client-side re-sort is gone by owner decision --
      // "leaving it in place would hide the next ordering bug from us" -- the
      // server now owns ordering entirely (listing_service.py's bucket
      // ordering). This test proves the negative: two practices whose absolute
      // (UTC) order and local-wall-clock order DISAGREE are rendered in
      // whatever order the fake server returned them, unchanged.
      //   AUCKLAND  20:00Z, tz +12 -> local wall-clock 08:00 on 23 July
      //   LONDON    22:00Z, tz UTC -> local wall-clock 22:00 on 22 July
      // By local wall-clock, LONDON would sort first (22 July before 23 July)
      // -- the old CR-1 assertion. The server returns them ascending by the
      // absolute instant instead (AUCKLAND 20:00Z < LONDON 22:00Z), and the
      // view must preserve exactly that order.
      const AUCKLAND = practice('tz-akl', {
        title: 'Окленд',
        scheduled_at: '2026-07-22T20:00:00Z',
        timezone: 'Pacific/Auckland',
      })
      const LONDON = practice('tz-lon', {
        title: 'Лондон',
        scheduled_at: '2026-07-22T22:00:00Z',
        timezone: 'UTC',
      })
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(page([AUCKLAND, LONDON]))
      mount()
      await flush()

      expect(cardTitles()).toEqual(['Окленд', 'Лондон'])
      // Proof the premise holds -- the rendered times really are the ones the
      // local-wall-clock ordering (now retired) would have disagreed on.
      expect(subOf(cardById('Окленд')!)).toContain('08:00')
      expect(subOf(cardById('Лондон')!)).toContain('22:00')
    })
  })

  // ===========================================================================
  describe('the upcoming card', () => {
    it('reads «Завтра, 09:00 • 60 мин» -- relative day, own timezone, duration', async () => {
      mount()
      await flush()

      expect(subOf(cardById('Завтрашняя')!)).toBe('Завтра, 09:00 • 60 мин')
    })

    it('reads «Сегодня» for a practice later today', async () => {
      mount()
      await flush()

      expect(subOf(cardById('Сегодняшняя')!)).toBe('Сегодня, 15:00 • 60 мин')
    })

    it('falls back to the compact date beyond tomorrow', async () => {
      // whenLabel (.vue:227-230): only Сегодня/Завтра are relative; everything
      // else goes through formatShortDate's VELO month table.
      mount()
      await flush()

      expect(subOf(cardById('Черновик')!)).toBe('25 июля, 10:00 • 60 мин')
    })

    it("renders each card in its OWN timezone, not the viewer's", async () => {
      const TOKYO = practice('tz-tyo', {
        title: 'Токио',
        scheduled_at: '2026-07-21T00:00:00Z',
        timezone: 'Asia/Tokyo',
      })
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(page([TOKYO]))
      mount()
      await flush()

      // 00:00Z on the 21st is 09:00 on the 21st in Tokyo (+9) -- and the 21st
      // is Завтра in Tokyo too, since NOW is 21:00 there on the 20th.
      expect(subOf(cardById('Токио')!)).toBe('Завтра, 09:00 • 60 мин')
    })

    it('shows participants as «N/M» against the cap', async () => {
      mount()
      await flush()

      expect(statsOf(cardById('Завтрашняя')!)[0]).toBe('5/20')
    })

    it('drops the denominator entirely when there is no cap', async () => {
      // `max_participants != null` (.vue:233) -- «5/null» or a fabricated cap
      // would both be lies about an uncapped practice.
      const UNCAPPED = practice('u-uncapped', {
        title: 'Без лимита',
        max_participants: null,
        current_participants: 7,
      })
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(page([UNCAPPED]))
      mount()
      await flush()

      expect(statsOf(cardById('Без лимита')!)[0]).toBe('7')
    })

    it('shows the check-in count as «N/M» when the owner is entitled to it', async () => {
      const WITH_CHECKINS = practice('u-ci', {
        title: 'С чекинами',
        checkin_count: 3,
        max_participants: 10,
        current_participants: 8,
      })
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(page([WITH_CHECKINS]))
      mount()
      await flush()

      expect(statsOf(cardById('С чекинами')!)).toEqual(['8/10', '3/10'])
    })

    it('renders a REAL zero check-in count as «0/10», not as nothing', async () => {
      // practiceCardMeta.ts:32-36 draws the line at null, not at falsy. Nobody
      // has checked in yet IS information; hiding it would read as "no data".
      const ZERO = practice('u-zero', {
        title: 'Ноль чекинов',
        checkin_count: 0,
        max_participants: 10,
        current_participants: 4,
      })
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(page([ZERO]))
      mount()
      await flush()

      expect(statsOf(cardById('Ноль чекинов')!)).toEqual(['4/10', '0/10'])
    })

    it('omits the check-in chip when the count is null', async () => {
      // The ALL fixtures carry no checkin_count at all -> undefined -> `== null`
      // -> chip omitted (.vue:95). Participants is then the only chip.
      mount()
      await flush()

      expect(statsOf(cardById('Завтрашняя')!)).toEqual(['5/20'])
    })

    it('falls back to the participant count as the check-in denominator when uncapped', async () => {
      // `max_participants ?? current_participants` (practiceCardMeta.ts:34).
      const UNCAPPED_CI = practice('u-unci', {
        title: 'Чекины без лимита',
        checkin_count: 2,
        max_participants: null,
        current_participants: 6,
      })
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(page([UNCAPPED_CI]))
      mount()
      await flush()

      expect(statsOf(cardById('Чекины без лимита')!)).toEqual(['6', '2/6'])
    })

    it('names the recurrence days for a series that has them', async () => {
      const SERIES = practice('u-series', {
        title: 'Серия',
        practice_type: 'series',
        recurrence_days: [5, 1, 3],
      })
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(page([SERIES]))
      mount()
      await flush()

      // De-duplicated and re-ordered Mon->Sun by recurrenceDaysLabel, so the
      // shuffled [5,1,3] must come back as «Пн, Ср, Пт».
      expect(statsOf(cardById('Серия')!)).toEqual(['5/20', 'Пн, Ср, Пт'])
    })

    it('falls back to «Регулярная» for a series with no day list', async () => {
      const SERIES = practice('u-series2', {
        title: 'Серия без дней',
        practice_type: 'series',
        recurrence_days: null,
      })
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(page([SERIES]))
      mount()
      await flush()

      expect(statsOf(cardById('Серия без дней')!)).toEqual(['5/20', 'Регулярная'])
    })

    it('shows no recurrence chip on a one-off practice', async () => {
      // `practice_type !== 'series'` (practiceCardMeta.ts:41) -- a single live
      // practice with recurrence_days set must still not claim to repeat.
      const NOISY = practice('u-noisy', {
        title: 'Разовая',
        practice_type: 'live',
        recurrence_days: [1, 2],
      })
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(page([NOISY]))
      mount()
      await flush()

      expect(statsOf(cardById('Разовая')!)).toEqual(['5/20'])
    })

    it('counts the remaining sessions of a series on its own second row', async () => {
      const SERIES = practice('u-series3', {
        title: 'Курс',
        practice_type: 'series',
        total_sessions: 8,
        completed_sessions: 3,
      })
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(page([SERIES]))
      mount()
      await flush()

      const row2 = cardById('Курс')!.querySelector('.mp-card__meta--row2')
      expect(tidy(row2?.textContent)).toBe('Осталось 5 из 8 занятий')
    })

    it('floors the remaining sessions at zero rather than going negative', async () => {
      // `Math.max(0, total - completed)` (practiceCardMeta.ts:49) -- an
      // over-counted series must not read «Осталось -2 из 8 занятий».
      const OVERRUN = practice('u-series4', {
        title: 'Перебор',
        practice_type: 'series',
        total_sessions: 8,
        completed_sessions: 10,
      })
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(page([OVERRUN]))
      mount()
      await flush()

      expect(tidy(cardById('Перебор')!.querySelector('.mp-card__meta--row2')?.textContent)).toBe(
        'Осталось 0 из 8 занятий',
      )
    })

    it('omits the second row when the session count is unknown', async () => {
      mount()
      await flush()

      expect(cardById('Завтрашняя')!.querySelector('.mp-card__meta--row2')).toBeNull()
    })
  })

  // ===========================================================================
  describe('the past card', () => {
    it("reads «date • N участников», not the upcoming card's N/M", async () => {
      await mountOnPast()

      expect(subOf(cardById('Недавняя')!)).toBe('18 июля • 5 участников')
    })

    it('agrees the Russian plural across the cases that actually break', async () => {
      // participantsCount (.vue:239-247) is hand-rolled, and its edges are the
      // ones a naive `n === 1` gets wrong: 11 is «участников» (not «участник»)
      // while 21 IS «участник»; 14 is «участников» while 4 is «участника».
      const N = (n: number) =>
        practice(`c${n}`, {
          title: `Счёт ${n}`,
          status: 'completed',
          scheduled_at: '2026-07-18T12:00:00Z',
          current_participants: n,
        })
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(
        page([N(0), N(1), N(2), N(4), N(5), N(11), N(14), N(21), N(22)]),
      )
      await mountOnPast()

      const said = (n: number) => subOf(cardById(`Счёт ${n}`)!).split('• ')[1]
      expect(said(0)).toBe('0 участников')
      expect(said(1)).toBe('1 участник')
      expect(said(2)).toBe('2 участника')
      expect(said(4)).toBe('4 участника')
      expect(said(5)).toBe('5 участников')
      expect(said(11)).toBe('11 участников')
      expect(said(14)).toBe('14 участников')
      expect(said(21)).toBe('21 участник')
      expect(said(22)).toBe('22 участника')
    })

    it('renders each card its OWN rating percentages from the insights cache', async () => {
      // p-recent 3/1/1 of 5 -> 60/20/20; p-old 1/2/1 of 4 -> 25/50/25. Distinct
      // on every bucket, so a card reading the wrong practice's insights fails.
      await mountOnPast()

      expect(badgesOf(cardById('Недавняя')!)).toEqual(['60%', '20%', '20%'])
      expect(badgesOf(cardById('Давняя')!)).toEqual(['25%', '50%', '25%'])
    })

    it('shows no badges on a practice whose insights never arrived', async () => {
      // `insightsCache.has(id)` (.vue:259-261). An absent fetch must not render
      // as a 0/0/0 verdict on the master's work.
      vi.mocked(diaryApi.getPracticeInsights).mockImplementation(async (id: string) => {
        const found = INSIGHTS[id]
        if (!found || id === 'p-old') throw new ApiResponseError(404, 'Нет данных', 'nope')
        return found
      })
      await mountOnPast()

      expect(badgesOf(cardById('Недавняя')!)).toEqual(['60%', '20%', '20%'])
      expect(badgesOf(cardById('Давняя')!)).toEqual([])
    })

    it('shows no badges when insights arrived but nobody left feedback', async () => {
      // `totalFeedbacks(id) > 0` (.vue:260) -- a practice that ran but drew no
      // feedback would otherwise show a confident 0%/0%/0% trio.
      vi.mocked(diaryApi.getPracticeInsights).mockImplementation(async (id: string) =>
        insights(id, 5, { fire: 0, good: 0, confused: 0 }),
      )
      await mountOnPast()

      expect(cards()).toHaveLength(2)
      expect(badgesOf(cardById('Недавняя')!)).toEqual([])
    })

    it('survives a total insights outage -- the cards still render', async () => {
      vi.mocked(diaryApi.getPracticeInsights).mockRejectedValue(new TypeError('boom'))
      await mountOnPast()

      expect(cardTitles()).toEqual(['Недавняя', 'Давняя'])
      expect(text()).not.toContain('Не удалось загрузить практики')
    })
  })

  // ===========================================================================
  describe('insights are fetched for the PAST tab only (E12)', () => {
    it('the upcoming tab skips the insights round-trip entirely', async () => {
      // .vue:275-278 short-circuits on `activeTab !== 'past'`. The only
      // observable: nothing on the upcoming card is insights-derived any more
      // (the check-in badge reads checkin_count off the practice since ПРОМТ
      // №419), so a leaked fetch would be invisible in the DOM and cost every
      // master an N-request storm on their default tab.
      mount()
      await flush()

      expect(cards()).toHaveLength(3)
      expect(diaryApi.getPracticeInsights).not.toHaveBeenCalled()
    })

    it('switching to past fetches insights for the past practices, and only those', async () => {
      await mountOnPast()

      expect(diaryApi.getPracticeInsights).toHaveBeenCalledWith('p-recent')
      expect(diaryApi.getPracticeInsights).toHaveBeenCalledWith('p-old')
      // Not for the upcoming or the filtered-out ones: loadTabInsights maps
      // pastPractices, not practices (.vue:277).
      expect(diaryApi.getPracticeInsights).not.toHaveBeenCalledWith('u-sched')
      expect(diaryApi.getPracticeInsights).not.toHaveBeenCalledWith('x-cancelled')
      expect(diaryApi.getPracticeInsights).toHaveBeenCalledTimes(2)
    })

    it('mounting straight onto ?tab=past loads them without a click', async () => {
      routeQuery = { tab: 'past' }
      mount()
      await flush()

      expect(badgesOf(cardById('Недавняя')!)).toEqual(['60%', '20%', '20%'])
    })
  })

  // ===========================================================================
  describe('«Показать ещё»', () => {
    it('is absent when the first page is everything', async () => {
      // hasMore is `offset < total` (usePagination.ts:35); 7 of 7 -> no button.
      mount()
      await flush()

      expect(buttonWith('Показать ещё')).toBeUndefined()
    })

    it('pages from the offset and APPENDS, rather than replacing', async () => {
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(page([U_SCHED], 2, 0))
      mount()
      await flush()
      expect(buttonWith('Показать ещё')).toBeDefined()

      const NEXT = practice('u-next', {
        title: 'Догруженная',
        scheduled_at: '2026-07-26T10:00:00Z',
      })
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(page([NEXT], 2, 1))
      buttonWith('Показать ещё')?.click()
      await flush()

      expect(mastersApi.getMyPractices).toHaveBeenLastCalledWith('upcoming', 20, 1)
      expect(cardTitles()).toEqual(['Завтрашняя', 'Догруженная'])
      expect(buttonWith('Показать ещё')).toBeUndefined()
    })

    it('loads the insights of the newly paged-in past practices', async () => {
      // onLoadMore re-runs loadTabData (.vue:295-298), or the new cards sit
      // there badge-less until something else re-triggers it.
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(page([P_RECENT], 2, 0))
      await mountOnPast()

      const NEXT = practice('p-next', {
        title: 'Догруженная прошедшая',
        status: 'completed',
        scheduled_at: '2026-07-05T10:00:00Z',
      })
      INSIGHTS['p-next'] = insights('p-next', 4, { fire: 2, good: 2, confused: 0 })
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(page([NEXT], 2, 1))

      buttonWith('Показать ещё')?.click()
      await flush()

      expect(cardTitles()).toEqual(['Недавняя', 'Догруженная прошедшая'])
      expect(badgesOf(cardById('Догруженная прошедшая')!)).toEqual(['50%', '50%', '0%'])
      delete INSIGHTS['p-next']
    })

    it('keeps the loaded list visible while the next page is in flight', async () => {
      // The loading rung is guarded on `practices.length === 0` (.vue:50), so a
      // load-more must NOT blank the screen into a full-page loader -- the
      // button carries its own spinner instead (.vue:161).
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(page([U_SCHED], 2, 0))
      mount()
      await flush()

      vi.mocked(mastersApi.getMyPractices).mockReturnValue(new Promise(() => {}))
      buttonWith('Показать ещё')?.click()
      await flush()

      expect(loader()).toBeNull()
      expect(cardTitles()).toEqual(['Завтрашняя'])
      expect(host?.querySelector('.v-btn--loading')).not.toBeNull()
    })

    it('a FAILED load-more KEEPS the list and tells the master (fixed №441)', async () => {
      // Was the tripwire for a REAL DEFECT found in №440, fixed in №441. The
      // error rung had no `&& practices.length === 0` guard (.vue:57) while its
      // loading twin one line above (.vue:50) did, so a blipped «Показать ещё»
      // replaced the practices the master was reading with a full-screen error
      // -- while usePagination still held them, intact (usePagination.ts:67-70).
      //
      // The guard alone would have traded that loud-wrong behaviour for a SILENT
      // one (list stays, failure never surfaces -- which is what MyBookingsView
      // actually does). So this follows the admin lists instead
      // (AdminPromosView.vue:219-221): keep the list AND toast. Both halves are
      // asserted below; drop either and this test fails.
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(page([U_SCHED], 2, 0))
      mount()
      await flush()
      expect(cardTitles()).toEqual(['Завтрашняя'])

      vi.mocked(mastersApi.getMyPractices).mockRejectedValue(
        new ApiResponseError(503, 'Сеть недоступна', 'net_down'),
      )
      buttonWith('Показать ещё')?.click()
      await flush()

      // The list SURVIVES -- no full-screen error swap.
      expect(cardTitles()).toEqual(['Завтрашняя'])
      expect(text()).not.toContain('Не удалось загрузить практики')

      // ...and the master is TOLD, with the real backend message, not silently.
      expect(toastError).toHaveBeenCalledWith('Сеть недоступна')

      // The store's data was never the problem and still is not.
      expect(useMasterStore().practices.map((p) => p.title)).toEqual(['Завтрашняя'])
    })

    it('the error rung is initial-load-only: an error over a POPULATED list never hides it', async () => {
      // This drives the store directly (Pattern A) rather than through the
      // load-more path, and it has to: onLoadMore nulls the error immediately
      // after toasting, so the template never observes it truthy and the
      // `&& practices.length === 0` guard (.vue:57) looks redundant from that
      // angle -- a mutation removing the guard still passed the toast tests.
      //
      // The guard is what makes the behaviour structural instead of dependent on
      // Vue's scheduler racing the clear. Setting the state the template reads is
      // the only way to prove it: error truthy + list non-empty => list wins.
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(page([U_SCHED], 2, 0))
      mount()
      await flush()

      useMasterStore().practicesUpcomingError = 'Сеть недоступна'
      await flush()

      expect(cardTitles()).toEqual(['Завтрашняя'])
      expect(text()).not.toContain('Не удалось загрузить практики')
    })

    it('the error rung STILL renders when the list is empty (the guard is not a blanket mute)', async () => {
      // The other side of the guard, so it cannot be "fixed" by deleting the rung.
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(page([], 0, 0))
      mount()
      await flush()

      useMasterStore().practicesUpcomingError = 'Сеть недоступна'
      await flush()

      expect(text()).toContain('Не удалось загрузить практики')
      expect(text()).toContain('Сеть недоступна')
    })

    it('routes a load-more failure to loadMoreError, never to the rung error (№442 root fix)', async () => {
      // usePagination now splits the two failures at the source (usePagination.ts:
      // `error` = first page, `loadMoreError` = later page), so the screen no
      // longer has to null anything out by hand. `practicesError` staying null is
      // the proof the rung can never be primed by a page-N failure -- that used to
      // be one shared ref, which is what produced the destroy-the-list bug.
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(page([U_SCHED], 2, 0))
      mount()
      await flush()

      vi.mocked(mastersApi.getMyPractices).mockRejectedValue(
        new ApiResponseError(503, 'Сеть недоступна', 'net_down'),
      )
      buttonWith('Показать ещё')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Сеть недоступна')
      expect(useMasterStore().practicesUpcomingError).toBeNull()
      expect(useMasterStore().practicesUpcomingLoadMoreError).toBe('Сеть недоступна')
    })

    it('clears loadMoreError on the next attempt, so a stale message cannot re-toast', async () => {
      // The composable resets it at the START of each loadMore -- the reason the
      // screen carries no manual clearing any more.
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(page([U_SCHED], 2, 0))
      mount()
      await flush()

      vi.mocked(mastersApi.getMyPractices).mockRejectedValue(
        new ApiResponseError(503, 'Сеть недоступна', 'net_down'),
      )
      buttonWith('Показать ещё')?.click()
      await flush()
      expect(useMasterStore().practicesUpcomingLoadMoreError).toBe('Сеть недоступна')

      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(
        page([practice('p-ok', { title: 'Догруженная', status: 'scheduled' })], 2, 1),
      )
      buttonWith('Показать ещё')?.click()
      await flush()

      expect(useMasterStore().practicesUpcomingLoadMoreError).toBeNull()
      expect(toastError).toHaveBeenCalledTimes(1)
    })
  })

  // ===========================================================================
  describe('navigation', () => {
    it('the header «+» opens the create screen', async () => {
      mount()
      await flush()

      addButton()?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'master-practice-new' })
    })

    it("the empty state's «Создать» goes to the same place", async () => {
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(page([]))
      mount()
      await flush()

      buttonWith('Создать')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'master-practice-new' })
    })

    it('tapping an upcoming card opens THAT practice', async () => {
      // The id is the whole assertion: cards render sorted, so the tapped card
      // is not the one at the API's index -- «Черновик» is third on screen and
      // FIRST in the response.
      mount()
      await flush()

      cardById('Черновик')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({
        name: 'master-practice-detail',
        params: { id: 'u-draft' },
      })
    })

    it('tapping a past card opens that practice too, not a reviews route', async () => {
      // Both tabs share goDetail (.vue:80,127) -- unlike AnalyticsView, whose
      // past cards go to master-practice-reviews. Easy to conflate.
      await mountOnPast()

      cardById('Давняя')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({
        name: 'master-practice-detail',
        params: { id: 'p-old' },
      })
    })

    it('every card is reachable by keyboard', async () => {
      // role="button" + tabindex=0 on an <article> (.vue:76-79): a div that
      // claims to be a button but cannot be activated by keyboard is a11y
      // theatre. Asserting the WIRING here, not Vue's key modifier.
      mount()
      await flush()

      const card = cardById('Завтрашняя')!
      expect(card.getAttribute('role')).toBe('button')
      expect(card.getAttribute('tabindex')).toBe('0')
    })
  })

  // ===========================================================================
  // NOT COVERED, deliberately
  //
  // - Keyboard ACTIVATION of a card (@keydown.enter.space.prevent, .vue:81,129):
  //   dispatching the event would assert Vue's withKeys modifier over a handler
  //   the click tests already pin. The wiring that CAN rot independently
  //   (role/tabindex) is asserted above. Same call the house precedent makes
  //   (AnalyticsView.test.ts).
  // - VSegmentTrack / VEmptyState / VRatingBadges / VButton / VLoader / VHeader
  //   internals: DS primitives with their own homes. Exercised here only
  //   through the values this screen feeds them and the DOM it gets back.
  // - VHeader's Teleport into `.mobile-layout__island`: disabled without a
  //   MobileLayout ancestor (useFloatingHeader.ts:34-36), so it is unexercised
  //   by any honest mount of this SFC alone. It belongs to a MobileLayout test.
  // - practiceIconFor's direction -> glyph table (.vue:84,132): displayHelpers'
  //   own ground, and already unit-tested territory. The fixtures carry no
  //   `direction`, so every card renders the IconDots fallback -- which is why
  //   no assertion here reads the icon.
  // - diaryStore.loadInsights' skip-if-cached guard and its LRU eviction
  //   (stores/diary.ts:363-380): store behaviour -> probekit-unit-test.
  // - usePagination's W17 requestId race (usePagination.ts:45-73): composable
  //   behaviour, and not reachable through this screen's controls.
  // - masterStatusGuard, which fronts this route: the guard layer ->
  //   guards.test.ts (velo-idiom §6).
  //
  // The SFC's header comment (.vue:13-28) promises three things the template
  // does NOT do, so there is nothing to test and nothing was faked:
  //   * «Изменить» + «Check-ins» buttons below the upcoming card -- no such
  //     controls exist (.vue:74-107).
  //   * ✓/✗ attendance badges inside the past card -- removed per PL-E1, as an
  //     inline comment 100 lines further down admits (.vue:135-137).
  //   * «осталось N из M» "omitted (no series-session field)" -- it is NOT
  //     omitted; .vue:102-106 renders it and PracticeResponse has both
  //     total_sessions and completed_sessions. Tested above.
  // Stale prose, reported as a doc finding.
  // ===========================================================================
})
