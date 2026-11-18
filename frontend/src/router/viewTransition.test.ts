// =============================================================================
// VELO Frontend -- screen transitions: kinds, the no-API fallback, rapid taps
// =============================================================================
//
// The animation itself is browser-only; what is provable here is the
// orchestration the router owns: which kind a navigation is; that a tab
// switch is a CSS fade-through on every host (never a View Transition) whose
// classes always come off; that WebKit never starts a View Transition; that
// depth on Blink does, with an update callback that settles without an
// animation frame and is capped; and that rapid taps never leave a class.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import {
  UPDATE_TIMEOUT_MS,
  __resetViewTransitionsForTest,
  installViewTransitions,
  transitionKind,
} from '@/router/viewTransition'

const Blank = defineComponent({ render: () => h('div') })

function makeRouter(): Router {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/user/dashboard', component: Blank },
      { path: '/user/calendar', component: Blank },
      { path: '/user/diary', component: Blank },
      { path: '/user/practice/:id', component: Blank },
    ],
  })
  installViewTransitions(router)
  return router
}

const root = (): DOMTokenList => document.documentElement.classList

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

describe('transitionKind', () => {
  it('tab root -> tab root is a tab switch, whatever the history direction', () => {
    expect(transitionKind({ path: '/user/calendar' }, { path: '/user/dashboard' }, false)).toBe(
      'tab',
    )
    expect(transitionKind({ path: '/user/dashboard' }, { path: '/user/calendar' }, true)).toBe(
      'tab',
    )
  })

  it('depth follows the history: push = forward, pop = back', () => {
    expect(transitionKind({ path: '/user/practice/1' }, { path: '/user/calendar' }, false)).toBe(
      'forward',
    )
    expect(transitionKind({ path: '/user/calendar' }, { path: '/user/practice/1' }, true)).toBe(
      'back',
    )
  })
})

async function waitMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('tab switches: CSS fade-through on every host', () => {
  afterEach(() => {
    // A navigation on real timers arms them; none may outlive the test (FE-186).
    __resetViewTransitionsForTest()
    vi.useRealTimers()
    root().remove('vt-leave', 'vt-fallback', 'vt-tab', 'vt-forward', 'vt-back')
  })

  it('old screen fades out first, then the new one fades in; every class comes off', async () => {
    vi.useFakeTimers()
    const router = makeRouter()
    await router.push('/user/dashboard')
    await settle()
    expect(root().contains('vt-leave')).toBe(false) // first screen: nothing

    const nav = router.push('/user/calendar')
    await vi.advanceTimersByTimeAsync(10)
    // Phase 1: the old screen is still the route, fading out.
    expect(root().contains('vt-leave')).toBe(true)
    expect(router.currentRoute.value.path).toBe('/user/dashboard')

    await vi.advanceTimersByTimeAsync(90)
    await nav
    await settle()
    // Phase 2: committed; fade-out swapped for the fade-in in one task.
    expect(router.currentRoute.value.path).toBe('/user/calendar')
    expect(root().contains('vt-leave')).toBe(false)
    expect(root().contains('vt-fallback')).toBe(true)
    expect(root().contains('vt-tab')).toBe(true)

    await vi.advanceTimersByTimeAsync(600)
    expect(root().contains('vt-fallback')).toBe(false)
    expect(root().contains('vt-tab')).toBe(false)
  })

  it('rapid double tap: one fade-out, the last tab wins, nothing is left behind', async () => {
    vi.useFakeTimers()
    const router = makeRouter()
    await router.push('/user/dashboard')
    const first = router.push('/user/calendar')
    await settle()
    await vi.advanceTimersByTimeAsync(40)
    const second = router.push('/user/diary')
    await settle()
    await vi.advanceTimersByTimeAsync(100)
    await Promise.all([first, second])
    await settle()

    expect(router.currentRoute.value.path).toBe('/user/diary')
    expect(root().contains('vt-leave')).toBe(false)
    expect(root().contains('vt-fallback')).toBe(true)
    await vi.advanceTimersByTimeAsync(600)
    expect(root().contains('vt-fallback')).toBe(false)
  })

  it('a tab navigation a later guard rejects brings the old screen straight back', async () => {
    vi.useFakeTimers()
    const router = makeRouter()
    await router.push('/user/dashboard')
    router.beforeResolve((to) => to.path !== '/user/calendar')
    const nav = router.push('/user/calendar')
    await vi.advanceTimersByTimeAsync(10)
    expect(root().contains('vt-leave')).toBe(true)
    await vi.advanceTimersByTimeAsync(90)
    await nav
    await settle()
    expect(router.currentRoute.value.path).toBe('/user/dashboard')
    expect(root().contains('vt-leave')).toBe(false)
    expect(root().contains('vt-fallback')).toBe(false)
  })

  it('never starts a View Transition, even where the API exists', async () => {
    const doc = document as unknown as Record<string, unknown>
    const start = vi.fn()
    doc.startViewTransition = start
    try {
      const router = makeRouter()
      await router.push('/user/dashboard')
      await router.push('/user/calendar')
      await settle()
      expect(start).not.toHaveBeenCalled()
      expect(router.currentRoute.value.path).toBe('/user/calendar')
    } finally {
      Reflect.deleteProperty(doc, 'startViewTransition')
    }
  })
})

