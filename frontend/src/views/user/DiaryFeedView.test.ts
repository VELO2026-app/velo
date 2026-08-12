// =============================================================================
// VELO Frontend -- DiaryFeedView Screen Tests
// =============================================================================
//
// WHY: the biggest screen in the user zone (902 lines) and the LAST known
// instance of the silent-load-more bug class chased all session -- and the worst
// instance: MyBookingsView at least had a «Показать ещё» button the user could
// tap again. Here page-N fires from an IntersectionObserver sentinel (.vue:583),
// so a failed older page left the user scrolling at a feed that simply never
// grew, with no control to retry and nothing on screen to explain it.
//
// This file's tripwire is what opened the gate on that fix: the screen was
// covered first (№443), then useCursorPagination was given the same
// error/loadMoreError split usePagination got in №442, and the tripwire went red
// on cue and was flipped. The feed now toasts. See "THE SPLIT" below.
//
// PATTERN A (store-backed): every rung lives in useDiaryStore (feedItems /
// feedLoading / feedError / feedHasMore / feedFilters via storeToRefs, .vue:282),
// so the seam is @/api/diary -- the wrapper the store imports. The store and its
// useCursorPagination are REAL; only the network boundary is faked. One pinia
// instance goes to BOTH setActivePinia and app.use (SC-03).
//
// TICKS = 8. Counted, not copied (SC-08). The mount chain is deeper than any
// screen in the table in velo-idiom §3:
//   onMounted -> fetchFeed -> feed.refresh -> feed.loadMore -> listDiaryFeed
//   (4 awaits) -> onMounted resumes -> await nextTick -> scroll restore ->
//   await nextTick -> setupObserver  (2 more) -> +1 final re-render = ~7.
// 8 is one over, which is harmless; the "attaches an observer" test below is the
// canary -- if the count were short, sentinelEl would still be null, no observer
// would exist, and that test fails loudly rather than silently skipping.
//
// TRAPS PRESENT:
//  - IntersectionObserver: happy-dom SHIPS one (typeof === 'function'), but it is
//    an inert shell -- probed it directly: construct + observe + 10 ticks + a
//    50ms timer = 0 callbacks, forever. It has no layout engine to intersect
//    with. This is nastier than a missing global: the screen's `new
//    IntersectionObserver(...)` succeeds, so a test that trusts the sentinel
//    would drive NOTHING and pass vacuously. Stubbed below with a capturing
//    class so the callback can be fired by hand. That is TEST setup; no product
//    code is touched, and the stub is installed/removed per test.
//  - SC-13: DiaryFilterModal + DiarySearchModal both wrap VModal, which teleports
//    `.v-modal__overlay` to document.body (VModal.vue:20-22). Purged in afterEach.
//    Queried off document.body, never off host (SC-07).
//  - SC-13c: overlay queries are scoped `:not(.v-modal-leave-active)` -- applying
//    a filter closes the modal mid-test and parks a corpse on document.body.
//  - SC-14 (the STRIP variant): the header title is ALWAYS mounted and its idle
//    text is literally «Дневник» -- which is ALSO a note card's title AND a
//    prefix of the empty state «Дневник пуст». `text()).toContain('Дневник')` can
//    therefore never fail. Every ladder assertion is scoped to `.diary-feed__body`
//    and the title is read off `.diary-feed__title` alone.
//  - SC-15: the ordering / filter tests pin the POSITIVE set with toEqual first,
//    so an exclusion cannot pass on a feed that rendered nothing.
//  - Wall clock: dayLabelOf (format.ts:174) calls `new Date()` for the
//    Сегодня/Вчера dividers, so time is pinned and every fixture is a literal
//    against it. Timezone is forced to UTC through the mocked auth store, so
//    the runner's local zone cannot drift the day keys.
//  - localStorage: DiaryComposer mirrors its draft to `velo:diary:draft:*` on
//    every keystroke and reads it back in onMounted; DiarySearchModal persists
//    recents. Both LEAK across tests -- cleared in beforeEach.
//
// TRAPS ABSENT (proved, so nobody cargo-cults the setup onto this file):
//  - NO money, NO formatMoney anywhere in this screen's chain -> the ru NBSP trap
//    (velo-idiom §11) does not apply. The one Intl string asserted here is the
//    day divider «10 июля»; codepoint-scanned it -- 0x20, a plain space, not
//    U+00A0. So no norm() helper: dead defensive code carrying a false
//    justification is worse than none.
//  - NO v-show on this screen (grepped) -- the ladder rungs are v-if/v-else-if,
//    genuinely mutually exclusive, so only the SC-14 strip variant above bites.
//  - NO VBottomSheet -> no `.v-sheet__overlay` to reap, only `.v-modal__overlay`.
//  - NO navigator.clipboard, NO window.location assignment, NO history.state
//    read, NO waitUntilReady in the chain.
//  - window.visualViewport is undefined in happy-dom; DiaryComposer reaches it
//    only through `?.` (DiaryComposer.vue:163,215), so it needs no stub.
//
// THE SPLIT (read before touching a failure assertion here):
// useCursorPagination routes a failure by WHICH page failed -- `error` when
// nothing is on screen (the rung is owed), `loadMoreError` when the feed is
// intact and must stay (a toast is owed). Before №443 it had one shared `error`
// for both, and the screen bound it in exactly one place, behind
// `v-else-if="feedError && items.length === 0"` (.vue:172) and nowhere else -- so
// a failed page-2 set feedError, rendered NOTHING, and the sentinel would not
// re-fire on its own. Two tests below hold that split from both sides: a page-N
// failure must toast and never touch the rung, and an INITIAL failure must fill
// the rung and never toast. The second is what stops the fix degenerating into a
// blanket redirect that silences the first page too.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, reactive, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import DiaryFeedView from '@/views/user/DiaryFeedView.vue'
import * as diaryApi from '@/api/diary'
// The REAL store, read where the assertion is about which ref a failure landed
// in -- the whole point of the error/loadMoreError split.
import { useDiaryStore } from '@/stores/diary'
// Stays REAL: vi.mock('@/api/diary') does not touch @/api/client, so the
// restore-failure test drives the real error class rather than a re-implemented
// one (velo-idiom §4).
import { ApiResponseError } from '@/api/client'
import type { DiaryFeedItem, DiaryFeedResponse } from '@/api/types'

