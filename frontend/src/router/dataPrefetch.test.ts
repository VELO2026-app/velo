// =============================================================================
// VELO Frontend -- idle data prefetch of the tab screens
// =============================================================================
//
// Contract: after the first screen of the user zone, past the delay and in an
// idle slot, every OTHER tab's warmer runs -- once per session, one after
// another, never for the open tab, never on a constrained network; a failing
// warmer stops nothing. Only with a session (a token or a user): without one
// nothing is requested, and the zone is warmed once a session appears.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { coladaOptions } from '@/composables/queries/setup'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'

const calls: string[] = []
const constrained = { value: false }

vi.mock('@/platform/dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/platform/dom')>()
  return {
    ...actual,
    whenIdle: (task: () => void) => setTimeout(task, 0),
    isConstrainedNetwork: () => constrained.value,
  }
})

vi.mock('@/composables/queries/notifications', () => ({
  refreshUnread: () => {
    calls.push('bell')
    return Promise.resolve()
  },
}))
vi.mock('@/stores/calendar', () => ({
  homeWeekParams: () => ({
    from: '2026-06-14T00:00:00.000Z',
    to: '2026-06-22T23:59:59.999Z',
    filters: {},
    master: null,
    schoolFilter: null,
    school: null,
  }),
  calendarDateInTz: () => '',
  useCalendarStore: () => ({
    tabWeekParams: () => ({
      from: '2026-06-14T00:00:00.000Z',
      to: '2026-06-22T23:59:59.999Z',
      filters: {},
      master: null,
      schoolFilter: null,
      school: null,
    }),
  }),
}))
// The calendar warmer loads the tab's week through its Colada query.
vi.mock('@/api/practices', () => ({
  getPractices: () => {
    calls.push('calendar')
    return Promise.reject(new Error('offline')) // must not stop the rest
  },
}))
vi.mock('@/stores/diary', () => ({
  useDiaryStore: () => ({
    fetchFeed: () => {
      calls.push('diary')
      return Promise.resolve()
    },
  }),
}))
const session = vi.hoisted(() => ({
  auth: null as null | { token: string | null; user: object | null; role: string },
}))
vi.mock('@/stores/auth', async () => {
  const { reactive } = await import('vue')
  const auth = reactive({ token: 'tok' as string | null, user: null, role: 'user' })
  session.auth = auth
  return { useAuthStore: () => auth }
})
vi.mock('@/api/bookings', () => ({
  getUpcomingBookings: () => {
    calls.push('upcoming')
    return Promise.resolve([])
  },
  getMyStats: () => {
    calls.push('stats')
    return Promise.resolve({ practices_attended: 0, hours_attended: 0 })
  },
}))

const { DATA_PREFETCH_DELAY_MS, TAB_DATA_WARMERS, installDataPrefetch, warmTabData } =
  await import('@/router/dataPrefetch')

const Blank = defineComponent({ render: () => h('div') })

function makeRouter(): Router {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: ['/user/dashboard', '/user/calendar', '/user/diary', '/user/profile', '/master/x'].map(
      (path) => ({ path, component: Blank }),
    ),
  })
  installDataPrefetch(router)
  return router
}

async function runAll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(DATA_PREFETCH_DELAY_MS + 50)
  // The warmers import their stores lazily: let every chained import land.
  for (let i = 0; i < 10; i++) {
    await vi.dynamicImportSettled()
    await vi.advanceTimersByTimeAsync(10)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  calls.length = 0
  // The stats and schools warmers fill the Colada cache the screens read.
  const pinia = createPinia()
  createApp({}).use(pinia).use(PiniaColada, coladaOptions)
  setActivePinia(pinia)
  constrained.value = false
  if (session.auth) {
    session.auth.token = 'tok'
    session.auth.user = null
  }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('installDataPrefetch', () => {
  it('nothing before the delay; then every other tab of the zone, the open one skipped', async () => {
    const router = makeRouter()
    await router.push('/user/dashboard')
    await vi.advanceTimersByTimeAsync(DATA_PREFETCH_DELAY_MS - 100)
    expect(calls).toEqual([])

    await runAll()
    expect(calls).toContain('calendar')
    expect(calls).toContain('diary') // after the failing calendar warmer
    expect(calls).toContain('stats') // profile
    expect(calls).not.toContain('upcoming') // the open tab loads itself
  })

  it('from another tab, the dashboard warmer fills the upcoming entry; within its staleTime it is not asked again', async () => {
    const router = makeRouter()
    await router.push('/user/calendar')
    await runAll()
    expect(calls.filter((c) => c === 'upcoming')).toHaveLength(1)

    await TAB_DATA_WARMERS['/user/dashboard']!()
    expect(calls.filter((c) => c === 'upcoming')).toHaveLength(1)
  })

  it('once per session: later navigations do not schedule it again', async () => {
    const router = makeRouter()
    await router.push('/user/dashboard')
    await runAll()
    const first = calls.length
    await router.push('/user/calendar')
    await router.push('/user/dashboard')
    await runAll()
    expect(calls.length).toBe(first)
  })

  it('Data Saver / 2G: nothing is prefetched', async () => {
    constrained.value = true
    const router = makeRouter()
    await router.push('/user/dashboard')
    await runAll()
    expect(calls).toEqual([])
  })

  it('no session: no requests; the zone is warmed once a session appears', async () => {
    await import('@/stores/auth') // create the reactive mock
    session.auth!.token = null
    const router = makeRouter()
    await router.push('/user/dashboard')
    await runAll()
    expect(calls).toEqual([])

    session.auth!.user = {} // a user alone counts as a session
    await runAll()
    expect(calls).toContain('calendar')
    expect(calls).toContain('diary')
    expect(calls).not.toContain('upcoming') // the open tab loads itself

    const first = calls.length
    session.auth!.user = null
    session.auth!.token = 'tok'
    await runAll()
    expect(calls.length).toBe(first) // one-shot: the watcher is gone
  })

  it('a second touch before the auth chunk lands is throttled', async () => {
    warmTabData('/user/profile')
    warmTabData('/user/profile')
    await runAll()
    expect(calls.filter((c) => c === 'stats')).toHaveLength(1)
  })

  it('no session: a dock finger-down warms nothing', async () => {
    await import('@/stores/auth')
    session.auth!.token = null
    warmTabData('/user/profile')
    await runAll()
    expect(calls).toEqual([])
  })

  it('a zone without warmers schedules nothing', async () => {
    const router = makeRouter()
    await router.push('/master/x')
    await runAll()
    expect(calls).toEqual([])
  })
})

describe('warmTabData (dock finger-down)', () => {
  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      await vi.dynamicImportSettled()
      await vi.advanceTimersByTimeAsync(1)
    }
  }

  it('starts right after the first paint, not seconds later', () => {
    expect(DATA_PREFETCH_DELAY_MS).toBeLessThanOrEqual(300)
  })

  it('warms that tab now; a second touch within the window is a no-op, later it warms again', async () => {
    warmTabData('/user/diary')
    await settle()
    expect(calls).toEqual(['diary'])
    warmTabData('/user/diary')
    await settle()
    expect(calls).toEqual(['diary'])
    await vi.advanceTimersByTimeAsync(16_000)
    warmTabData('/user/diary')
    await settle()
    expect(calls).toEqual(['diary', 'diary'])
  })

  it('a path without a warmer, or a constrained link: nothing', async () => {
    warmTabData('/master/x')
    constrained.value = true
    warmTabData('/user/calendar')
    await settle()
    expect(calls).toEqual([])
  })
})