describe('depth on hosts without View Transitions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    root().remove('vt-leave', 'vt-fallback', 'vt-tab', 'vt-forward', 'vt-back')
  })

  it('a push fades the new screen in (vt-fallback vt-forward), then clears', async () => {
    const router = makeRouter()
    await router.push('/user/dashboard')
    await router.push('/user/practice/7')
    await settle()
    expect(root().contains('vt-fallback')).toBe(true)
    expect(root().contains('vt-forward')).toBe(true)

    vi.advanceTimersByTime(600)
    expect(root().contains('vt-fallback')).toBe(false)
    expect(root().contains('vt-forward')).toBe(false)
  })
})

describe('hosts with View Transitions', () => {
  type Vt = {
    ready: Promise<void>
    finished: Promise<void>
    updateCallbackDone: Promise<void>
    skipTransition: ReturnType<typeof vi.fn>
    finish: () => void
  }
  const started: Vt[] = []
  const updates: Promise<void>[] = []
  const doc = document as unknown as Record<string, unknown>
  const win = window as unknown as Record<string, unknown>

  beforeEach(() => {
    started.length = 0
    updates.length = 0
    doc.startViewTransition = (update: () => Promise<void>): Vt => {
      let finish = (): void => undefined
      const finished = new Promise<void>((resolve) => {
        finish = resolve
      })
      const done = update()
      updates.push(done)
      const vt: Vt = {
        ready: done,
        finished,
        updateCallbackDone: done,
        skipTransition: vi.fn(() => finish()),
        finish: () => finish(),
      }
      started.push(vt)
      return vt
    }
    // A real browser SUPPRESSES rendering while the update callback runs: no
    // animation frame ever arrives in there. Model that -- a callback that
    // waits for one hangs (the 3-5 s regression).
    vi.stubGlobal('requestAnimationFrame', () => 0)
  })

  afterEach(() => {
    // Real timers here: WebKit's fallback fade arms one (FE-186).
    __resetViewTransitionsForTest()
    Reflect.deleteProperty(doc, 'startViewTransition')
    Reflect.deleteProperty(win, 'GestureEvent')
    vi.unstubAllGlobals()
    root().remove('vt-leave', 'vt-fallback', 'vt-tab', 'vt-forward', 'vt-back')
  })

  async function flushAll(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      await settle()
      await waitMs(0)
    }
  }

  it('a push on Blink runs a vt-forward View Transition and no fallback fade', async () => {
    const router = makeRouter()
    await router.push('/user/dashboard')
    await router.push('/user/practice/1')
    await flushAll()

    expect(started).toHaveLength(1)
    expect(root().contains('vt-forward')).toBe(true)
    expect(root().contains('vt-fallback')).toBe(false)

    started[0]?.finish()
    await flushAll()
    expect(root().contains('vt-forward')).toBe(false)
  })

  it('WebKit (iOS / Telegram iOS) never starts one: depth falls back to the CSS fade', async () => {
    win.GestureEvent = function GestureEvent() {}
    const router = makeRouter()
    await router.push('/user/dashboard')
    await router.push('/user/practice/1')
    await flushAll()

    expect(started).toHaveLength(0)
    expect(root().contains('vt-fallback')).toBe(true)
    expect(router.currentRoute.value.path).toBe('/user/practice/1')
  })

  it('a push while the previous transition still animates finishes it first and keeps the new kind', async () => {
    const router = makeRouter()
    await router.push('/user/dashboard')
    await router.push('/user/practice/1')
    await flushAll()
    expect(started).toHaveLength(1)

    await router.push('/user/practice/2')
    await flushAll()

    expect(started[0]?.skipTransition).toHaveBeenCalled()
    expect(started).toHaveLength(2)
    // The skipped transition settling must not strip its successor's class.
    expect(root().contains('vt-forward')).toBe(true)
    expect(router.currentRoute.value.path).toBe('/user/practice/2')
  })

  it('the update callback settles as soon as the new screen is mounted -- never on an animation frame', async () => {
    const router = makeRouter()
    await router.push('/user/dashboard')
    const t0 = Date.now()
    await router.push('/user/practice/1')
    let settled = false
    void updates[0]?.then(() => {
      settled = true
    })
    await flushAll()

    expect(settled).toBe(true)
    expect(Date.now() - t0).toBeLessThan(UPDATE_TIMEOUT_MS)
    expect(started[0]?.skipTransition).not.toHaveBeenCalled()
  })

  it('a screen that does not settle within the cap: the transition is skipped, nothing stays pending', async () => {
    const router = makeRouter()
    await router.push('/user/dashboard')
    // A later guard that never answers: the navigation never reaches afterEach.
    let release!: () => void
    router.beforeResolve(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true)
        }),
    )
    void router.push('/user/practice/1')
    await flushAll()
    expect(started).toHaveLength(1)

    await waitMs(UPDATE_TIMEOUT_MS + 50)
    let settled = false
    await Promise.race([
      updates[0]?.then(() => {
        settled = true
      }),
      waitMs(10),
    ])
    expect(settled).toBe(true)
    expect(started[0]?.skipTransition).toHaveBeenCalled()
    release()
  })
})

