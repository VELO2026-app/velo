// =============================================================================
// VELO Frontend -- useCursorPagination Composable (Diary feed)
// =============================================================================
//
// Cursor-based "load more" pagination, mirror of usePagination but for APIs
// that return { items, next_cursor } instead of { items, total, offset }.
//
// The diary feed (GET /api/v1/diary/feed) is an append-only timeline read
// newest-first; offset pagination is unsafe there (rows shift as new events
// are projected), so it uses an opaque cursor: the next page is requested
// with the previous response's next_cursor, and next_cursor === null marks
// the end of the feed.
//
// Usage:
//   const feed = useCursorPagination<DiaryFeedItem>(
//     (cursor, limit) => listDiaryFeed({ ...filters, cursor, limit }),
//   )
//   await feed.refresh()             // first page (reset + load)
//   if (feed.hasMore.value) feed.loadMore()
//   feed.reset()                     // clear, keep no cursor
// =============================================================================

import { ref, type Ref } from 'vue'

export interface CursorResult<T> {
  items: T[]
  next_cursor: string | null
}

// fetchFn receives the current cursor (null on the first page) and the page
// size, and returns one page plus the cursor for the following page.
type CursorFetchFn<T> = (cursor: string | null, limit: number) => Promise<CursorResult<T>>

export function useCursorPagination<T>(fetchFn: CursorFetchFn<T>, pageSize = 20) {
  const items = ref<T[]>([]) as Ref<T[]>
  const cursor = ref<string | null>(null)
  const loading = ref(false)

  // Race guard for overlapping requests. Every fetch captures the epoch it
  // started in; a response that lands after a NEWER fetch has started is
  // stale and must not apply -- not its items, not its error, not even its
  // `loading = false` (the newer fetch owns the flag now). The diary's live
  // search fires a refresh per debounced keystroke: without this, a slow
  // response for "см" landing after the "смс" one paints the wrong results
  // as final. Monotonic, never reset.
  let fetchEpoch = 0

  // TWO errors, mirroring usePagination (№442). One shared `error` cannot say
  // WHICH page failed, and a consumer that cannot tell them apart cannot render
  // either correctly -- here it produced the diary's silence: DiaryFeedView binds
  // this ref only behind `items.length === 0` (.vue:172), so a failed page-N was
  // shown to the user through no channel at all. Worse than the button case: the
  // feed loads from an IntersectionObserver sentinel, so there was not even a
  // button left sitting there to retry.
  //
  //   error         -- nothing is on screen; the screen owes a full error rung.
  //   loadMoreError -- the feed is intact and stays; the screen owes a
  //                    non-destructive signal (a toast).
  //
  // The predicate is "is anything on screen?", not "which page number is this?"
  // -- an empty first page that still returns a cursor leaves the user with
  // nothing, and that failure belongs in the rung.
  const error = ref<string | null>(null)
  const loadMoreError = ref<string | null>(null)
  // Becomes false once the backend returns next_cursor === null. Starts true
  // so the very first loadMore() is allowed.
  const hasMore = ref(true)

  /**
   * Load the next page and append it. Returns false if a load is already in
   * flight or the feed is exhausted.
   */
  async function loadMore(): Promise<boolean> {
    if (loading.value) return false
    if (!hasMore.value) return false

    const epoch = ++fetchEpoch

    // Captured BEFORE the await: items can change while the request is in
    // flight, and which error this failure belongs to is decided by the state
    // the request STARTED from, not the state it happens to land in.
    const isFirstPage = items.value.length === 0

    loading.value = true
    if (isFirstPage) error.value = null
    else loadMoreError.value = null

    try {
      const result = await fetchFn(cursor.value, pageSize)
      if (epoch !== fetchEpoch) return false
      items.value = [...items.value, ...result.items]
      cursor.value = result.next_cursor
      hasMore.value = result.next_cursor !== null
      return true
    } catch (e) {
      if (epoch === fetchEpoch) {
        const message = e instanceof Error ? e.message : 'Unknown error'
        if (isFirstPage) error.value = message
        else loadMoreError.value = message
      }
      return false
    } finally {
      if (epoch === fetchEpoch) loading.value = false
    }
  }

  /**
   * Clear all loaded items and the cursor. Does NOT auto-fetch. hasMore is
   * reset to true so the next loadMore() / refresh() starts a fresh feed.
   */
  function reset(): void {
    // Invalidate any fetch still in flight so it cannot append onto the
    // cleared state after it resolves.
    fetchEpoch++
    items.value = []
    cursor.value = null
    error.value = null
    loadMoreError.value = null
    hasMore.value = true
  }

  /**
   * Load a fresh FIRST page and swap it in atomically -- fetch-then-swap,
   * NOT reset()-then-load. The already-loaded page stays on screen until the
   * new one lands: a live-search refetch must not flash a full-screen loader
   * under the user's keystrokes. A stale response (a newer fetch started
   * while this one was in flight) never swaps in. On failure the items are
   * cleared: the error rung is bound to `items.length === 0`, and showing
   * the PREVIOUS filter's results behind a failed re-filter would lie.
   */
  async function refresh(): Promise<void> {
    const epoch = ++fetchEpoch
    loading.value = true
    error.value = null
    try {
      const result = await fetchFn(null, pageSize)
      if (epoch !== fetchEpoch) return
      items.value = result.items
      cursor.value = result.next_cursor
      hasMore.value = result.next_cursor !== null
    } catch (e) {
      if (epoch !== fetchEpoch) return
      items.value = []
      cursor.value = null
      hasMore.value = true
      error.value = e instanceof Error ? e.message : 'Unknown error'
    } finally {
      if (epoch === fetchEpoch) loading.value = false
    }
  }

  return {
    items,
    cursor,
    loading,
    error,
    loadMoreError,
    hasMore,
    loadMore,
    reset,
    refresh,
  }
}
