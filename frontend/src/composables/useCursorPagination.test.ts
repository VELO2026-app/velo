// =============================================================================
// VELO Frontend -- useCursorPagination tests (diary live search, 2026-09-09)
// =============================================================================
//
// The live search drives overlapping refreshes (one per debounced keystroke),
// so the composable's race contract is now load-bearing:
//   - a STALE response must never apply (out-of-order resolution);
//   - a refresh must SWAP, not clear-then-load (no full-screen loader flash
//     under the user's keystrokes);
//   - the error/loadMoreError SPLIT (№442) survives: a failed refresh clears
//     items and fills `error` (the rung), a failed loadMore keeps them.
//
// No Vue app needed: refs work unwrapped inside the composable's own scope.

import { describe, it, expect, vi } from 'vitest'
import { useCursorPagination } from '@/composables/useCursorPagination'

interface Row {
  id: string
}

function row(id: string): Row {
  return { id }
}

describe('useCursorPagination', () => {
  it('loadMore appends pages and tracks the cursor + hasMore', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({ items: [row('a')], next_cursor: 'c1' })
      .mockResolvedValueOnce({ items: [row('b')], next_cursor: null })
    const feed = useCursorPagination<Row>(fetchFn, 2)

    await feed.refresh()
    expect(fetchFn).toHaveBeenNthCalledWith(1, null, 2)
    expect(feed.items.value.map((r) => r.id)).toEqual(['a'])
    expect(feed.hasMore.value).toBe(true)

    await feed.loadMore()
    expect(fetchFn).toHaveBeenNthCalledWith(2, 'c1', 2)
    expect(feed.items.value.map((r) => r.id)).toEqual(['a', 'b'])
    expect(feed.hasMore.value).toBe(false)
  })

  it('refresh SWAPS the page in -- old items stay on screen while the new page is in flight', async () => {
    let resolveSecond!: (v: { items: Row[]; next_cursor: string | null }) => void
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({ items: [row('old')], next_cursor: null })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve
          }),
      )
    const feed = useCursorPagination<Row>(fetchFn, 2)

    await feed.refresh()
    const pending = feed.refresh()
    expect(feed.items.value.map((r) => r.id)).toEqual(['old']) // no clear-flash
    resolveSecond({ items: [row('new')], next_cursor: null })
    await pending
    expect(feed.items.value.map((r) => r.id)).toEqual(['new'])
  })

  it('a STALE refresh response never applies (the newer keystroke wins)', async () => {
    let resolveSlow!: (v: { items: Row[]; next_cursor: string | null }) => void
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSlow = resolve
          }),
      )
      .mockResolvedValueOnce({ items: [row('смс')], next_cursor: null })
    const feed = useCursorPagination<Row>(fetchFn, 2)

    const slow = feed.refresh() // "см" -- slow
    const fast = feed.refresh() // "смс" -- overtakes
    await fast
    expect(feed.items.value.map((r) => r.id)).toEqual(['смс'])
    expect(feed.loading.value).toBe(false)

    resolveSlow({ items: [row('см')], next_cursor: null })
    await slow
    // The late response for the OLD query must not overwrite the new results.
    expect(feed.items.value.map((r) => r.id)).toEqual(['смс'])
  })

  it('a failed refresh clears items and fills `error` (the rung contract)', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({ items: [row('a')], next_cursor: null })
      .mockRejectedValueOnce(new Error('boom'))
    const feed = useCursorPagination<Row>(fetchFn, 2)

    await feed.refresh()
    await feed.refresh()
    expect(feed.items.value).toEqual([])
    expect(feed.error.value).toBe('boom')
  })

  it('a failed loadMore KEEPS the items and fills `loadMoreError` (the split)', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({ items: [row('a')], next_cursor: 'c1' })
      .mockRejectedValueOnce(new Error('page-2 down'))
    const feed = useCursorPagination<Row>(fetchFn, 2)

    await feed.refresh()
    await feed.loadMore()
    expect(feed.items.value.map((r) => r.id)).toEqual(['a'])
    expect(feed.loadMoreError.value).toBe('page-2 down')
    expect(feed.error.value).toBeNull()
  })

  it('reset() invalidates a response still in flight', async () => {
    let resolveFirst!: (v: { items: Row[]; next_cursor: string | null }) => void
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockResolvedValueOnce({ items: [row('after')], next_cursor: null })
    const feed = useCursorPagination<Row>(fetchFn, 2)

    const stale = feed.refresh()
    feed.reset()
    resolveFirst({ items: [row('stale')], next_cursor: 'stale-cursor' })
    await stale
    await feed.refresh()
    expect(feed.items.value.map((r) => r.id)).toEqual(['after'])
  })
})
