// =============================================================================
// VELO Frontend -- platform/chunk-reload.ts tests (BE-149)
// =============================================================================
//
// Contract: on `vite:preloadError` reload at most once per RELOAD_WINDOW_MS,
// and only when the mark can be held; inside the window stay out of the way so
// a failure that survives a reload cannot become a reload loop. After the
// window (the next deploy in the same long-lived session, FE-157) reload
// again. Twin axes: REPEAT (second event, two events in one tick), EMPTY
// (event without payload), SHORTAGE (storage that throws), WINDOW.
// =============================================================================

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { CHUNK_RELOAD_KEY, installChunkReload, RELOAD_WINDOW_MS } from '@/platform/chunk-reload'

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
    expect(Number(sessionStorage.getItem(CHUNK_RELOAD_KEY))).toBeGreaterThan(0)
  })

  it('REPEAT: the failure survives the reload -> no second reload, error left to Vite', () => {
    // The state right after the reload: same session, mark set a moment ago.
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now() - 2_000))
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

  it('WINDOW: the next deploy in the same session reloads again once the window passed', () => {
    let clock = 1_000_000
    installChunkReload(
      target,
      () => sessionStorage,
      reload,
      () => clock,
    )

    target.dispatchEvent(preloadError())
    clock += RELOAD_WINDOW_MS - 1
    const inside = preloadError()
    target.dispatchEvent(inside)
    clock += 2
    const after = preloadError()
    target.dispatchEvent(after)

    expect(reload).toHaveBeenCalledTimes(2)
    expect(inside.defaultPrevented).toBe(false)
    expect(after.defaultPrevented).toBe(true)
  })

  it('WINDOW: a legacy once-per-session mark ("1") does not block a reload', () => {
    sessionStorage.setItem(CHUNK_RELOAD_KEY, '1')
    installChunkReload(target, () => sessionStorage, reload)

    target.dispatchEvent(preloadError())

    expect(reload).toHaveBeenCalledTimes(1)
  })
})
