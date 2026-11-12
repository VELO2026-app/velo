// =============================================================================
// VELO Frontend -- the diary on Pinia Colada (FE-166 step 8, FE-182)
// =============================================================================
//
// What used to live in stores/diary.ts as server data: the feed, the search
// jump window, one entry, a practice's insights. The store keeps the client
// state (filters, the saved scroll offset, the jump target, the optimistic
// send queue) and the diary's mutations, which call diaryFeedChanged().
//
// THE FEED (`GET /diary/feed`) is a chat-like timeline: the API answers newest
// first, `next_cursor` walks into the past, the screen draws the oldest entry
// on top and loads more when the reader scrolls UP. In useInfiniteQuery terms
// "up" is the NEXT page (older), rendered reversed (the ADR's prototype,
// ./diary-infinite.prototype.test.ts). One entry per filter set.
//
// Freshness, as in the store: the feed is read once per session and changes
// on screen through this app's own mutations -- a note sent, edited, deleted,
// restored, a check-in, a feedback, an outside activity, a booking. A Colada
// refetch would reload EVERY page loaded so far, one after another (and
// `maxPages` would drop today's end of the timeline -- the API has no cursor
// back to it), so none happens on its own: staleTime Infinity, no refetch on
// focus or reconnect. A mutation calls diaryFeedChanged(), which asks for the
// FIRST page only and makes it the whole feed (setQueryData) -- the older
// pages load again as the reader scrolls up, as they did in the store. A
// failed reload keeps the feed on screen.
//
// Because that write bypasses Colada's page bookkeeping, `hasNextPage` would
// lag behind it: the screen reads "more?" off the last page's `next_cursor`
// (useDiaryFeed().hasMore). `loadNextPage()` recomputes the cursor from the
// data itself, so it is right after a write.
//
// A failed older page must not leave the entry in error: Colada keeps the
// pages, but the entry's next refresh (a remount, a filter switched back)
// would then reload every one of them. The pages shown are still right, so
// the entry goes back to success and only the caller hears of the failure
// (keepPagesOnFailure).
//
// The unfiltered feed stays in memory for the session (gcTime Infinity), so
// the diary reopens without a skeleton; a filtered or searched one (an entry
// per debounced keystroke) for FEED_GC_MS after its screen let go -- long
// enough for a visit to an entry and back. The account scope empties all of
// it (queries/setup.ts). Diary text is never persisted
// (composables/persistedCache).
// =============================================================================

import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import {
  defineInfiniteQueryOptions,
  defineQueryOptions,
  setInfiniteQueryData,
  useInfiniteQuery,
  useQueryCache,
  type QueryCache,
  type UseQueryEntry,
} from '@pinia/colada'
import { getDiaryEntry, getPracticeInsights, listDiaryFeed } from '@/api/diary'
import type {
  DiaryFeedFilters,
  DiaryFeedItem,
  DiaryFeedResponse,
  PracticeInsightsResponse,
} from '@/api/types'
import { keys } from '@/composables/queries/keys'
import { screenQueryState } from '@/composables/queries/screenState'
import { useQueryScopeStore } from '@/composables/queries/setup'
import { mergeJumpWindow } from '@/utils/diaryJumpWindow'

/**
 * Events per feed page. 40, not 20: a 20-event page is only ~2-3 screens of
 * thread, so the first scroll up hit the seam before any prefetch could land;
 * 40 gives ~4-5 screens per request (the backend caps at 100,
 * diary_feed_max_page_size) and the first page alone covers a typical diary.
 */
export const DIARY_FEED_PAGE_SIZE = 40

/** Events per side of a search jump window, and per older page inside it. */
export const DIARY_JUMP_PAGE_SIZE = 20

/** How long a filtered feed or a jump window stays in memory once no screen reads it (ms). */
export const FEED_GC_MS = 30 * 60_000

/** The data of a feed entry: the pages loaded so far, newest first, and their cursors. */
export interface DiaryFeedData {
  pages: DiaryFeedResponse[]
  pageParams: (string | null)[]
}

/** The filters as the feed key carries them: the API's names, unset ones left out. */
function feedFilterKey(filters: DiaryFeedFilters): DiaryFeedFilters {
  const key: DiaryFeedFilters = {}
  if (filters.categories?.length) key.categories = [...filters.categories]
  if (filters.date_from !== undefined) key.date_from = filters.date_from
  if (filters.date_to !== undefined) key.date_to = filters.date_to
  if (filters.search !== undefined && filters.search !== '') key.search = filters.search
  return key
}

/** One page of the feed for the filters a feed key carries. */
function fetchFeedPage(filters: DiaryFeedFilters, cursor: string | null) {
  return listDiaryFeed({ ...filters, cursor: cursor ?? undefined, limit: DIARY_FEED_PAGE_SIZE })
}

