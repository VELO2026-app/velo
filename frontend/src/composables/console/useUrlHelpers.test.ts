// The console's URL helpers: what each reads from the query and what each
// writes back on a change.
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { useUrlChoice } from '@/composables/console/useUrlChoice'
import { useUrlPage } from '@/composables/console/useUrlPage'
import { useUrlSelection } from '@/composables/console/useUrlSelection'
import { useUrlTab } from '@/composables/console/useUrlTab'
import { pageCountOf } from '@/utils/console/pagerItems'

let app: App | null = null

async function withRouter<T>(
  query: Record<string, string>,
  use: () => T,
): Promise<{ api: T; router: Router }> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/list', component: { render: () => null } }],
  })
  await router.push({ path: '/list', query })
  const holder: { api?: T } = {}
  app = createApp(
    defineComponent({
      setup() {
        holder.api = use()
        return () => h('div')
      },
    }),
  ).use(router)
  app.mount(document.createElement('div'))
  if (holder.api === undefined) throw new Error('the helper did not run')
  return { api: holder.api, router }
}

async function settle(): Promise<void> {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  app?.unmount()
  app = null
})

describe('useUrlChoice', () => {
  it('reads a known value and drops the page on a change', async () => {
    const { api, router } = await withRouter({ kind: 'masters', page: '3' }, () =>
      useUrlChoice('kind', ['all', 'masters'] as const),
    )
    expect(api.value.value).toBe('masters')

    api.set('all')
    await settle()

    expect(router.currentRoute.value.query).toEqual({ kind: 'all' })
  })

  it('changes nothing for a value outside the set', async () => {
    const { api, router } = await withRouter({ kind: 'masters' }, () =>
      useUrlChoice('kind', ['all', 'masters'] as const),
    )

    api.set('unknown')
    await settle()

    expect(router.currentRoute.value.query).toEqual({ kind: 'masters' })
  })

  it('reads the first value when the query has none it knows', async () => {
    const { api } = await withRouter({ kind: 'other' }, () =>
      useUrlChoice('kind', ['all', 'masters'] as const),
    )

    expect(api.value.value).toBe('all')
  })
})

describe('useUrlPage', () => {
  it('reads a whole page number and leaves page 1 out of the URL', async () => {
    const { api, router } = await withRouter({ page: '4' }, () => useUrlPage())
    expect(api.page.value).toBe(4)

    api.setPage(1)
    await settle()

    expect(router.currentRoute.value.query.page).toBeUndefined()
  })

  it('reads page 1 for a page that is not a whole number above zero', async () => {
    const { api } = await withRouter({ page: '0' }, () => useUrlPage())

    expect(api.page.value).toBe(1)
  })
})

describe('useUrlTab', () => {
  it('switches the tab and keeps only the listed parameters', async () => {
    const { api, router } = await withRouter({ tab: 'b', keep: 'x', drop: 'y' }, () =>
      useUrlTab(['a', 'b'] as const, ['keep']),
    )
    expect(api.tab.value).toBe('b')

    api.tabModel.value = 'a'
    await settle()

    expect(router.currentRoute.value.query).toEqual({ keep: 'x', tab: 'a' })
  })
})

describe('useUrlSelection', () => {
  it('opens and leaves an item through the URL', async () => {
    const { api, router } = await withRouter({}, () => useUrlSelection('id'))
    expect(api.urlId.value).toBeNull()

    api.select('42')
    await settle()
    expect(api.urlId.value).toBe('42')

    api.clear()
    await settle()
    expect(router.currentRoute.value.query.id).toBeUndefined()
  })
})

describe('pageCountOf', () => {
  it.each([
    [0, 1],
    [20, 1],
    [21, 2],
  ])('%i rows of 20 make %i pages', (total, pages) => {
    expect(pageCountOf(total, 20)).toBe(pages)
  })
})
