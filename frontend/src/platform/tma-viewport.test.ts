// =============================================================================
// VELO Frontend -- tma-viewport seam tests
// =============================================================================
//
// The seam must be inert until loadTmaSdk() runs (standalone never loads the
// SDK), and after loading it must mirror the SDK's viewport signals into
// reactive refs. The SDK is module-mocked with callable signals.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

function fakeSignal<T>(initial: T) {
  let value = initial
  const subs: Array<(v: T) => void> = []
  const signal = Object.assign(() => value, {
    sub: (fn: (v: T) => void) => {
      subs.push(fn)
      return () => undefined
    },
    emit: (v: T) => {
      value = v
      subs.forEach((fn) => fn(v))
    },
  })
  return signal
}

vi.mock('@tma.js/sdk-vue', () => {
  return {
    viewport: {
      isMounted: fakeSignal(true),
      safeAreaInsetTop: fakeSignal<number | undefined>(10),
      contentSafeAreaInsetTop: fakeSignal<number | undefined>(36),
    },
  }
})

beforeEach(() => {
  vi.resetModules()
})

describe('tma-viewport seam', () => {
  it('is inert before load: idle state, no viewport object', async () => {
    const seam = await import('@/platform/tma-viewport')

    expect(seam.getTmaViewport()).toBeNull()
    expect(seam.tmaViewportState.isMounted.value).toBe(false)
    expect(seam.tmaViewportState.safeAreaInsetTop.value).toBe(0)
  })

  it('loadTmaSdk() mirrors the viewport signals and stays in sync', async () => {
    const seam = await import('@/platform/tma-viewport')
    await seam.loadTmaSdk()

    expect(seam.getTmaViewport()).not.toBeNull()
    expect(seam.tmaViewportState.isMounted.value).toBe(true)
    expect(seam.tmaViewportState.safeAreaInsetTop.value).toBe(10)
    expect(seam.tmaViewportState.contentSafeAreaInsetTop.value).toBe(36)

    const vp = seam.getTmaViewport() as unknown as {
      contentSafeAreaInsetTop: { emit: (v: number) => void }
    }
    vp.contentSafeAreaInsetTop.emit(48)
    expect(seam.tmaViewportState.contentSafeAreaInsetTop.value).toBe(48)
  })

  it('loads the SDK once however many callers ask', async () => {
    const seam = await import('@/platform/tma-viewport')
    const [a, b] = await Promise.all([seam.loadTmaSdk(), seam.loadTmaSdk()])

    expect(a).toBe(b)
  })
})

describe('tma-viewport seam -- chunk failure', () => {
  it('a failed load is not cached: the next call retries the import', async () => {
    vi.resetModules()
    vi.doMock('@tma.js/sdk-vue', () => {
      throw new Error('chunk failed')
    })
    const seam = await import('@/platform/tma-viewport')
    await expect(seam.loadTmaSdk()).rejects.toThrow()
    expect(seam.getTmaViewport()).toBeNull()

    vi.doMock('@tma.js/sdk-vue', () => ({
      viewport: {
        isMounted: fakeSignal(true),
        safeAreaInsetTop: fakeSignal<number | undefined>(10),
        contentSafeAreaInsetTop: fakeSignal<number | undefined>(36),
      },
    }))
    await expect(seam.loadTmaSdk()).resolves.toBeDefined()
    expect(seam.getTmaViewport()).not.toBeNull()
    vi.doUnmock('@tma.js/sdk-vue')
  })
})
