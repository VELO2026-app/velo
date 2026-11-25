// Idle prefetch of the tab screens' chunks: once per zone, once per path,
// and a failed chunk may be retried. A screen outside the tab zones warms
// nothing.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { MASTER_TABS, USER_TABS } from '@/router/tabs'

const idle: Array<() => void> = []
vi.mock('@/platform/dom', () => ({ whenIdle: (task: () => void) => idle.push(task) }))
const warmTabData = vi.fn()
vi.mock('@/router/dataPrefetch', () => ({ warmTabData: (path: string) => warmTabData(path) }))

const Stub = { render: () => null }

async function load(): Promise<typeof import('@/router/prefetch')> {
  vi.resetModules()
  return import('@/router/prefetch')
}

function build(loader: () => Promise<unknown>): Router {
  const tabs = [...USER_TABS, ...MASTER_TABS].map((tab) => ({
    path: tab.to,
    component: loader,
  }))
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: Stub }, { path: '/login', component: Stub }, ...tabs],
  })
}

beforeEach(() => {
  idle.length = 0
  warmTabData.mockReset()
})

describe('warmRoute', () => {
  it('loads a lazy screen once and warms its data every time', async () => {
    const { warmRoute } = await load()
    const loader = vi.fn(() => Promise.resolve(Stub))
    const router = build(loader)

    warmRoute(router, '/user/dashboard')
    warmRoute(router, '/user/dashboard')

    expect(loader).toHaveBeenCalledTimes(1)
    expect(warmTabData).toHaveBeenCalledTimes(2)
  })

  it('tries a chunk again after it failed to load', async () => {
    const { warmRoute } = await load()
    const loader = vi.fn(() => Promise.reject(new Error('offline')))
    const router = build(loader)

    warmRoute(router, '/user/dashboard')
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    warmRoute(router, '/user/dashboard')

    expect(loader).toHaveBeenCalledTimes(2)
  })
})

describe('installTabPrefetch', () => {
  it('warms the tabs of the zone a navigation lands in, once per zone', async () => {
    const { installTabPrefetch } = await load()
    const loader = vi.fn(() => Promise.resolve(Stub))
    const router = build(loader)
    installTabPrefetch(router)

    await router.push('/user/dashboard')
    await router.push(USER_TABS[1]?.to ?? '/')
    expect(idle).toHaveLength(1)
    idle[0]?.()

    expect(warmTabData.mock.calls.map(([path]) => path)).toEqual(USER_TABS.map((tab) => tab.to))
  })

  it('warms nothing on a screen outside the tab zones', async () => {
    const { installTabPrefetch } = await load()
    const router = build(() => Promise.resolve(Stub))
    installTabPrefetch(router)

    await router.push('/login')

    expect(idle).toHaveLength(0)
  })

  it('warms nothing after a navigation that was refused', async () => {
    const { installTabPrefetch } = await load()
    const router = build(() => Promise.resolve(Stub))
    router.beforeEach((to) => to.path !== '/master/dashboard')
    installTabPrefetch(router)

    await router.push('/master/dashboard')

    expect(idle).toHaveLength(0)
  })
})
