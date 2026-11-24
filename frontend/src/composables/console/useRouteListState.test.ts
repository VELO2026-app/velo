import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { useRouteListState, type RouteListState } from '@/composables/console/useRouteListState'

type Tab = 'all' | 'pending' | 'rejected'

let app: App | null = null
let router: Router
let state: RouteListState<Tab>

async function start(url: string): Promise<void> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/list', component: { render: () => null } }],
  })
  await router.push(url)
  const Host = defineComponent({
    setup() {
      state = useRouteListState<Tab>(['all', 'pending', 'rejected'])
      return () => h('div')
    },
  })
  app = createApp(Host).use(router)
  app.mount(document.createElement('div'))
}

afterEach(() => {
  app?.unmount()
})

describe('useRouteListState', () => {
  it('reads the tab and the page from the URL', async () => {
    await start('/list?tab=pending&page=3')

    expect(state.tab.value).toBe('pending')
    expect(state.page.value).toBe(3)
  })

  it.each(['/list', '/list?tab=nope&page=0', '/list?page=abc', '/list?page=2.5'])(
    'falls back to the first tab and page for %s',
    async (url) => {
      await start(url)

      expect(state.tab.value).toBe('all')
      expect(state.page.value).toBe(1)
    },
  )

  it('switching the tab goes back to the first page and leaves no mark for the first tab', async () => {
    await start('/list?tab=pending&page=3')

    state.setTab('rejected')
    await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({ tab: 'rejected' }))

    state.setTab('all')
    await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({}))
  })

  it('changing the page keeps the tab, and page 1 leaves no mark', async () => {
    await start('/list?tab=pending')

    state.setPage(2)
    await vi.waitFor(() =>
      expect(router.currentRoute.value.query).toEqual({ tab: 'pending', page: '2' }),
    )

    state.setPage(1)
    await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({ tab: 'pending' }))
  })
})
