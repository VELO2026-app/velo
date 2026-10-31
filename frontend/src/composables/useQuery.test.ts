// =============================================================================
// VELO Frontend -- useQuery / queryCache tests (loading system)
// =============================================================================
//
// The contract the screens lean on:
//   - a key loaded before renders at once (no pending) and revalidates when stale;
//   - an error never wipes data already shown;
//   - keepPrevious holds the old key's data while the new key loads;
//   - setData beats a response still in flight (optimistic writes win);
//   - seed() is a placeholder: shown, but stale -- the first reader refetches.
// =============================================================================

import { describe, it, expect, vi } from 'vitest'
import { effectScope, nextTick, ref, watch } from 'vue'
import { queryCache, useQuery } from '@/composables/useQuery'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await nextTick()
}

describe('useQuery', () => {
  it('first load is pending, then holds the data', async () => {
    const d = deferred<number>()
    const scope = effectScope()
    const q = scope.run(() => useQuery({ key: ['n'], query: () => d.promise }))!

    expect(q.isPending.value).toBe(true)
    d.resolve(7)
    await settle()
    expect(q.data.value).toBe(7)
    expect(q.isPending.value).toBe(false)
    scope.stop()
  })

  it('a key loaded before renders at once and revalidates silently when stale', async () => {
    queryCache.setData(['n'], () => 1)
    queryCache.invalidate(['n']) // stale, nothing subscribed yet
    const query = vi.fn(() => Promise.resolve(2))
    const scope = effectScope()
    const q = scope.run(() => useQuery({ key: ['n'], query }))!

    expect(q.data.value).toBe(1)
    expect(q.isPending.value).toBe(false)
    await settle()
    await settle()
    expect(query).toHaveBeenCalledTimes(1)
    expect(q.data.value).toBe(2)
    scope.stop()
  })

  it('fresh data is not refetched', () => {
    queryCache.setData(['n'], () => 1)
    const query = vi.fn(() => Promise.resolve(2))
    const scope = effectScope()
    scope.run(() => useQuery({ key: ['n'], query, staleTime: 60_000 }))
    expect(query).not.toHaveBeenCalled()
    scope.stop()
  })

  it('an error never wipes data already shown', async () => {
    queryCache.setData(['n'], () => 1)
    queryCache.invalidate(['n'])
    const scope = effectScope()
    const q = scope.run(() =>
      useQuery({ key: ['n'], query: () => Promise.reject(new Error('down')) }),
    )!
    await settle()
    await settle()
    expect(q.data.value).toBe(1)
    expect(q.error.value).toBeInstanceOf(Error)
    scope.stop()
  })

  it('keepPrevious holds the old key while the new one loads', async () => {
    const id = ref('a')
    const next = deferred<string>()
    const scope = effectScope()
    queryCache.setData(['item', 'a'], () => 'A')
    const q = scope.run(() =>
      useQuery(
        () => ({
          key: ['item', id.value],
          query: () => next.promise,
          staleTime: 60_000,
        }),
        { keepPrevious: true },
      ),
    )!
    expect(q.data.value).toBe('A')

    id.value = 'b'
    await nextTick()
    expect(q.data.value).toBe('A')
    expect(q.isPlaceholder.value).toBe(true)

    next.resolve('B')
    await settle()
    expect(q.data.value).toBe('B')
    expect(q.isPlaceholder.value).toBe(false)
    scope.stop()
  })

  it('setData wins over a response still in flight', async () => {
    const d = deferred<number>()
    const scope = effectScope()
    const q = scope.run(() => useQuery({ key: ['n'], query: () => d.promise }))!

    queryCache.setData<number>(['n'], () => 42)
    d.resolve(1)
    await settle()
    expect(q.data.value).toBe(42)
    scope.stop()
  })
})

describe('queryCache', () => {
  it('seed() shows a placeholder but leaves the key stale (never fresh)', () => {
    queryCache.seed(['p', '1'], 'from list')
    expect(queryCache.get(['p', '1'])).toBe('from list')
    expect(queryCache.isFresh(['p', '1'], 60_000)).toBe(false)
  })

  it('seed() never overwrites loaded data', () => {
    queryCache.setData(['p', '1'], () => 'loaded')
    queryCache.seed(['p', '1'], 'from list')
    expect(queryCache.get(['p', '1'])).toBe('loaded')
  })

  it('prefetch loads once and dedupes while in flight', async () => {
    const query = vi.fn(() => Promise.resolve('x'))
    await Promise.all([queryCache.prefetch(['k'], query), queryCache.prefetch(['k'], query)])
    expect(query).toHaveBeenCalledTimes(1)
    expect(queryCache.get(['k'])).toBe('x')
    expect(queryCache.isFresh(['k'], 60_000)).toBe(true)
  })

  it('prefetch never rejects', async () => {
    await expect(
      queryCache.prefetch(['k'], () => Promise.reject(new Error('down'))),
    ).resolves.toBeUndefined()
  })

  it('invalidate(prefix) marks matching keys stale, leaves others', () => {
    queryCache.setData(['practice', '1'], () => 1)
    queryCache.setData(['practices'], () => 2)
    queryCache.invalidate(['practice'])
    expect(queryCache.isFresh(['practice', '1'], 60_000)).toBe(false)
    expect(queryCache.isFresh(['practices'], 60_000)).toBe(true)
  })

  it('clear() drops everything', () => {
    queryCache.setData(['n'], () => 1)
    queryCache.clear()
    expect(queryCache.get(['n'])).toBeUndefined()
  })
})

describe('useQuery -- structural sharing', () => {
  it('a revalidation answering EQUAL data keeps the reference and triggers nothing', async () => {
    const payload = () => ({ practices_attended: 3, items: [{ id: 'a' }] })
    const query = vi.fn(() => Promise.resolve(payload()))
    const scope = effectScope()
    const q = scope.run(() => useQuery({ key: ['shared'], query, staleTime: 0 }))!
    await settle()
    const shown = q.data.value
    expect(shown).toEqual(payload())
    let triggered = 0
    scope.run(() => watch(q.data, () => triggered++))
    await q.refresh()
    await settle()
    expect(query).toHaveBeenCalledTimes(2)
    expect(q.data.value).toBe(shown)
    expect(triggered).toBe(0)
    scope.stop()
  })

  it('a changed answer still lands (unchanged parts keep their refs)', async () => {
    let n = 1
    const scope = effectScope()
    const q = scope.run(() =>
      useQuery({
        key: ['shared2'],
        query: () => Promise.resolve({ n, rows: [{ id: 'a' }] }),
        staleTime: 0,
      }),
    )!
    await settle()
    const rows = q.data.value!.rows
    n = 2
    await q.refresh()
    await settle()
    expect(q.data.value!.n).toBe(2)
    expect(q.data.value!.rows).toBe(rows)
    scope.stop()
  })
})