/** Infinite query options for the feed under one filter set (see the header). */
export const diaryFeedQuery = defineInfiniteQueryOptions((filters: DiaryFeedFilters) => {
  const filterKey = feedFilterKey(filters)
  const unfiltered = Object.keys(filterKey).length === 0
  return {
    key: keys.diary.feed(filterKey),
    query: ({ pageParam }: { pageParam: string | null }) => fetchFeedPage(filterKey, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last: DiaryFeedResponse) => last.next_cursor,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: unfiltered ? Number.POSITIVE_INFINITY : FEED_GC_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  }
})

/** Whether the feed's last loaded page says there is an older one. */
function feedHasMore(data: DiaryFeedData | undefined): boolean {
  return data?.pages.at(-1)?.next_cursor != null
}

/**
 * Load the next older page; on failure put the entry back to success with
 * the pages it holds (see the header), then reject with the error.
 */
async function keepPagesOnFailure(
  queryCache: QueryCache,
  key: readonly unknown[],
  loadNextPage: () => Promise<unknown>,
): Promise<void> {
  try {
    await loadNextPage()
  } catch (error) {
    const entry = queryCache.get(key as Parameters<QueryCache['get']>[0])
    // Not recorded on the entry: the request was cancelled (a first-page
    // reload replaced the pages it was asked from) or the entry is gone --
    // nothing on screen failed, so nobody is told.
    if (entry?.state.value.status !== 'error') return
    const data = entry.state.value.data
    if (data !== undefined && entry.asyncStatus.value === 'idle') {
      queryCache.setEntryState(entry, { data, error: null, status: 'success' })
    }
    throw error
  }
}

/**
 * The feed under the given filters, for the diary screen.
 *
 * @remarks
 * A filter or search change keeps the previous answer on screen until the
 * new one lands (placeholderData): a live search must not flash a loader or
 * a "nothing found" under the user's keystrokes. A failed new answer shows
 * no stale results -- the placeholder ends with the request.
 */
export function useDiaryFeed(filters: MaybeRefOrGetter<DiaryFeedFilters>) {
  const queryCache = useQueryCache()
  const query = useInfiniteQuery(() => ({
    ...diaryFeedQuery(toValue(filters)),
    placeholderData: (previous: DiaryFeedData | undefined) => previous,
  }))
  const { loading, failed } = screenQueryState(query)
  return {
    /** Every loaded event, newest first. */
    items: computed<DiaryFeedItem[]>(
      () => query.data.value?.pages.flatMap((page) => page.items) ?? [],
    ),
    /** An answer for these filters is held (an empty one included). */
    loaded: computed(() => query.data.value !== undefined && !query.isPlaceholderData.value),
    /** Nothing to show and the first page in flight. */
    loading,
    /** Nothing to show and the first page failed. */
    failed,
    /** The raw error of the last request (ADR: the screen turns it into text). */
    error: query.error,
    /** Any request of this feed in flight (first page, older page). */
    fetching: computed(() => query.asyncStatus.value === 'loading'),
    /** An older page exists. */
    hasMore: computed(() => feedHasMore(query.data.value)),
    /**
     * Load the next older page. Rejects with its error and keeps the feed.
     * cancelRefetch false: a scroll during a reload waits for it instead of
     * cancelling it.
     */
    loadMore: () =>
      keepPagesOnFailure(queryCache, diaryFeedQuery(toValue(filters)).key, () =>
        query.loadNextPage({ throwOnError: true, cancelRefetch: false }),
      ),
    /** The answer for the current filters once it settled (joins the request in flight). Never rejects. */
    settled: () => query.refresh(),
    /** Ask again (every loaded page). Never rejects. */
    refetch: () => query.refetch(),
  }
}

/** Per feed entry, the latest first-page reload: an older one landing later writes nothing. */
const firstPageReloads = new WeakMap<UseQueryEntry, object>()

/**
 * Make the first page, asked again, the whole feed (see the header). On an
 * entry with nothing loaded yet it is the ordinary first load. Never rejects:
 * a failure keeps what is shown.
 */