vi.mock('@/api/diary')

const push = vi.fn()
const replace = vi.fn()
const back = vi.fn()

// The `deleted` query drives the undo bar through a watcher with immediate:true
// (.vue:500-511), so it must be REACTIVE and seeded BEFORE mount for that rung.
const routeQuery = reactive<{ deleted?: string | string[] }>({})

// PROMPT №657: real() kept via importOriginal -- DiaryFeedView now transitively
// imports the real @/router singleton (DiaryComposer -> useViewportGeometry ->
// @/router, for the K3f route-suppression hook -- PROMPT №666: was cited here
// as DiaryKeyboardDebugPanel's chain, but that component is deleted; the same
// transitive import survives independently through DiaryComposer's own
// `visibleHeight` import), which calls createRouter()/createWebHistory() at
// module load. A full replace-mock (the pre-№657 version here) has neither,
// so importing the router module under it throws. Additive mock: everything
// real EXCEPT useRouter/useRoute.
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({ push, replace, back }),
    useRoute: () => ({ query: routeQuery }),
  }
})

const toastError = vi.fn()
const toastInfo = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), info: toastInfo }),
}))

// Mocked wholesale behind a getter (velo-idiom §5): the REAL auth store imports
// @/platform eagerly, and this screen only reads user?.timezone off it.
const authState: { user: { timezone: string } | null } = { user: { timezone: 'UTC' } }
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    get user() {
      return authState.user
    },
  }),
}))

// -- IntersectionObserver capture stub ---------------------------------------
//
// happy-dom's own IO never fires (see the banner). This replaces it with a
// class that records the callback + observed targets so a test can fire the
// sentinel by hand. `disconnected` is tracked because the screen disconnects on
// unmount (.vue:613-617), and a stale instance from a previous mount must never
// be the one a test drives.

interface StubObserver {
  callback: IntersectionObserverCallback
  options: IntersectionObserverInit | undefined
  targets: Element[]
  disconnected: boolean
}

let observers: StubObserver[] = []

class CapturingIO implements StubObserver {
  callback: IntersectionObserverCallback
  options: IntersectionObserverInit | undefined
  targets: Element[] = []
  disconnected = false

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback
    this.options = options
    observers.push(this)
  }

  observe(el: Element): void {
    this.targets.push(el)
  }
  unobserve(el: Element): void {
    this.targets = this.targets.filter((t) => t !== el)
  }
  disconnect(): void {
    this.disconnected = true
    this.targets = []
  }
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

/** The observer the LIVE app owns. Throws rather than let a test no-op quietly. */
function liveObserver(): StubObserver {
  const live = observers.filter((o) => !o.disconnected)
  if (live.length !== 1) {
    throw new Error(`expected exactly 1 live IntersectionObserver, found ${live.length}`)
  }
  return live[0]!
}

/** Drive the top sentinel into view -- the only way page-N is ever requested. */
function fireSentinel(isIntersecting = true): void {
  const io = liveObserver()
  const target = io.targets[0]
  if (!target) throw new Error('the observer is not observing the sentinel')
  io.callback(
    [{ isIntersecting, target } as unknown as IntersectionObserverEntry],
    io as unknown as IntersectionObserver,
  )
}

// -- Fixtures ----------------------------------------------------------------

// Frozen instant. Fixtures are literals against it: 07-16 = «Сегодня»,
// 07-15 = «Вчера», 07-10 = «10 июля».
const NOW = new Date('2026-07-16T12:00:00Z')

