// =============================================================================
// VELO Frontend -- useQuery `persist`: hydrate at once, revalidate silently
// =============================================================================

import { describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { queryCache, serializeKey, useQuery } from '@/composables/useQuery'
import {
  flushPersisted,
  readPersisted,
  setPersistOwner,
  writePersisted,
} from '@/composables/persistedCache'

const KEY = ['stats', 'me'] as const

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick()
}

describe('useQuery persist', () => {
  it('a reload renders the persisted copy at once (not pending) and refreshes it in the background', async () => {
    setPersistOwner('u1')
    writePersisted(`q:${serializeKey(KEY)}`, { n: 1 })
    flushPersisted()

    let resolve!: (v: { n: number }) => void
    const query = vi.fn(() => new Promise<{ n: number }>((r) => (resolve = r)))
    const scope = effectScope()
    const q = scope.run(() => useQuery({ key: KEY, query, staleTime: 60_000, persist: true }))
    if (!q) throw new Error('no scope')

    expect(q.data.value).toEqual({ n: 1 })
    expect(q.isPending.value).toBe(false) // no skeleton
    expect(query).toHaveBeenCalledTimes(1) // hydrated copy is always stale

    resolve({ n: 2 })
    await settle()
    expect(q.data.value).toEqual({ n: 2 })
    flushPersisted()
    expect(readPersisted(`q:${serializeKey(KEY)}`)?.data).toEqual({ n: 2 })
    scope.stop()
  })

  it('without `persist` nothing is written', async () => {
    setPersistOwner('u1')
    const scope = effectScope()
    scope.run(() => useQuery({ key: ['plain'], query: () => Promise.resolve(5) }))
    await settle()
    flushPersisted()
    expect(readPersisted(`q:${serializeKey(['plain'])}`)).toBeUndefined()
    expect(queryCache.get(['plain'])).toBe(5)
    scope.stop()
  })
})
