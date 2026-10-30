// =============================================================================
// VELO Frontend -- persistedCache: per-account, versioned, capped, clearable
// =============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PERSIST_MAX_BYTES,
  PERSIST_PREFIX,
  PERSIST_VERSION,
  clearPersisted,
  flushPersisted,
  readPersisted,
  setPersistOwner,
  writePersisted,
} from '@/composables/persistedCache'

const keyOf = (id: string): string => `${PERSIST_PREFIX}v${PERSIST_VERSION}:${id}`

afterEach(() => {
  vi.useRealTimers()
})

describe('persistedCache', () => {
  it('no owner (signed out): nothing is read or written', () => {
    writePersisted('a', [1])
    flushPersisted()
    expect(readPersisted('a')).toBeUndefined()
    expect(sessionStorage.length).toBe(0)
  })

  it('writes are batched under a versioned, per-account key and survive a module restart', () => {
    vi.useFakeTimers()
    setPersistOwner('u1')
    writePersisted('a', [1, 2])
    writePersisted('b', { n: 3 })
    expect(sessionStorage.getItem(keyOf('u1'))).toBeNull() // not yet: batched
    vi.advanceTimersByTime(60)
    const stored = JSON.parse(sessionStorage.getItem(keyOf('u1')) ?? '{}') as Record<
      string,
      { data: unknown }
    >
    expect(stored.a?.data).toEqual([1, 2])
    expect(stored.b?.data).toEqual({ n: 3 })

    // Same account after a reload: the copy is there.
    setPersistOwner(null)
    sessionStorage.setItem(keyOf('u1'), JSON.stringify(stored))
    setPersistOwner('u1')
    expect(readPersisted('a')?.data).toEqual([1, 2])
  })

  it("another account never sees the previous one's copy (it is dropped)", () => {
    setPersistOwner('u1')
    writePersisted('a', 'mine')
    flushPersisted()
    setPersistOwner('u2')
    expect(readPersisted('a')).toBeUndefined()
    expect(sessionStorage.getItem(keyOf('u1'))).toBeNull()
  })

  it('sign-out clears every account', () => {
    setPersistOwner('u1')
    writePersisted('a', 1)
    flushPersisted()
    clearPersisted()
    expect(readPersisted('a')).toBeUndefined()
    expect(sessionStorage.getItem(keyOf('u1'))).toBeNull()
  })

  it('over the size cap the oldest payloads go first', () => {
    setPersistOwner('u1')
    const big = 'x'.repeat(Math.floor(PERSIST_MAX_BYTES * 0.6))
    writePersisted('old', big, 1000)
    writePersisted('new', big, 2000)
    flushPersisted()
    expect(readPersisted('old')).toBeUndefined()
    expect(readPersisted('new')?.data).toBe(big)
    expect((sessionStorage.getItem(keyOf('u1')) ?? '').length).toBeLessThanOrEqual(
      PERSIST_MAX_BYTES,
    )
  })
})