function feedItem(
  id: string,
  kind: string,
  occurred_at: string,
  snapshot: Record<string, unknown> = {},
): DiaryFeedItem {
  return {
    id,
    kind,
    occurred_at,
    source_type: 'diary_entry',
    source_id: `src_${id}`,
    snapshot,
    created_at: occurred_at,
  }
}

/** The feed is newest-first; `next_cursor: null` marks the end (api/diary.ts:205). */
function page(items: DiaryFeedItem[], next_cursor: string | null = null): DiaryFeedResponse {
  return { items, next_cursor }
}

const NOTE = feedItem('n1', 'note', '2026-07-16T10:00:00Z', {
  content_preview: 'Сегодня было спокойно',
})

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(DiaryFeedView)
  app.use(pinia)
  app.mount(host)
  return host
}

// 8 ticks -- counted in the banner, not copied.
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await nextTick()
}

/** The feed pane ONLY. The header title «Дневник» is always mounted (SC-14). */
function feedBody(): HTMLElement {
  const el = host?.querySelector<HTMLElement>('.diary-feed__body')
  if (!el) throw new Error('.diary-feed__body did not render')
  return el
}

function bodyText(): string {
  return feedBody().textContent ?? ''
}

function headerTitle(): string {
  return host?.querySelector('.diary-feed__title')?.textContent?.trim() ?? ''
}

/** Standard-card titles in render order (oldest -> newest, DiaryList reverses). */
function cardTitles(): string[] {
  return Array.from(feedBody().querySelectorAll('.feed-card__title')).map(
    (e) => e.textContent?.trim() ?? '',
  )
}

function cardPreviews(): string[] {
  return Array.from(feedBody().querySelectorAll('.feed-card__preview')).map(
    (e) => e.textContent?.trim() ?? '',
  )
}

function dayDividers(): string[] {
  return Array.from(feedBody().querySelectorAll('.diary-list__divider span')).map(
    (e) => e.textContent?.trim() ?? '',
  )
}

/** Live overlay only -- a closed one parks at .v-modal-leave-active (SC-13c). */
function liveModal(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('.v-modal__overlay:not(.v-modal-leave-active)')
}

function buttonIn(root: ParentNode, text: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim() === text)
}

/** The "..." kebab. Its items only exist in the DOM while the panel is open. */
function openKebab(): void {
  host?.querySelector<HTMLButtonElement>('.v-menu__trigger')?.click()
}

