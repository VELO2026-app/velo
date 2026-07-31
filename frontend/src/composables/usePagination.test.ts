// =============================================================================
// VELO Frontend -- usePagination Unit Tests
// =============================================================================
//
// Tests use a mock fetch function that returns predictable paginated
// results. No real API calls, no Pinia store dependency.
// =============================================================================

import { describe, it, expect, vi } from 'vitest'
import { nextTick } from 'vue'
import { usePagination, type PaginatedResult } from '@/composables/usePagination'

// -- Helpers --

interface Item {
  id: number
  name: string
}

/**
 * Create a mock fetch function that returns items from a pool.
 * Simulates backend limit/offset pagination.
 */
function createMockFetch(totalItems: number) {
  const pool: Item[] = Array.from({ length: totalItems }, (_, i) => ({
    id: i + 1,
    name: `Item ${i + 1}`,
  }))

  return vi.fn(async (limit: number, offset: number): Promise<PaginatedResult<Item>> => {
    const items = pool.slice(offset, offset + limit)
    return { items, total: totalItems, limit, offset }
  })
}

// -----------------------------------------------------------------------
// Core behaviour
// -----------------------------------------------------------------------
describe('usePagination', () => {
  it('starts with empty state', () => {
    const fetchFn = createMockFetch(10)
    const { items, total, loading, hasMore, error } = usePagination(fetchFn)

    expect(items.value).toEqual([])
    expect(total.value).toBe(0)
    expect(loading.value).toBe(false)
    expect(hasMore.value).toBe(false)
    expect(error.value).toBeNull()
  })

  it('loadMore fetches first page', async () => {
    const fetchFn = createMockFetch(5)
    const { items, total, hasMore, loadMore } = usePagination(fetchFn, 3)

    const result = await loadMore()

    expect(result).toBe(true)
    expect(fetchFn).toHaveBeenCalledWith(3, 0)
    expect(items.value).toHaveLength(3)
    expect(total.value).toBe(5)
    expect(hasMore.value).toBe(true)
  })

  it('loadMore appends next page', async () => {
    const fetchFn = createMockFetch(5)
    const { items, hasMore, loadMore } = usePagination(fetchFn, 3)

    await loadMore() // page 1: items 1-3
    await loadMore() // page 2: items 4-5

    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(fetchFn).toHaveBeenLastCalledWith(3, 3)
    expect(items.value).toHaveLength(5)
    expect(hasMore.value).toBe(false)
  })

  it('loadMore returns false when no more items', async () => {
    const fetchFn = createMockFetch(2)
    const { loadMore } = usePagination(fetchFn, 10)

    await loadMore() // loads all 2 items
    const result = await loadMore() // nothing left

    expect(result).toBe(false)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('loadMore returns false while already loading', async () => {
    // Create a slow fetch that we can control
    let resolveFetch: ((value: PaginatedResult<Item>) => void) | null = null
    const slowFetch = vi.fn(
      () =>
        new Promise<PaginatedResult<Item>>((resolve) => {
          resolveFetch = resolve
        }),
    )

    const { loadMore, loading } = usePagination(slowFetch, 5)

    // Start first load (won't resolve yet)
    const promise1 = loadMore()
    await nextTick()
    expect(loading.value).toBe(true)

    // Try second load while first is pending
    const result = await loadMore()
    expect(result).toBe(false)

    // Resolve the pending fetch
    resolveFetch!({ items: [], total: 0, limit: 5, offset: 0 })
    await promise1
    expect(loading.value).toBe(false)
  })

  // -----------------------------------------------------------------------
  // reset & refresh
  // -----------------------------------------------------------------------
  it('reset clears all state', async () => {
    const fetchFn = createMockFetch(5)
    const { items, total, error, reset, loadMore } = usePagination(fetchFn, 3)

    await loadMore()
    expect(items.value).toHaveLength(3)

    reset()
    expect(items.value).toEqual([])
    expect(total.value).toBe(0)
    expect(error.value).toBeNull()
  })

  it('refresh resets and loads first page', async () => {
    const fetchFn = createMockFetch(5)
    const { items, refresh, loadMore } = usePagination(fetchFn, 3)

    await loadMore() // page 1
    await loadMore() // page 2
    expect(items.value).toHaveLength(5)

    await refresh()
    // Should be back to first page only
    expect(items.value).toHaveLength(3)
    expect(items.value[0]!.id).toBe(1)
  })

  // W17 (PROMPT №409): a refresh() firing while an EARLIER loadMore() is still
  // in flight used to be blocked by that earlier call's `loading` guard (so
  // refresh's own fetch never ran), then the earlier call's stale response
  // landed on top of the just-cleared state once it resolved.
  it('a stale in-flight loadMore response does not clobber state after a concurrent refresh (W17)', async () => {
    const resolvers: Array<(v: PaginatedResult<Item>) => void> = []
    const fetchFn = vi.fn(
      () => new Promise<PaginatedResult<Item>>((resolve) => resolvers.push(resolve)),
    )

    const { items, total, loading, loadMore, refresh } = usePagination(fetchFn, 3)

    // Page 1 of the OLD query starts loading -- stays pending.
    const stalePromise = loadMore()
    await nextTick()
    expect(fetchFn).toHaveBeenCalledTimes(1)

    // A refresh happens while it's still in flight (e.g. a filter changed).
    // This must NOT be blocked by the stale call's `loading` guard.
    const refreshPromise = refresh()
    await nextTick()
    expect(fetchFn).toHaveBeenCalledTimes(2)

    // The STALE (first) request resolves now, with data for the OLD query.
    resolvers[0]!({ items: [{ id: 99, name: 'stale' }], total: 99, limit: 3, offset: 0 })
    await stalePromise

    // Must be discarded, not applied on top of the refreshed (cleared) state.
    expect(items.value.some((i) => i.id === 99)).toBe(false)

    // refresh()'s OWN request resolves with the real data.
    resolvers[1]!({ items: [{ id: 1, name: 'fresh' }], total: 1, limit: 3, offset: 0 })
    await refreshPromise

    expect(items.value).toEqual([{ id: 1, name: 'fresh' }])
    expect(total.value).toBe(1)
    expect(loading.value).toBe(false)
  })

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------
  it('captures error from failed fetch', async () => {
    const failingFetch = vi.fn(async () => {
      throw new Error('Network error')
    })

    const { error, loading, loadMore } = usePagination(failingFetch, 5)

    const result = await loadMore()

    expect(result).toBe(false)
    expect(error.value).toBe('Network error')
    expect(loading.value).toBe(false)
  })

  it('clears error on successful retry', async () => {
    let shouldFail = true
    const fetchFn = vi.fn(async (limit: number, offset: number) => {
      if (shouldFail) throw new Error('fail')
      return { items: [{ id: 1, name: 'ok' }], total: 1, limit, offset }
    })

    const { error, refresh } = usePagination(fetchFn, 5)

    await refresh()
    expect(error.value).toBe('fail')

    shouldFail = false
    await refresh()
    expect(error.value).toBeNull()
  })
})
