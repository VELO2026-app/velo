import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, ref, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import {
  lastPageOf,
  useRouteListState,
  type RouteListState,
} from '@/composables/console/useRouteListState'

type Tab = 'all' | 'pending' | 'rejected'

let app: App | null = null
let router: Router
let state: RouteListState<Tab>
const lastPage = ref<number | undefined>(undefined)

async function start(url: string): Promise<void> {
  lastPage.value = undefined
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/list', component: { render: () => null } }],
  })
  await router.push(url)
  const Host = defineComponent({
    setup() {
      state = useRouteListState<Tab>(['all', 'pending', 'rejected'])
      state.clampTo(lastPage)
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

describe('useRouteListState: the last page', () => {
  it('replaces a page past the last one with the last, and leaves a page inside alone', async () => {
    await start('/list?tab=pending&page=5')

    // Nothing is known of the list yet: the URL stands.
    expect(router.currentRoute.value.query).toEqual({ tab: 'pending', page: '5' })

    lastPage.value = 2
    await vi.waitFor(() =>
      expect(router.currentRoute.value.query).toEqual({ tab: 'pending', page: '2' }),
    )

    lastPage.value = 9
    await vi.waitFor(() => expect(state.page.value).toBe(2))
  })

  it('drops the page mark when the last page is the first', async () => {
    await start('/list?page=3')

    lastPage.value = 1

    await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({}))
  })
})

describe('lastPageOf', () => {
  it.each([
    [undefined, undefined],
    [0, 1],
    [20, 1],
    [21, 2],
    [38, 2],
  ])('%s rows -> page %s', (total, last) => {
    expect(lastPageOf(total, 20)).toBe(last)
  })
})

describe('useRouteListState: other marks', () => {
  it('sets and clears a mark of the screen, back to the first page, keeping the tab', async () => {
    await start('/list?tab=pending&page=3')

    state.setQuery({ active: '1' })
    await vi.waitFor(() =>
      expect(router.currentRoute.value.query).toEqual({ tab: 'pending', active: '1' }),
    )

    state.setPage(4)
    await vi.waitFor(() => expect(router.currentRoute.value.query.page).toBe('4'))
    expect(router.currentRoute.value.query.active).toBe('1')

    state.setQuery({ active: undefined })
    await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({ tab: 'pending' }))
  })
})