// FE-186: a timer of the screen change that outlives its test -- the test
// environment has taken `document` away by the time it fires -- must not
// throw: CI failed with an unhandled ReferenceError and no failed test.
describe('the timers of a screen change outlive no document (FE-186)', () => {
  afterEach(() => {
    __resetViewTransitionsForTest()
    vi.useRealTimers()
    root().remove('vt-leave', 'vt-fallback', 'vt-tab', 'vt-forward', 'vt-back')
  })

  /** Run `fire` with `document` gone from the global scope, then put it back. */
  function withoutDocument(fire: () => void): void {
    const kept = Object.getOwnPropertyDescriptor(globalThis, 'document')
    expect(kept).toBeDefined()
    Reflect.deleteProperty(globalThis, 'document')
    try {
      expect(typeof document).toBe('undefined')
      fire()
    } finally {
      Object.defineProperty(globalThis, 'document', kept as PropertyDescriptor)
    }
  }

  it('the fade-in timer (clearFallback) fires with no document: nothing is thrown', async () => {
    vi.useFakeTimers()
    const router = makeRouter()
    await router.push('/user/dashboard')
    await router.push('/user/practice/7')
    await settle()
    expect(root().contains('vt-fallback')).toBe(true) // the timer is armed
    withoutDocument(() => {
      expect(() => vi.advanceTimersByTime(600)).not.toThrow()
    })
  })

  it('the fade-out safety timer (endLeave) fires with no document: nothing is thrown', async () => {
    vi.useFakeTimers()
    const router = makeRouter()
    await router.push('/user/dashboard')
    router.beforeResolve(() => new Promise<boolean>(() => undefined)) // never answers
    void router.push('/user/calendar')
    await vi.advanceTimersByTimeAsync(10)
    expect(root().contains('vt-leave')).toBe(true) // the safety timer is armed
    withoutDocument(() => {
      expect(() => vi.advanceTimersByTime(1300)).not.toThrow()
    })
  })

  it('__resetViewTransitionsForTest leaves no timer of a screen change pending', async () => {
    vi.useFakeTimers()
    const router = makeRouter()
    await router.push('/user/dashboard')
    await router.push('/user/practice/7') // the fade-in timer
    router.beforeResolve(() => new Promise<boolean>(() => undefined))
    void router.push('/user/calendar') // the fade-out safety timer
    await vi.advanceTimersByTimeAsync(10)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    __resetViewTransitionsForTest()
    expect(vi.getTimerCount()).toBe(0)
  })
})
