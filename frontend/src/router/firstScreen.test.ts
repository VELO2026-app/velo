// =============================================================================
// First-screen gate: the splash hands over once the route is resolved and
// the first screen's data is in -- or at the cap, whichever comes first.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

const warm = { resolve: null as null | (() => void), calls: 0 }
const shell = { calls: 0 }

vi.mock('@/router/dataPrefetch', () => ({
  TAB_DATA_WARMERS: {
    '/user/dashboard': () => {
      warm.calls++
      return new Promise<void>((resolve) => {
        warm.resolve = resolve
      })
    },
  },
}))
vi.mock('@/stores/schoolsHub', () => ({
  useSchoolsHubStore: () => ({
    ensureCurator: () => {
      shell.calls++
      return Promise.resolve()
    },
  }),
}))
vi.mock('@/platform/telegram-sdk', () => ({ viewportSettled: () => Promise.resolve() }))

const { firstScreenReady, FIRST_SCREEN_DATA_CAP_MS } = await import('@/router/firstScreen')

const Blank = defineComponent({ render: () => h('div') })

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', redirect: '/user/dashboard' },
      { path: '/user/dashboard', component: Blank },
      { path: '/user/other', component: Blank },
    ],
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  warm.resolve = null
  warm.calls = 0
  shell.calls = 0
})
afterEach(() => vi.useRealTimers())

describe('firstScreenReady', () => {
  it('waits for the resolved route (after the redirect) and its data', async () => {
    const router = makeRouter()
    void router.push('/')
    let done = false
    void firstScreenReady(router).then(() => (done = true))
    await vi.advanceTimersByTimeAsync(10)
    expect(router.currentRoute.value.path).toBe('/user/dashboard')
    expect(warm.calls).toBe(1)
    expect(shell.calls).toBe(1) // the dock's tab set too
    expect(done).toBe(false)
    warm.resolve?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
  })

  it('a slow answer: hands over at the cap', async () => {
    const router = makeRouter()
    void router.push('/user/dashboard')
    let done = false
    void firstScreenReady(router).then(() => (done = true))
    await vi.advanceTimersByTimeAsync(FIRST_SCREEN_DATA_CAP_MS - 50)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    expect(done).toBe(true)
  })

  it('a screen without a warmer: only the route (and the dock) is waited for', async () => {
    const router = makeRouter()
    void router.push('/user/other')
    let done = false
    void firstScreenReady(router).then(() => (done = true))
    await vi.advanceTimersByTimeAsync(5)
    expect(done).toBe(true)
    expect(warm.calls).toBe(0)
  })
})