async function reloadFirstPage(queryCache: QueryCache, entry: UseQueryEntry): Promise<void> {
  const data = entry.state.value.data as DiaryFeedData | undefined
  if (data === undefined) {
    if (entry.options) await queryCache.fetch(entry).catch(() => {})
    return
  }
  const scope = useQueryScopeStore()
  const generation = scope.generation()
  const call = {}
  firstPageReloads.set(entry, call)
  let page: DiaryFeedResponse
  try {
    page = await fetchFeedPage(entry.key[3] as DiaryFeedFilters, null)
  } catch {
    return
  }
  if (firstPageReloads.get(entry) !== call || scope.generation() !== generation) return
  // Dropped meanwhile (the session ended, the entry was collected): nothing to write into.
  if (queryCache.get(entry.key) !== entry) return
  // An older page in flight was asked from the pages this write replaces.
  queryCache.cancel(entry)
  queryCache.setQueryData<DiaryFeedData>(entry.key, { pages: [page], pageParams: [null] })
}

/** Bumped by every diaryFeedChanged(): a prefetch asked before it must not write its answer. */
let feedChanges = 0

/**
 * The diary moved through this app (an entry sent, edited, deleted or
 * restored; a check-in, a feedback, an outside activity, a booking): reload
 * the first page of the feed on screen, of the unfiltered feed and of the
 * feed under `current` -- the filters the diary screen reads with
 * (stores/diary.ts), off screen while an entry is open over it or another tab
 * is -- and drop the other filtered feeds: their next
 * reader loads them fresh. Search jump windows go stale. Resolves when the
 * reloads settled; never rejects.
 */
export async function diaryFeedChanged(
  queryCache: QueryCache,
  current?: DiaryFeedFilters,
): Promise<void> {
  feedChanges += 1
  const currentEntry = current ? queryCache.get(diaryFeedQuery(current).key) : undefined
  const reloads: Promise<void>[] = []
  for (const entry of queryCache.getEntries({ key: keys.diary.feeds() })) {
    const filters = entry.key[3] as DiaryFeedFilters | undefined
    const unfiltered = filters !== undefined && Object.keys(filters).length === 0
    const held = entry.state.value.data !== undefined
    if (entry.active || (held && (unfiltered || entry === currentEntry))) {
      reloads.push(reloadFirstPage(queryCache, entry))
    } else {
      queryCache.remove(entry)
    }
  }
  // A search jump window may show the changed entry too. It is small (a
  // window and the pages scrolled from it): stale, so its next reader asks
  // again -- at once, if it is on screen.
  for (const entry of queryCache.getEntries({ key: keys.diary.jumps() })) {
    if (entry.state.value.data === undefined) continue
    queryCache.invalidate(entry)
    if (entry.active && entry.options)
      reloads.push(
        queryCache.fetch(entry).then(
          () => {},
          () => {},
        ),
      )
  }
  await Promise.allSettled(reloads)
}

/**
 * Load the first page of the feed under the given filters into the cache
 * before its screen opens (router/dataPrefetch.ts). Does nothing when the
 * feed already holds an answer or a request. Rejects when the request fails.
 */
export async function prefetchDiaryFeed(
  queryCache: QueryCache,
  filters: DiaryFeedFilters,
): Promise<void> {
  const { key } = diaryFeedQuery(filters)
  const held = queryCache.get(key)
  if (held && (held.state.value.data !== undefined || held.asyncStatus.value === 'loading')) return
  const scope = useQueryScopeStore()
  const generation = scope.generation()
  const changes = feedChanges
  const page = await fetchFeedPage(key[3] as DiaryFeedFilters, null)
  // The session ended, or the diary moved meanwhile: this answer predates it.
  if (scope.generation() !== generation || feedChanges !== changes) return
  // The screen answered first (it may have loaded older pages since): keep that.
  if (queryCache.get(key)?.state.value.data !== undefined) return
  setInfiniteQueryData<DiaryFeedResponse, string | null>(queryCache, key, {
    pages: [page],
    pageParams: [null],
  })
}

// =============================================================================
// The search jump ("scroll to the found entry", Telegram-style)
// =============================================================================
//
// A tap on a search result opens a WINDOW of the unfiltered feed around that
// event instead of a filtered list: its first page is two parallel requests
// bounded by the event's occurred_at (the bounds are inclusive, so the event
// is in BOTH answers -- mergeJumpWindow dedupes); the next pages go further
// into the past through the older answer's cursor. The newer side ends at what
// the window fetched -- the cursor only walks into the past; the search bar's
// outer x is the way back to the live feed. Asked anew on every jump tap
// (useDiaryJump().forget drops the window a previous tap left), but not on a
// return from an entry opened inside it: the window is held, like the feed
// (staleTime Infinity, FEED_GC_MS), and a failed older page keeps it.

/** The event a jump opens the window around. */
export type DiaryJumpTarget = Pick<DiaryFeedItem, 'id' | 'occurred_at'>

