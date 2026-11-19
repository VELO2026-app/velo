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
import { useAdminMutation } from '@/composables/queries/admin'

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
    useQueryScopeStore(app!.config.globalProperties.$pinia).$reset()
    // The next session's catalog, loaded before the old answer lands.
    holdCatalog(queryCache)
    answer()
    await done

    expect(written).toEqual([])
    expect(queryCache.get(adminKeys.taxonomy())?.stale).toBe(false)
  })
})