beforeEach(() => {
  vi.setSystemTime(NOW)
  vi.stubGlobal('IntersectionObserver', CapturingIO)
  observers = []
  localStorage.clear()
  authState.user = { timezone: 'UTC' }
  for (const k of Object.keys(routeQuery)) delete (routeQuery as Record<string, unknown>)[k]
  pinia = createPinia()
  setActivePinia(pinia)
  vi.mocked(diaryApi.listDiaryFeed).mockReset().mockResolvedValue(page([]))
  vi.mocked(diaryApi.restoreDiaryEntry).mockReset()
  vi.mocked(diaryApi.createDiaryEntry).mockReset()
  push.mockReset()
  replace.mockReset()
  back.mockReset()
  toastError.mockReset()
  toastInfo.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null

  // A CLOSED teleported overlay survives unmount: the <Transition> leave awaits a
  // transitionend happy-dom never fires (SC-13). Without this the first modal
  // test passes and every later one clicks a corpse.
  document.body.querySelectorAll('.v-modal__overlay').forEach((el) => el.remove())

  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('DiaryFeedView', () => {
  describe('state ladder', () => {
    it('initial load: shows the full-screen loader while the first page is in flight', async () => {
      // Never resolves -> feedLoading stays true with an empty list, which is
      // exactly `initialLoading` (.vue:288).
      vi.mocked(diaryApi.listDiaryFeed).mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(feedBody().querySelector('.diary-feed__state')).not.toBeNull()
      expect(bodyText()).not.toContain('Дневник пуст')
      expect(bodyText()).not.toContain('Не удалось загрузить дневник')
    })

    it('error: shows the error rung when the FIRST page fails', async () => {
      vi.mocked(diaryApi.listDiaryFeed).mockRejectedValue(new Error('Сервис недоступен'))
      mount()
      await flush()

      expect(bodyText()).toContain('Не удалось загрузить дневник')
      expect(feedBody().querySelector('.diary-feed__state')).toBeNull()
    })

    it('error: the REAL backend message never reaches the DOM -- the copy is hardcoded', async () => {
      // SC-05. useCursorPagination stores e.message verbatim (.ts:61), but unlike
      // MyBookingsView (which binds :description="store.error") this screen hard-
      // codes «Проверьте соединение и попробуйте ещё раз» (.vue:175). So the rung
      // shows, and the reason is dropped. Pinning both halves so nobody reads the
      // rung above as proof that error propagation works -- it does not.
      vi.mocked(diaryApi.listDiaryFeed).mockRejectedValue(new Error('Сервис недоступен'))
      mount()
      await flush()

      const store = useDiaryStore()
      expect(store.feedError).toBe('Сервис недоступен')
      expect(bodyText()).toContain('Проверьте соединение и попробуйте ещё раз')
      expect(bodyText()).not.toContain('Сервис недоступен')
    })

    it('error retry: «Повторить» re-fetches and replaces the rung with content', async () => {
      vi.mocked(diaryApi.listDiaryFeed).mockRejectedValue(new Error('Сервис недоступен'))
      mount()
      await flush()

      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(page([NOTE]))
      const retry = buttonIn(feedBody(), 'Повторить')
      expect(retry).toBeDefined()
      retry?.click()
      await flush()

      expect(bodyText()).not.toContain('Не удалось загрузить дневник')
      expect(cardPreviews()).toEqual(['Сегодня было спокойно'])
    })

    it('empty: shows the empty state when the feed is genuinely empty', async () => {
      mount()
      await flush()

      expect(bodyText()).toContain('Дневник пуст')
      expect(feedBody().querySelector('.feed-card')).toBeNull()
    })

    it('content: renders what the store actually returned', async () => {
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(page([NOTE]))
      mount()
      await flush()

      expect(cardPreviews()).toEqual(['Сегодня было спокойно'])
      expect(bodyText()).not.toContain('Дневник пуст')
    })
  })

  describe('feed item kinds', () => {
    it('maps each kind onto its own card form, title and label', async () => {
      // Given newest-first (the backend contract); DiaryList renders the reverse.
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(
        page([
          feedItem('f1', 'feedback', '2026-07-16T11:00:00Z', { rating: 9 }),
          feedItem('c1', 'checkin', '2026-07-16T10:30:00Z', { mood: 9 }),
          feedItem('d1', 'dream', '2026-07-16T10:00:00Z', { content_preview: 'Летал во сне' }),
          feedItem('n1', 'note', '2026-07-16T09:00:00Z', { content_preview: 'Спокойно' }),
          feedItem('p1', 'practice_outcome', '2026-07-16T08:00:00Z', {
            practice_title: 'Утренняя йога',
            outcome_status: 'attended',
            scheduled_at: '2026-07-16T08:00:00Z',
            duration_minutes: 60,
          }),
          feedItem('b1', 'booking_confirmed', '2026-07-16T07:00:00Z', {
            practice_title: 'Вечерняя медитация',
          }),
        ]),
      )
      mount()
      await flush()

      // Standard cards: mood/rating SCORES resolve to labels through the
      // score->zone->label chain (9 -> high -> «Хорошо», 9 -> fire -> «Огонь!»).
      // toEqual pins order too: oldest first, newest last (chat-mode).
      expect(cardTitles()).toEqual(['Дневник', 'Сонник', 'Check-in: Хорошо', 'Feedback: Огонь!'])

      // Practice outcome takes the dedicated practice form, titled from the snapshot.
      expect(feedBody().querySelector('.feed-card__practice-title')?.textContent?.trim()).toBe(
        'Утренняя йога',
      )
      // Banner form: its own title + the practice as subtitle, teal for confirmed.
      expect(feedBody().querySelector('.feed-card__banner-title')?.textContent?.trim()).toBe(
        'Вы записались',
      )
      expect(feedBody().querySelector('.feed-card__banner-subtitle')?.textContent?.trim()).toBe(
        'Вечерняя медитация',
      )
      expect(feedBody().querySelector('.feed-card--banner-teal')).not.toBeNull()
    })

    it('thread_started renders a real standard card -- title + master name, not the blank pen card it was before the kind existed frontend-side', async () => {
      // The backend writes this on every chat create-or-get
      // (diary/projections.py). The hand-written DiaryEventKind union listed
      // nine kinds and missed it, so FEED_KIND_TITLE[kind] was undefined ->
      // empty title, and the preview lookup read fields this snapshot does not
      // carry -> null: a card with nothing on it but a date.
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(
        page([
          feedItem('t1', 'thread_started', '2026-07-16T10:00:00Z', {
            thread_id: 'thread-7',
            master_id: 'master-3',
            master_name: 'Анна Соколова',
          }),
        ]),
      )
      mount()
      await flush()

      expect(cardTitles()).toEqual(['Вы начали диалог'])
      expect(cardPreviews()).toEqual(['Анна Соколова'])
    })

    it('groups the thread by day, relative to the pinned clock', async () => {
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(
        page([
          feedItem('a', 'note', '2026-07-16T10:00:00Z', { content_preview: 'сегодняшняя' }),
          feedItem('b', 'note', '2026-07-15T10:00:00Z', { content_preview: 'вчерашняя' }),
          feedItem('c', 'note', '2026-07-10T10:00:00Z', { content_preview: 'старая' }),
        ]),
      )
      mount()
      await flush()

      // Oldest group first. «10 июля» is Intl ru output -- codepoint-checked as a
      // plain 0x20 space (see the banner), so no NBSP normalisation is needed.
      expect(dayDividers()).toEqual(['10 июля', 'Вчера', 'Сегодня'])
      expect(cardPreviews()).toEqual(['старая', 'вчерашняя', 'сегодняшняя'])
    })
  })

  describe('pagination (IntersectionObserver sentinel)', () => {
    it('attaches an observer to the sentinel once the first page renders', async () => {
      // Also the canary for the tick count: too few ticks and setupObserver would
      // not have run, so this fails loudly instead of the load-more tests passing
      // vacuously.
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(page([NOTE], 'cursor_1'))
      mount()
      await flush()

      const io = liveObserver()
      expect(io.targets).toHaveLength(1)
      expect(io.targets[0]).toBe(feedBody().querySelector('.diary-feed__sentinel'))
    })

    it('an empty feed renders no sentinel, so nothing observes', async () => {
      mount()
      await flush()

      expect(feedBody().querySelector('.diary-feed__sentinel')).toBeNull()
      expect(observers.filter((o) => !o.disconnected)).toHaveLength(0)
    })

    it('the sentinel scrolling into view loads the next page with the previous cursor and APPENDS it', async () => {
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(
        page([feedItem('new', 'note', '2026-07-16T10:00:00Z', { content_preview: 'новая' })], 'c1'),
      )
      mount()
      await flush()
      expect(cardPreviews()).toEqual(['новая'])

      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(
        page(
          [feedItem('old', 'note', '2026-07-15T10:00:00Z', { content_preview: 'старая' })],
          null,
        ),
      )
      fireSentinel()
      await flush()

      // The cursor from page 1 must be what page 2 asked with -- an offset or a
      // dropped cursor would silently re-serve page 1 forever.
      expect(vi.mocked(diaryApi.listDiaryFeed).mock.calls.at(-1)?.[0]).toMatchObject({
        cursor: 'c1',
        limit: 20,
      })
      // Appended, not replaced, and re-grouped: older page sorts above.
      expect(cardPreviews()).toEqual(['старая', 'новая'])
      expect(dayDividers()).toEqual(['Вчера', 'Сегодня'])
    })

    it('a sentinel hit that is NOT intersecting requests nothing', async () => {
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(page([NOTE], 'c1'))
      mount()
      await flush()
      vi.mocked(diaryApi.listDiaryFeed).mockClear()

      fireSentinel(false)
      await flush()

      expect(diaryApi.listDiaryFeed).not.toHaveBeenCalled()
    })

    it('an exhausted feed (next_cursor null) never requests another page', async () => {
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(page([NOTE], null))
      mount()
      await flush()
      vi.mocked(diaryApi.listDiaryFeed).mockClear()

      fireSentinel()
      await flush()

      expect(diaryApi.listDiaryFeed).not.toHaveBeenCalled()
    })

    it('re-entry: two sentinel hits with no tick between them fire ONE request', async () => {
      // SC-17: no await between the hits, so nothing has re-rendered and no
      // disabled attribute can be doing the work. There is no button on this path
      // at all -- refs are the entire defence.
      //
      // WHICH ref, precisely (the SC-02 half of SC-17): TWO guards stand here and
      // the comment must name the one that actually trips. loadMore sets
      // `loading.value = true` SYNCHRONOUSLY, before its first await
      // (useCursorPagination.ts:51), so by the second hit feedLoading is already
      // true and the OBSERVER's own `!feedLoading.value` check (.vue:586) returns
      // first. useCursorPagination's `if (loading.value) return false` (.ts:48) is
      // the backstop behind it, never reached from this path.
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(page([NOTE], 'c1'))
      mount()
      await flush()
      vi.mocked(diaryApi.listDiaryFeed)
        .mockClear()
        .mockReturnValue(new Promise<DiaryFeedResponse>(() => {}))

      fireSentinel()
      fireSentinel()
      await flush()

      expect(diaryApi.listDiaryFeed).toHaveBeenCalledTimes(1)
    })

    it('a failed older page KEEPS the feed and TELLS the user (was the silence tripwire; fixed №443)', async () => {
      // This was pinned as a BUG in the previous commit -- the last known instance
      // of the silence we chased all session -- and it went red the moment
      // useCursorPagination learned to split the two failures. Flipped, not
      // weakened (SC-10). Both halves are asserted; drop either and it fails.
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(
        page(
          [feedItem('n1', 'note', '2026-07-16T10:00:00Z', { content_preview: 'уцелевшая' })],
          'c1',
        ),
      )
      mount()
      await flush()
      // Pin the positive set FIRST so every not.toContain below is real and not
      // satisfied by an empty render (SC-15).
      expect(cardPreviews()).toEqual(['уцелевшая'])

      vi.mocked(diaryApi.listDiaryFeed).mockRejectedValue(new Error('Сеть отвалилась'))
      fireSentinel()
      await flush()

      const store = useDiaryStore()
      // The failure routes to loadMoreError, NOT to the rung's error. That split
      // is what makes the surviving feed structural rather than a guard the
      // screen has to remember.
      expect(store.feedError).toBeNull()
      expect(store.feedLoadMoreError).toBe('Сеть отвалилась')

      // The user is TOLD, with the real message. This is the channel that did not
      // exist before: the feed loads from a sentinel, so there is no button left
      // looking broken -- the toast is the only thing standing between the reader
      // and a feed that has silently stopped.
      expect(toastError).toHaveBeenCalledWith('Сеть отвалилась')

      // ...and the rung still does NOT hijack the screen -- the content survives.
      expect(bodyText()).not.toContain('Не удалось загрузить дневник')
      expect(cardPreviews()).toEqual(['уцелевшая'])
      expect(feedBody().querySelector('.diary-feed__state--more')).toBeNull()
    })

    it('an INITIAL feed failure still fills `error` and shows the rung, not a toast', async () => {
      // The other side of the split: it must not become a blanket redirect that
      // silences the first page too. Without this, routing everything to
      // loadMoreError would pass the test above.
      vi.mocked(diaryApi.listDiaryFeed).mockRejectedValue(new Error('Сеть отвалилась'))
      mount()
      await flush()

      const store = useDiaryStore()
      expect(store.feedError).toBe('Сеть отвалилась')
      expect(store.feedLoadMoreError).toBeNull()
      expect(bodyText()).toContain('Не удалось загрузить дневник')
      expect(toastError).not.toHaveBeenCalled()
    })

    it('after a silent failure the feed is not even wedged -- a later hit retries, but only the observer can fire it', async () => {
      // The other half of why this is bad rather than merely rude: hasMore is
      // untouched by the catch (useCursorPagination.ts:60-63), so the feed WOULD
      // recover on the next intersection. But an IntersectionObserver only calls
      // back when intersection CHANGES, and the sentinel is already in view and
      // stays there -- nothing re-fires, and .vue offers no manual control. The
      // recovery path exists and is unreachable by the user.
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(page([NOTE], 'c1'))
      mount()
      await flush()

      vi.mocked(diaryApi.listDiaryFeed).mockRejectedValue(new Error('Сеть отвалилась'))
      fireSentinel()
      await flush()

      const store = useDiaryStore()
      expect(store.feedHasMore).toBe(true)
      expect(feedBody().querySelector('.diary-feed__sentinel')).not.toBeNull()

      // Simulated re-intersection (which the real screen cannot produce): proves
      // the retry works, so the gap is purely the missing surface/control.
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(
        page([feedItem('old', 'note', '2026-07-15T10:00:00Z', { content_preview: 'догрузилась' })]),
      )
      fireSentinel()
      await flush()

      expect(cardPreviews()).toEqual(['догрузилась', 'Сегодня было спокойно'])
      expect(store.feedError).toBeNull()
    })
  })

  describe('filters', () => {
    it('applying a category filter reloads the feed and retitles the header', async () => {
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(page([NOTE]))
      mount()
      await flush()
      expect(headerTitle()).toBe('Дневник')

      openKebab()
      await flush()
      host?.querySelector<HTMLButtonElement>('button[aria-label="Фильтр"]')?.click()
      await flush()

      const modal = liveModal()
      expect(modal).not.toBeNull()
      buttonIn(modal!, 'Сонник')?.click()
      await flush()
      buttonIn(modal!, 'Применить')?.click()
      await flush()

      // The chip must reach the API as a real category param -- this is the whole
      // filter contract.
      expect(vi.mocked(diaryApi.listDiaryFeed).mock.calls.at(-1)?.[0]).toMatchObject({
        categories: ['dreams'],
      })
      // A single non-root category replaces the title (.vue:451-458).
      expect(headerTitle()).toBe('Сонник')
    })

    it('a read-only filter hides the composer entirely', async () => {
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(page([NOTE]))
      mount()
      await flush()
      expect(host?.querySelector('.composer')).not.toBeNull()

      const store = useDiaryStore()
      await store.setFeedFilters({ categories: ['practices'] })
      await flush()

      // diaryWriteTarget(['practices']) === null -> composer unmounts, so the
      // keyboard can never open on a feed you cannot write to.
      expect(host?.querySelector('.composer')).toBeNull()
      expect(headerTitle()).toBe('Практики')
    })

    it('the composer switches target with the filter: Сонник writes dreams', async () => {
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(page([NOTE]))
      mount()
      await flush()
      expect(host?.querySelector('textarea')?.placeholder).toBe('Начните писать...')

      const store = useDiaryStore()
      await store.setFeedFilters({ categories: ['dreams'] })
      await flush()

      expect(host?.querySelector('textarea')?.placeholder).toBe('Запишите сон...')
    })

    it('search: submitting a query reloads the feed with it', async () => {
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(page([NOTE]))
      mount()
      await flush()

      openKebab()
      await flush()
      host?.querySelector<HTMLButtonElement>('button[aria-label="Поиск"]')?.click()
      await flush()

      const modal = liveModal()
      expect(modal).not.toBeNull()
      const input = modal!.querySelector('input')
      expect(input).not.toBeNull()
      input!.value = 'сон'
      input!.dispatchEvent(new Event('input'))
      await flush()
      modal!.querySelector<HTMLButtonElement>('.diary-search__go')?.click()
      await flush()

      expect(vi.mocked(diaryApi.listDiaryFeed).mock.calls.at(-1)?.[0]).toMatchObject({
        search: 'сон',
      })
    })
  })

  describe('back button (contextual)', () => {
    it('with no filter it exits the diary to the dashboard', async () => {
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(page([NOTE]))
      mount()
      await flush()

      const backBtn = host?.querySelector<HTMLButtonElement>('.diary-feed__back')
      expect(backBtn?.getAttribute('aria-label')).toBe('Выйти из дневника')
      backBtn?.click()
      await flush()

      expect(push).toHaveBeenCalledWith('/user/dashboard')
    })

    it('with a filter active it CLEARS the filter instead of leaving', async () => {
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(page([NOTE]))
      mount()
      await flush()
      const store = useDiaryStore()
      await store.setFeedFilters({ categories: ['dreams'] })
      await flush()

      const backBtn = host?.querySelector<HTMLButtonElement>('.diary-feed__back')
      expect(backBtn?.getAttribute('aria-label')).toBe('Сбросить фильтр')
      backBtn?.click()
      await flush()

      // The same control must NOT navigate here -- that is the whole point of the
      // contextual back.
      expect(push).not.toHaveBeenCalled()
      expect(store.feedFilters.categories).toEqual([])
      expect(headerTitle()).toBe('Дневник')
      expect(vi.mocked(diaryApi.listDiaryFeed).mock.calls.at(-1)?.[0]).toMatchObject({
        categories: [],
      })
    })
  })

  describe('navigation', () => {
    it('tapping a note opens the entry screen by source_id, not by feed-event id', async () => {
      // The card id and the DiaryEntry id are different rows; routing by the feed
      // event's own id would 404 at runtime.
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(page([NOTE]))
      mount()
      await flush()

      feedBody().querySelector<HTMLButtonElement>('.feed-card--standard')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'user-diary-entry', params: { id: 'src_n1' } })
    })

    it('tapping a check-in opens the read-only detail typed by kind', async () => {
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(
        page([feedItem('c1', 'checkin', '2026-07-16T10:00:00Z', { mood: 5 })]),
      )
      mount()
      await flush()

      feedBody().querySelector<HTMLButtonElement>('.feed-card--standard')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({
        name: 'user-diary-detail',
        params: { type: 'checkin', id: 'src_c1' },
      })
    })

    it('tapping a feedback opens the read-only detail typed by kind', async () => {
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(
        page([feedItem('f1', 'feedback', '2026-07-16T10:00:00Z', { rating: 5 })]),
      )
      mount()
      await flush()

      feedBody().querySelector<HTMLButtonElement>('.feed-card--standard')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({
        name: 'user-diary-detail',
        params: { type: 'feedback', id: 'src_f1' },
      })
    })

    it('tapping a thread_started card opens the chat thread by source_id -- the comms thread id, which is what the route wants', async () => {
      // Unlike practice_outcome (pinned below as unreachable), this kind takes
      // the `standard` form, which IS a <button>, so the branch really runs.
      // The snapshot's thread_id is deliberately set to a DIFFERENT value than
      // source_id here (the real backend writes the same id into both) so the
      // assertion discriminates which field the handler actually reads.
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(
        page([
          feedItem('t1', 'thread_started', '2026-07-16T10:00:00Z', {
            thread_id: 'snapshot-copy-not-read',
            master_id: 'master-3',
            master_name: 'Анна Соколова',
          }),
        ]),
      )
      mount()
      await flush()

      const card = feedBody().querySelector<HTMLButtonElement>('.feed-card--standard')
      expect(card).not.toBeNull()
      card?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'user-chat', params: { id: 'src_t1' } })
    })

    it('a banner card is inert -- no card button, no navigation', async () => {
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(
        page([
          feedItem('b1', 'booking_confirmed', '2026-07-16T10:00:00Z', {
            practice_title: 'Вечерняя медитация',
          }),
        ]),
      )
      mount()
      await flush()

      // Positive pin first: the banner DID render (SC-15).
      expect(feedBody().querySelector('.feed-card--banner-teal')).not.toBeNull()
      expect(feedBody().querySelector('.feed-card--standard')).toBeNull()
      expect(push).not.toHaveBeenCalled()
    })

    it('a practice_outcome card is NOT tappable today -- .vue:319-325 is unreachable', async () => {
      // FINDING, pinned as-is. DiaryFeedView.onTap has a practice_outcome branch
      // routing to 'practice-detail' (.vue:319-325), but DiaryFeedCard renders the
      // practice form as a plain <div> with no @click and no tap emit
      // (DiaryFeedCard.vue:42-72) -- only the `standard` form is a <button>. The
      // other renderer (DiaryTimeline) is gated behind viewMode 'map', which
      // SHOW_VIEW_TOGGLE = false (.vue:345) makes unreachable. So in the shipped
      // screen that branch can never run. Not a crash, not fixed here: pinning
      // today's behaviour so the intent (tap -> practice) is not assumed to work.
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(
        page([
          feedItem('p1', 'practice_outcome', '2026-07-16T10:00:00Z', {
            practice_title: 'Утренняя йога',
            outcome_status: 'attended',
          }),
        ]),
      )
      mount()
      await flush()

      const card = feedBody().querySelector<HTMLElement>('.feed-card--practice')
      expect(card).not.toBeNull()
      expect(card?.tagName).toBe('DIV')
      card?.click()
      await flush()

      expect(push).not.toHaveBeenCalled()
    })
  })

  describe('undo bar (?deleted=)', () => {
    it('a ?deleted query raises the undo bar and strips the param without a history entry', async () => {
      // The watcher is immediate:true (.vue:510), so the query must be seeded
      // BEFORE mount -- seeding after would miss the only firing.
      routeQuery.deleted = 'entry_7'
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(page([NOTE]))
      mount()
      await flush()

      expect(host?.querySelector('.diary-feed__undo')).not.toBeNull()
      expect(host?.textContent).toContain('Запись удалена')
      expect(replace).toHaveBeenCalledWith({ query: {} })
    })

    it('no ?deleted query means no undo bar', async () => {
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(page([NOTE]))
      mount()
      await flush()

      expect(host?.querySelector('.diary-feed__undo')).toBeNull()
      expect(replace).not.toHaveBeenCalled()
    })

    it('«Отменить» restores the entry through the store and dismisses the bar', async () => {
      routeQuery.deleted = 'entry_7'
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(page([NOTE]))
      mount()
      await flush()

      buttonIn(host!, 'Отменить')?.click()
      await flush()

      expect(diaryApi.restoreDiaryEntry).toHaveBeenCalledWith('entry_7')
      expect(host?.querySelector('.diary-feed__undo')).toBeNull()
    })

    it('a failed restore surfaces the REAL backend message as a toast', async () => {
      // Contrast with the feed path above: THIS failure is not silent. The store
      // returns { ok:false, error } and .vue:524 toasts it. ApiResponseError is
      // the real class, so extractApiError returns e.detail rather than the
      // fallback -- proving the backend's own words reach the user.
      routeQuery.deleted = 'entry_7'
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(page([NOTE]))
      vi.mocked(diaryApi.restoreDiaryEntry).mockRejectedValue(
        new ApiResponseError(409, 'Запись уже восстановлена', 'conflict'),
      )
      mount()
      await flush()

      buttonIn(host!, 'Отменить')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Запись уже восстановлена')
      expect(host?.querySelector('.diary-feed__undo')).toBeNull()
    })

    it('re-entry: double-tapping «Отменить» with no tick between restores ONCE', async () => {
      // SC-17: no await between the clicks, so `:disabled="undoing"` has not
      // re-rendered and cannot be what stops the second call. The `undoing` ref
      // guard (.vue:515) is the only thing standing -- rip it out and this fails.
      routeQuery.deleted = 'entry_7'
      vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(page([NOTE]))
      mount()
      await flush()

      const undo = buttonIn(host!, 'Отменить')
      expect(undo).toBeDefined()
      undo!.click()
      undo!.click()
      await flush()

      expect(diaryApi.restoreDiaryEntry).toHaveBeenCalledTimes(1)
    })
  })
})

// =============================================================================
// NOT COVERED, deliberately
// =============================================================================
//
// - viewMode 'map' / DiaryTimeline: unreachable. SHOW_VIEW_TOGGLE = false
//   (.vue:345) removes the only entry point, so toggleView() cannot be called by
//   a user. Testing it would assert a mode nobody can reach; the flag flipping
//   back is the trigger to cover it (and the practice-tap finding above with it).
// - Scroll position (scrollToBottom / scrollToTop / feedScrollTop restore /
//   onLoadMore's height-delta compensation, .vue:599-606): happy-dom has NO
//   layout -- scrollHeight and clientHeight are hard 0, so every branch computes
//   0 and "passes" without proving anything. That is the SC-14 shape (a test that
//   cannot fail), so it is left out rather than faked. Genuinely needs a browser.
// - DiaryComposer's own send path (draft persistence, autogrow, the mic stub):
//   covered where the PARENT is involved (target switching, hiding on read-only
//   filters). The composer's internals are a component test, not this screen's.
// - The date-range half of DiaryFilterModal (its calendar grid, tz-correct
//   bounds): that modal's own logic, and the screen only forwards the payload.
// =============================================================================
