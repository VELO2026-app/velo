// =============================================================================
// VELO Frontend -- platform/chunk-reload.ts tests (BE-149)
// =============================================================================
//
// Contract: on `vite:preloadError` reload ONCE per session, and only when the
// once-mark can be held; the second time stay out of the way so a failure that
// survives a reload cannot become a reload loop. Twin axes: REPEAT (second
// event, two events in one tick), EMPTY (event without payload), SHORTAGE
// (storage that throws, mark already spent).
// =============================================================================

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { CHUNK_RELOAD_KEY, installChunkReload } from '@/platform/chunk-reload'

function preloadError(payload?: unknown): Event {
  const e = new Event('vite:preloadError', { cancelable: true })
  if (payload !== undefined) (e as Event & { payload: unknown }).payload = payload
  return e
}

let target: EventTarget
let reload: Mock<() => void>

beforeEach(() => {
  sessionStorage.clear()
  target = new EventTarget()
  reload = vi.fn<() => void>()
})

describe('installChunkReload', () => {
  it('first failure: reloads once, marks the event handled, spends the mark', () => {
    installChunkReload(target, () => sessionStorage, reload)
    const e = preloadError(new TypeError('Failed to fetch dynamically imported module'))

    target.dispatchEvent(e)

    expect(reload).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(true)
    expect(sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBe('1')
  })

  it('REPEAT: the failure survives the reload -> no second reload, error left to Vite', () => {
    // The state after the reload: same session, mark already spent.
    sessionStorage.setItem(CHUNK_RELOAD_KEY, '1')
    installChunkReload(target, () => sessionStorage, reload)
    const e = preloadError(new TypeError('x'))

    target.dispatchEvent(e)

    expect(reload).not.toHaveBeenCalled()
    // Not prevented: Vite rethrows, the navigation fails as it did before.
    expect(e.defaultPrevented).toBe(false)
  })

  it('REPEAT: two failures in one tick (two lazy chunks) -> ONE reload', () => {
    installChunkReload(target, () => sessionStorage, reload)
    const first = preloadError()
    const second = preloadError()

    target.dispatchEvent(first)
    target.dispatchEvent(second)

    expect(reload).toHaveBeenCalledTimes(1)
    expect(first.defaultPrevented).toBe(true)
    expect(second.defaultPrevented).toBe(false)
  })

  it('EMPTY: an event without payload is handled the same way', () => {
    installChunkReload(target, () => sessionStorage, reload)

    target.dispatchEvent(preloadError())

    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('SHORTAGE: storage that cannot hold the mark -> no reload (a loop could not stop)', () => {
    const blocked = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    } as unknown as Storage
    installChunkReload(target, () => blocked, reload)
    const e = preloadError()

    target.dispatchEvent(e)

    expect(reload).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })

  it('SHORTAGE: storage getter throws -> no reload', () => {
    installChunkReload(
      target,
      () => {
        throw new Error('SecurityError')
      },
      reload,
    )

    target.dispatchEvent(preloadError())

    expect(reload).not.toHaveBeenCalled()
  })

  it('other errors are not its business', () => {
    installChunkReload(target, () => sessionStorage, reload)

    target.dispatchEvent(new Event('error', { cancelable: true }))

    expect(reload).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBeNull()
  })
})
