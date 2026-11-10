// =============================================================================
// VELO Frontend -- the Colada caches at the account boundary (FE-157 4F)
// =============================================================================
//
// Pinia Colada keeps its caches in Pinia stores that have no `$reset()`, so
// the account scope (platform/session.ts) would skip them and the next
// account in the same page would read the previous one's answers. These
// tests pin the bridge in ./setup.ts: installing Colada with coladaOptions
// enrolls a member whose reset empties the caches -- through the account
// scope directly, and through the real session ends (logout, a 401).
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import {
  PiniaColada,
  useMutation,
  useMutationCache,
  useQuery,
  useQueryCache,
  type QueryCache,
} from '@pinia/colada'
import { accountScopePlugin, resetAccountScope } from '@/platform/session'
import { coladaOptions } from '@/composables/queries/setup'
import { keys } from '@/composables/queries/keys'
import { api } from '@/api/client'
import { useAuthStore } from '@/stores/auth'

let app: App | null = null
let host: HTMLElement | null = null

/** Pinia + Colada set up the way app.ts sets them up, with `root` mounted. */
function install(root = defineComponent({ render: () => null })): {
  pinia: Pinia
  queryCache: QueryCache
} {
  const pinia = createPinia().use(accountScopePlugin)
  app = createApp(root).use(pinia).use(PiniaColada, coladaOptions)
  host = document.createElement('div')
  app.mount(host)
  setActivePinia(pinia)
  const queryCache = app.runWithContext(() => useQueryCache())
  return { pinia, queryCache }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  app?.unmount()
  app = null
  host = null
})

describe('the account scope empties the Colada caches', () => {
  const shownKey = keys.practices.schoolFeed('g1', 5)
  const hangingKey = keys.schools.detail('g2')
  const idleKey = keys.schools.detail('g1')

  let releaseHanging: (value: { name: string }) => void
  let mutate: () => Promise<string>
  /** What the mounted screen renders from its query. */
  let shown: () => unknown

  // A screen with a query on screen, a query still waiting for its answer,
  // and a mutation that has run once.
  const Screen = defineComponent({
    setup() {
      const onScreen = useQuery({ key: shownKey, query: async () => [{ id: 'p1' }] })
      useQuery({
        key: hangingKey,
        query: () =>
          new Promise<{ name: string }>((resolve) => {
            releaseHanging = resolve
          }),
      })
      const mutation = useMutation({ mutation: async () => 'done' })
      mutate = () => mutation.mutateAsync()
      shown = () => onScreen.data.value
      return () => h('div')
    },
  })

  it('removes idle entries, empties the ones on screen, drops answers in flight', async () => {
    const { pinia, queryCache } = install(Screen)
    queryCache.setQueryData(idleKey, { name: 'previous account' })
    await flush()
    await mutate()
    expect(shown()).toEqual([{ id: 'p1' }])
    const mutationCache = app!.runWithContext(() => useMutationCache())
    expect(mutationCache.getEntries()).not.toHaveLength(0)

    resetAccountScope(pinia, 'auth')

    // Nobody reads it: gone.
    expect(queryCache.get(idleKey)).toBeUndefined()
    // On screen: the same entry (the screen keeps it), emptied and stale.
    const onScreen = queryCache.get(shownKey)!
    expect(onScreen.state.value).toEqual({ status: 'pending', data: undefined, error: null })
    expect(onScreen.stale).toBe(true)
    await flush()
    expect(shown()).toBeUndefined()
    // In flight: the previous account's answer lands nowhere.
    releaseHanging({ name: 'previous account' })
    await flush()
    expect(queryCache.getQueryData(hangingKey)).toBeUndefined()
    // Mutations remember their variables and answers: forgotten too.
    expect(mutationCache.getEntries()).toHaveLength(0)
  })

  it('is enrolled by the install alone, before any query has run', () => {
    const { pinia, queryCache } = install()
    queryCache.setQueryData(idleKey, { name: 'previous account' })

    resetAccountScope(pinia, 'auth')

    expect(queryCache.getEntries()).toHaveLength(0)
  })
})

describe('the end of a session empties the Colada caches', () => {
  /** What fetch answers for anything that is not sign-in or logout. */
  let otherwise: () => Response
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  beforeEach(() => {
    otherwise = () => json(200, {})
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url.endsWith('/api/v1/auth/telegram')) {
          return json(200, { session_token: 'tok_1', user: { id: 'user_1', role: 'user' } })
        }
        if (url.endsWith('/api/v1/auth/logout')) return new Response(null, { status: 204 })
        return otherwise()
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  async function signedInWithCachedData(): Promise<QueryCache> {
    const { queryCache } = install()
    await expect(useAuthStore().loginViaTelegram('init-data')).resolves.toBe(true)
    queryCache.setQueryData(keys.schools.detail('g1'), { name: 'previous account' })
    return queryCache
  }

  it('after logout', async () => {
    const queryCache = await signedInWithCachedData()

    await useAuthStore().logout()

    expect(queryCache.getEntries()).toHaveLength(0)
  })

  it('after a 401 for the current token', async () => {
    const queryCache = await signedInWithCachedData()
    otherwise = () => json(401, {})

    await expect(api.get('/api/v1/users/me')).rejects.toMatchObject({ status: 401 })

    expect(queryCache.getEntries()).toHaveLength(0)
  })
})