/** Infinite query options for the jump window around one event (see above). */
export const diaryJumpQuery = defineInfiniteQueryOptions((target: DiaryJumpTarget) => ({
  key: keys.diary.jump(target.id),
  query: async ({ pageParam }: { pageParam: string | null }): Promise<DiaryFeedResponse> => {
    if (pageParam !== null) {
      return listDiaryFeed({ cursor: pageParam, limit: DIARY_JUMP_PAGE_SIZE })
    }
    const at = target.occurred_at
    const [older, newer] = await Promise.all([
      listDiaryFeed({ date_to: at, limit: DIARY_JUMP_PAGE_SIZE }),
      listDiaryFeed({ date_from: at, limit: DIARY_JUMP_PAGE_SIZE }),
    ])
    return { items: mergeJumpWindow(older.items, newer.items), next_cursor: older.next_cursor }
  },
  initialPageParam: null as string | null,
  getNextPageParam: (last: DiaryFeedResponse) => last.next_cursor,
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: FEED_GC_MS,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
}))

/** No jump open: the disabled reader's key. */
const NO_JUMP: DiaryJumpTarget = { id: '', occurred_at: '' }

/** The jump window around the target, or nothing while the target is null. */
export function useDiaryJump(target: MaybeRefOrGetter<DiaryJumpTarget | null>) {
  const queryCache = useQueryCache()
  const query = useInfiniteQuery(() => {
    const current = toValue(target)
    return { ...diaryJumpQuery(current ?? NO_JUMP), enabled: current !== null }
  })
  const { loading } = screenQueryState(query)
  return {
    /** The window's events, newest first. */
    items: computed<DiaryFeedItem[]>(
      () => query.data.value?.pages.flatMap((page) => page.items) ?? [],
    ),
    /** The window's first answer is in flight (the full-screen loader). */
    loading,
    /** An older page in flight inside an open window. */
    loadingMore: computed(
      () => query.asyncStatus.value === 'loading' && query.data.value !== undefined,
    ),
    /** Any request of the window in flight. */
    fetching: computed(() => query.asyncStatus.value === 'loading'),
    /** An older page exists. */
    hasMore: computed(() => feedHasMore(query.data.value)),
    /** Load the next older page. Rejects with its error and keeps the window. */
    loadMore: () => {
      const current = toValue(target)
      if (!current) return Promise.resolve()
      return keepPagesOnFailure(queryCache, diaryJumpQuery(current).key, () =>
        query.loadNextPage({ throwOnError: true, cancelRefetch: false }),
      )
    },
    /** The window's state once its request settled. Never rejects. */
    settled: () => query.refresh(),
    /** Drop the window a previous tap left around this event, so the next jump asks anew. */
    forget: (around: DiaryJumpTarget) => {
      const held = queryCache.get(diaryJumpQuery(around).key)
      if (held && !held.active) queryCache.remove(held)
    },
  }
}

// =============================================================================
// One entry, and a practice's insights
// =============================================================================

/**
 * Query options for one diary entry (`GET /diary/{id}`). staleTime 0: the
 * entry screen shows a held copy at once and asks again on every open, as
 * the store did; an edit writes its answer here (stores/diary.ts).
 */
export const diaryEntryQuery = defineQueryOptions((entryId: string) => ({
  key: keys.diary.entry(entryId),
  query: () => getDiaryEntry(entryId),
  staleTime: 0,
  refetchOnWindowFocus: false,
}))

/**
 * Query options for a practice's insights (`GET /practices/{id}/insights`,
 * the master's anonymous tallies). Read once per session, as the store's
 * insights cache was: the lists that show them load one per practice, and a
 * revisit must not ask again for each. gcTime Infinity: no screen holds these
 * entries (usePracticeInsights reads the cache), so nothing else would keep
 * them; the account scope empties them.
 */
export const practiceInsightsQuery = defineQueryOptions((practiceId: string) => ({
  key: keys.diary.insights(practiceId),
  query: () => getPracticeInsights(practiceId),
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
}))

/**
 * Practices' insights for a screen that lists several practices: `load(id)`
 * asks for one unless it is held (a failed one is asked again), `get(id)` /
 * `has(id)` read the cache reactively.
 */
export function usePracticeInsights(queryCache: QueryCache = useQueryCache()) {
  return {
    /** The practice's insights, or undefined until they answered. */
    get: (practiceId: string) =>
      queryCache.getQueryData<PracticeInsightsResponse>(keys.diary.insights(practiceId)),
    /** The practice's insights answered. */
    has: (practiceId: string) =>
      queryCache.getQueryData(keys.diary.insights(practiceId)) !== undefined,
    /** Load the practice's insights. Never rejects: a failure leaves them missing. */
    load: async (practiceId: string): Promise<void> => {
      await queryCache.refresh(queryCache.ensure(practiceInsightsQuery(practiceId))).catch(() => {})
    },
  }
}
