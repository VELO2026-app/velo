// =============================================================================
// VELO Frontend -- usePagination Composable (Phase F3.1)
// =============================================================================
//
// Reusable composable for limit/offset pagination with "load more"
// pattern. Works with any API that returns { items, total, limit, offset }.
//
// Usage:
//   const { items, loading, hasMore, loadMore, reset } = usePagination(
//     (limit, offset) => getPractices(filters, limit, offset),
//   )
//   await loadMore()              // first page
//   if (hasMore.value) loadMore() // next page
//   reset()                       // clear and start over
// =============================================================================

import { ref, computed, type Ref } from 'vue'

export interface PaginatedResult<T> {
  items: T[]
  total: number
  limit: number
  offset: number
}

type FetchFn<T> = (limit: number, offset: number) => Promise<PaginatedResult<T>>

export function usePagination<T>(fetchFn: FetchFn<T>, pageSize = 20) {
  const items = ref<T[]>([]) as Ref<T[]>
  const total = ref(0)
  const offset = ref(0)
  const loading = ref(false)

  // TWO errors, because a failed page 1 and a failed page N are not the same
  // event and a consumer that cannot tell them apart cannot render either one
  // correctly. One shared `error` produced three behaviours across the app,
  // two of them wrong: destroy-the-list (MasterPracticesView, №441) and
  // swallow-it-silently (MyBookingsView, DiaryFeedView).
  //
  //   error         -- the FIRST page failed. There is nothing on screen; the
  //                    screen owes the user a full error rung. Never set while
  //                    items exist, so binding it to a rung is initial-load-only
  //                    BY DEFAULT -- no `&& items.length === 0` guard needed.
  //   loadMoreError -- a LATER page failed. The list is intact and must stay on
  //                    screen; the screen owes the user a non-destructive signal
  //                    (a toast -- the pattern proven on the six admin lists).
  //
  // Splitting them here is what makes "don't destroy the list" the default
  // rather than each screen's private achievement. Surfacing stays the screen's
  // job: this composable holds data, not UI, and an inline banner is as valid as
  // a toast.
  const error = ref<string | null>(null)
  const loadMoreError = ref<string | null>(null)

  const hasMore = computed(() => offset.value < total.value)

  // W17 fix (PROMPT №409): reset()/refresh() calling loadMore() while an
  // EARLIER loadMore() is still in flight used to corrupt state -- the
  // earlier call's `loading` guard blocked the new refresh's own loadMore
  // from running at all, then the earlier (stale-offset, stale-filter)
  // response landed on top of the just-cleared list once it resolved.
  // requestId tags each fetch; reset() bumps it so any in-flight loadMore
  // recognises itself as stale when it resolves and discards its result
  // instead of applying it.
  let requestId = 0

  /**
   * Load the next page of results. Appends to existing items.
   * Returns false if already loading or no more items.
   *
   * A failure routes to `error` when this was the FIRST page and to
   * `loadMoreError` when it was a later one -- see the refs' own note.
   */
  async function loadMore(): Promise<boolean> {
    if (loading.value) return false
    if (items.value.length > 0 && !hasMore.value) return false

    // Captured BEFORE the await: `items` can change while the request is in
    // flight, and which error this failure belongs to is decided by the state
    // the request STARTED from, not the state it happens to land in.
    const isFirstPage = items.value.length === 0

    loading.value = true
    if (isFirstPage) error.value = null
    else loadMoreError.value = null
    const myRequestId = ++requestId
    const requestOffset = offset.value

    try {
      const result = await fetchFn(pageSize, requestOffset)
      if (myRequestId !== requestId) return false // superseded by a reset/refresh
      items.value = [...items.value, ...result.items]
      total.value = result.total
      offset.value = requestOffset + result.items.length
      return true
    } catch (e) {
      if (myRequestId !== requestId) return false
      const message = e instanceof Error ? e.message : 'Unknown error'
      if (isFirstPage) error.value = message
      else loadMoreError.value = message
      return false
    } finally {
      if (myRequestId === requestId) loading.value = false
    }
  }

  /**
   * Clear all loaded items and reset offset. Does NOT auto-fetch. Invalidates
   * any in-flight loadMore() so its stale response can't land on top of the
   * cleared state (W17).
   */
  function reset(): void {
    requestId += 1
    items.value = []
    total.value = 0
    offset.value = 0
    error.value = null
    loadMoreError.value = null
    loading.value = false
  }

  /**
   * Reset and immediately load the first page.
   */
  async function refresh(): Promise<void> {
    reset()
    await loadMore()
  }

  /**
   * Reload the first page WITHOUT clearing `items` first (unlike refresh(),
   * which resets to [] synchronously and lets the empty state render while the
   * request is in flight). For a background freshness check on an
   * already-populated list -- items only swap once the new page has arrived,
   * so nothing flashes empty. Still bumps requestId so it composes correctly
   * with a concurrent loadMore/reset (same guard as loadMore's own check).
   *
   * On an EMPTY list (first-ever call) this behaves like refresh(): sets
   * `loading`/`error` normally, since there is nothing to protect from a
   * flash and the caller's initial-load rung needs those signals. On an
   * ALREADY-POPULATED list, a failure is swallowed silently and the existing
   * (stale) items are kept -- this path is a passive refresh, not the
   * primary load the screen depends on to render at all.
   */
  async function refreshInPlace(): Promise<void> {
    requestId += 1
    const myRequestId = requestId
    const isFirstLoad = items.value.length === 0
    if (isFirstLoad) {
      loading.value = true
      error.value = null
    }
    try {
      const result = await fetchFn(pageSize, 0)
      if (myRequestId !== requestId) return // superseded by a reset/refresh
      items.value = result.items
      total.value = result.total
      offset.value = result.items.length
      loadMoreError.value = null
    } catch (e) {
      if (myRequestId !== requestId) return
      if (isFirstLoad) {
        error.value = e instanceof Error ? e.message : 'Unknown error'
      }
    } finally {
      if (isFirstLoad && myRequestId === requestId) loading.value = false
    }
  }

  return {
    items,
    total,
    loading,
    error,
    loadMoreError,
    hasMore,
    loadMore,
    reset,
    refresh,
    refreshInPlace,
  }
}
