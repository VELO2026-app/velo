// =============================================================================
// VELO Frontend -- platform/session.ts tests (FE-157 stage 3)
// =============================================================================
//
// The account scope on throwaway stores: which stores enroll, which reset,
// that the session owner is spared, that one Pinia's reset never touches
// another's, and that a throwing reset does not leave the rest half-done.
// The real stores against the contract: stores/session-reset.test.ts.
// =============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, ref } from 'vue'
import { createPinia, defineStore, setActivePinia, type Pinia } from 'pinia'
import { accountScopePlugin, resetAccountScope } from '@/platform/session'

/** A Pinia set up the way app.ts sets it up: plugin first, then installed in an app. */
function installedPinia(): Pinia {
  const pinia = createPinia().use(accountScopePlugin)
  createApp({}).use(pinia)
  setActivePinia(pinia)
  return pinia
}

const useWithReset = defineStore('test-with-reset', () => {
  const count = ref(0)
  function $reset(): void {
    count.value = 0
  }
  return { count, $reset }
})

const useWithoutReset = defineStore('test-without-reset', () => {
  const count = ref(0)
  return { count }
})

const useOptions = defineStore('test-options', {
  state: () => ({ count: 0 }),
})

const useOwner = defineStore('test-owner', () => {
  const count = ref(0)
  function $reset(): void {
    count.value = 0
  }
  return { count, $reset }
})

const useBroken = defineStore('test-broken', () => {
  function $reset(): void {
    throw new Error('broken reset')
  }
  return { $reset }
})

describe('resetAccountScope', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resets every enrolled store except the session owner', () => {
    const pinia = installedPinia()
    const setup = useWithReset()
    const options = useOptions()
    const owner = useOwner()
    setup.count = 1
    options.count = 2
    owner.count = 3

    resetAccountScope(pinia, 'test-owner')

    expect(setup.count).toBe(0)
    expect(options.count).toBe(0) // Pinia's built-in reset for options stores
    expect(owner.count).toBe(3)
  })

  it('leaves out a setup store without its own $reset instead of throwing', () => {
    // Pinia's placeholder $reset for setup stores throws in dev: calling it
    // in the middle of a logout would stop every reset after it.
    const pinia = installedPinia()
    const without = useWithoutReset()
    const setup = useWithReset()
    without.count = 1
    setup.count = 1

    expect(() => resetAccountScope(pinia, 'test-owner')).not.toThrow()
    expect(without.count).toBe(1)
    expect(setup.count).toBe(0)
  })

  it("never touches another Pinia's stores", () => {
    const first = installedPinia()
    const firstStore = useWithReset()
    firstStore.count = 1
    installedPinia()
    const secondStore = useWithReset()
    secondStore.count = 2

    resetAccountScope(first, 'test-owner')

    expect(firstStore.count).toBe(0)
    expect(secondStore.count).toBe(2)
  })

  it('enrolls nothing in a Pinia that was never installed in an app', () => {
    // Pinia defers plugins until app.use(pinia): the plugin must be added
    // to the Pinia that app.ts installs, and tests must install theirs.
    const pinia = createPinia().use(accountScopePlugin)
    setActivePinia(pinia)
    const setup = useWithReset()
    setup.count = 1

    resetAccountScope(pinia, 'test-owner')

    expect(setup.count).toBe(1)
  })

  it('a throwing reset does not stop the others; its error is rethrown on a microtask', () => {
    const scheduled: Array<() => void> = []
    vi.stubGlobal('queueMicrotask', (task: () => void) => scheduled.push(task))
    const pinia = installedPinia()
    useBroken() // enrolled before the healthy store: the loop meets it first
    const setup = useWithReset()
    setup.count = 1

    expect(() => resetAccountScope(pinia, 'test-owner')).not.toThrow()

    expect(setup.count).toBe(0)
    expect(scheduled).toHaveLength(1)
    expect(() => scheduled[0]!()).toThrow('broken reset')
  })
})
