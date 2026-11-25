// =============================================================================
// VELO Frontend -- useAdminMutation: the session boundary (FE-181)
// =============================================================================
//
// Which keys a row makes stale is invalidation.test.ts's business, and each
// admin screen's suite proves its writes reach the screen. What is left is
// the account-scope invariant: an admin mutation answered after the session
// ended writes nothing and invalidates nothing in the next session's cache.
// =============================================================================

import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createPinia } from 'pinia'
import { PiniaColada, useQueryCache, type QueryCache } from '@pinia/colada'
import { coladaOptions, useQueryScopeStore } from '@/composables/queries/setup'
import { adminKeys } from '@/composables/queries/adminKeys'
import { dropReport, useAdminMutation } from '@/composables/queries/admin'

let app: App | null = null

afterEach(() => {
  app?.unmount()
  app = null
})

/** Mount a host running one admin mutation whose answer the test releases. */
function setup() {
  let queryCache!: QueryCache
  let answer!: () => void
  const written: string[] = []
  let run!: () => Promise<unknown>
  const Host = defineComponent({
    setup() {
      queryCache = useQueryCache()
      const mutation = useAdminMutation(
        'changeTaxonomy',
        () =>
          new Promise<string>((resolve) => {
            answer = () => resolve('answered')
          }),
        { write: (data) => written.push(data) },
      )
      run = () => mutation.mutateAsync()
      return () => h('div')
    },
  })
  app = createApp(Host).use(createPinia()).use(PiniaColada, coladaOptions)
  app.mount(document.createElement('div'))
  return { queryCache, written, run: () => run(), answer: () => answer() }
}

/** A held catalog, fresh for good: only an invalidation makes it stale. */
function holdCatalog(queryCache: QueryCache): void {
  queryCache.ensure({
    key: adminKeys.taxonomy(),
    query: async () => [],
    staleTime: Number.POSITIVE_INFINITY,
  })
  queryCache.setQueryData(adminKeys.taxonomy(), [])
}

describe('useAdminMutation', () => {
  it('writes and invalidates in the session it started in', async () => {
    const { queryCache, written, run, answer } = setup()
    holdCatalog(queryCache)

    const done = run()
    await nextTick()
    answer()
    await done

    expect(written).toEqual(['answered'])
    expect(queryCache.get(adminKeys.taxonomy())?.stale).toBe(true)
  })

  it('an answer after the session ended writes nothing and invalidates nothing', async () => {
    const { queryCache, written, run, answer } = setup()

    const done = run()
    await nextTick()
    // Logout / 401: resetAccountScope calls every member's $reset.
    useQueryScopeStore(app?.config.globalProperties.$pinia).$reset()
    // The next session's catalog, loaded before the old answer lands.
    holdCatalog(queryCache)
    answer()
    await done

    expect(written).toEqual([])
    expect(queryCache.get(adminKeys.taxonomy())?.stale).toBe(false)
  })
})

describe('dropReport', () => {
  /** A cache with two complaint lists held and one never read. */
  function cacheWithLists(): QueryCache {
    let queryCache!: QueryCache
    const Host = defineComponent({
      setup() {
        queryCache = useQueryCache()
        return () => h('div')
      },
    })
    app = createApp(Host).use(createPinia()).use(PiniaColada, coladaOptions)
    app.mount(document.createElement('div'))
    const report = (id: string) => ({ id })
    queryCache.setQueryData([...adminKeys.reportsAll(), 'pending'], {
      pageParams: [0, 20],
      pages: [
        { items: [report('r1'), report('r2')], total: 3, limit: 20, offset: 0 },
        { items: [report('r1')], total: 3, limit: 20, offset: 20 },
      ],
    })
    queryCache.setQueryData([...adminKeys.reportsAll(), 'resolved'], {
      pageParams: [0],
      pages: [{ items: [report('r9')], total: 1, limit: 20, offset: 0 }],
    })
    queryCache.ensure({ key: [...adminKeys.reportsAll(), 'never'], query: async () => null })
    return queryCache
  }

  it('takes the complaint off every list that holds it, its total down by one', () => {
    const queryCache = cacheWithLists()

    dropReport(queryCache, 'r1')

    const pending = queryCache.getQueryData([...adminKeys.reportsAll(), 'pending']) as {
      pages: Array<{ items: Array<{ id: string }>; total: number }>
    }
    expect(pending.pages.map((p) => p.items.map((r) => r.id))).toEqual([['r2'], []])
    expect(pending.pages.map((p) => p.total)).toEqual([2, 2])
  })

  it('leaves a list without the complaint, and a list never read, as they were', () => {
    const queryCache = cacheWithLists()

    dropReport(queryCache, 'r1')

    const resolved = queryCache.getQueryData([...adminKeys.reportsAll(), 'resolved']) as {
      pages: Array<{ total: number }>
    }
    expect(resolved.pages[0]?.total).toBe(1)
    expect(queryCache.getQueryData([...adminKeys.reportsAll(), 'never'])).toBeUndefined()
  })
})
