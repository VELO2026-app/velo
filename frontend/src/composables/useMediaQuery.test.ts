import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { useMediaQuery } from '@/composables/useMediaQuery'

type Listener = (event: { matches: boolean }) => void

function fakeMatchMedia(initial: boolean) {
  const listeners = new Set<Listener>()
  const list = {
    matches: initial,
    addEventListener: vi.fn((_: string, l: Listener) => listeners.add(l)),
    removeEventListener: vi.fn((_: string, l: Listener) => listeners.delete(l)),
  }
  return { list, change: (matches: boolean) => listeners.forEach((l) => l({ matches })), listeners }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useMediaQuery', () => {
  it('reads the query and follows its changes', () => {
    const fake = fakeMatchMedia(true)
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => fake.list),
    )
    const scope = effectScope()
    const matches = scope.run(() => useMediaQuery('(min-width: 744px)'))

    expect(matches?.value).toBe(true)
    fake.change(false)
    expect(matches?.value).toBe(false)
    scope.stop()
  })

  it('stops listening when its scope ends', () => {
    const fake = fakeMatchMedia(true)
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => fake.list),
    )
    const scope = effectScope()
    scope.run(() => useMediaQuery('(min-width: 744px)'))

    scope.stop()

    expect(fake.listeners.size).toBe(0)
  })

  it('reads false where there is no matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined)
    const scope = effectScope()

    expect(scope.run(() => useMediaQuery('(min-width: 744px)'))?.value).toBe(false)
    scope.stop()
  })
})
