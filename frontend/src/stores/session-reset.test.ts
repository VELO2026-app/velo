// =============================================================================
// VELO Frontend -- every store at the account boundary (FE-157 stage 3)
// =============================================================================
//
// The review finding this pins: logout and a 401 reset stores from two
// different, incomplete lists, and diary.$reset() ran nowhere -- the next
// account in the same page could see the previous one's data. Now the end of
// a session resets every store through the account scope
// (platform/session.ts), and this file holds EVERY store module in
// src/stores to it:
//
//   1. the contract -- each store's $reset() returns every state field to
//      the value a fresh store starts with (fields are dirtied generically,
//      so a field a $reset forgets fails here, not in production);
//   2. logout and a 401 for the current token, over the REAL client with
//      fetch stubbed, leave every store in its initial state;
//   3. a store whose OWN request gets the 401 stays initial too: the reset
//      runs inside the client before that request's catch, so the catch
//      must not write its error into the next account's store.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import { createPinia, setActivePinia, type Pinia, type StoreGeneric } from 'pinia'
import { accountScopePlugin, resetAccountScope } from '@/platform/session'
import { api } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useAdminStore } from '@/stores/admin'
import { useDiaryStore } from '@/stores/diary'
import { usePracticesStore } from '@/stores/practices'

type StoreFactory = () => StoreGeneric

// Every store module in this folder, so a new store is covered without
// editing this file.
const modules = import.meta.glob<Record<string, unknown>>(['./*.ts', '!./*.test.ts'], {
  eager: true,
})
const factories: StoreFactory[] = Object.values(modules).flatMap((module) =>
  Object.entries(module)
    .filter(([name, value]) => /^use\w+Store$/.test(name) && typeof value === 'function')
    .map(([, value]) => value as StoreFactory),
)

/** The session owner: _clearSession clears it, the account scope skips it. */
const SESSION_OWNER = 'auth'

/**
 * Stores that do not own a $reset, so the account scope leaves them out.
 * Empty since FE-157 gave `ui` its reset; a store listed here must really
 * have none (the test below checks it).
 */
const KNOWN_WITHOUT_RESET: string[] = []

/**
 * Stores whose $reset is complete but that start a request right after it.
 * Empty since FE-157 moved the bookings reload from a statusFilter watcher
 * into setStatusFilter; a store listed here gets `it.fails` cases below.
 */
const KNOWN_REFETCH_AFTER_RESET: string[] = []

/** A Pinia set up the way app.ts sets it up, with every store created in it. */
function installAllStores(): { pinia: Pinia; stores: Map<string, StoreGeneric> } {
  const pinia = createPinia().use(accountScopePlugin)
  createApp({}).use(pinia)
  setActivePinia(pinia)
  const stores = new Map<string, StoreGeneric>()
  for (const useStore of factories) {
    const store = useStore()
    stores.set(store.$id, store)
  }
  return { pinia, stores }
}

/** A comparable copy of a store's state (Maps, Sets and Dates included). */
function snapshot(value: unknown): unknown {
  if (value instanceof Map) return ['Map', [...value.entries()].map(([k, v]) => [k, snapshot(v)])]
  if (value instanceof Set) return ['Set', [...value.values()].map(snapshot)]
  if (value instanceof Date) return ['Date', value.getTime()]
  if (Array.isArray(value)) return value.map(snapshot)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, snapshot(inner)] as const),
    )
  }
  return value
}

/** A different value of the same kind; containers are changed in place. */
function dirtied(value: unknown): unknown {
  if (value === null || value === undefined) return { dirty: true }
  if (typeof value === 'string') return `${value}#dirty`
  if (typeof value === 'number') return value + 1
  if (typeof value === 'boolean') return !value
  if (value instanceof Date) return new Date(0)
  if (value instanceof Map) return value.set('dirty', { dirty: true })
  if (value instanceof Set) return value.add('dirty')
  if (Array.isArray(value)) {
    value.push({ id: 'dirty' })
    return value
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.length === 0) record.dirty = true
    for (const key of keys) record[key] = dirtied(record[key])
    return value
  }
  return value
}

/** Put a non-initial value into every state field of the store. */
function dirtyStore(store: StoreGeneric): void {
  const target = store as unknown as Record<string, unknown>
  for (const key of Object.keys(store.$state)) target[key] = dirtied(target[key])
}

/** Stores the account scope is responsible for. */
function accountStores(stores: Map<string, StoreGeneric>): StoreGeneric[] {
  return [...stores.values()].filter(
    (store) => store.$id !== SESSION_OWNER && !KNOWN_WITHOUT_RESET.includes(store.$id),
  )
}

describe('the store set', () => {
  it('covers every store module, including the ones that had no reset before FE-157', () => {
    const { stores } = installAllStores()
    expect([...stores.keys()]).toEqual(
      expect.arrayContaining([
        'auth',
        'admin',
        'balance',
        'bookings',
        'calendar',
        'diary',
        'master',
        'practices',
      ]),
    )
  })

  it('the stores listed as having no reset really have none (drop them once they do)', () => {
    const { pinia, stores } = installAllStores()
    for (const id of KNOWN_WITHOUT_RESET) {
      const store = stores.get(id)!
      dirtyStore(store)
      const dirty = snapshot(store.$state)
      resetAccountScope(pinia, SESSION_OWNER)
      expect(snapshot(store.$state), id).toEqual(dirty)
    }
  })
})

describe('the account-scope contract: $reset restores every state field', () => {
  const ids = (() => {
    const { stores } = installAllStores()
    return accountStores(stores).map((store) => store.$id)
  })()

  for (const id of ids) {
    it(`${id}`, () => {
      const { pinia, stores } = installAllStores()
      const store = stores.get(id)!
      const initial = snapshot(store.$state)

      dirtyStore(store)
      if (Object.keys(store.$state).length > 0) {
        expect(snapshot(store.$state)).not.toEqual(initial)
      }
      resetAccountScope(pinia, SESSION_OWNER)

      expect(snapshot(store.$state)).toEqual(initial)
    })
  }
})

describe('the end of a session leaves every store in its initial state', () => {
  /** What fetch answers for anything that is not sign-in or logout. */
  let otherwise: () => Response | Promise<Response>
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  beforeEach(() => {
    otherwise = () => json(200, {})
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url.endsWith('/api/v1/auth/telegram')) {
          return json(200, { session_token: 'tok_1', user: { id: 'user_1', role: 'admin' } })
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

  /** Signed in, with a snapshot of every store's initial state taken first. */
  async function signedIn(): Promise<{
    stores: Map<string, StoreGeneric>
    initial: Map<string, unknown>
  }> {
    const { stores } = installAllStores()
    const initial = new Map(
      accountStores(stores).map((store) => [store.$id, snapshot(store.$state)] as const),
    )
    await expect(useAuthStore().loginViaTelegram('init-data')).resolves.toBe(true)
    return { stores, initial }
  }

  function expectInitial(
    stores: Map<string, StoreGeneric>,
    initial: Map<string, unknown>,
    skip: readonly string[] = [],
  ): void {
    for (const store of accountStores(stores)) {
      if (skip.includes(store.$id)) continue
      expect(snapshot(store.$state), store.$id).toEqual(initial.get(store.$id))
    }
    const auth = useAuthStore()
    expect(auth.token).toBeNull()
    expect(auth.user).toBeNull()
  }

  it('after logout', async () => {
    const { stores, initial } = await signedIn()
    for (const store of accountStores(stores)) dirtyStore(store)

    await useAuthStore().logout()

    expectInitial(stores, initial, KNOWN_REFETCH_AFTER_RESET)
  })

  it('after a 401 for the current token', async () => {
    const { stores, initial } = await signedIn()
    for (const store of accountStores(stores)) dirtyStore(store)
    otherwise = () => json(401, {})

    await expect(api.get('/api/v1/users/me')).rejects.toMatchObject({ status: 401 })

    expectInitial(stores, initial, KNOWN_REFETCH_AFTER_RESET)
  })

  for (const id of KNOWN_REFETCH_AFTER_RESET) {
    it.fails(`known gap: ${id} is not initial after logout`, async () => {
      const { stores, initial } = await signedIn()
      dirtyStore(stores.get(id)!)

      await useAuthStore().logout()

      expect(snapshot(stores.get(id)!.$state)).toEqual(initial.get(id))
    })

    it.fails(`known gap: ${id} is not initial after a 401`, async () => {
      const { stores, initial } = await signedIn()
      dirtyStore(stores.get(id)!)
      otherwise = () => json(401, {})

      await expect(api.get('/api/v1/users/me')).rejects.toMatchObject({ status: 401 })

      expect(snapshot(stores.get(id)!.$state)).toEqual(initial.get(id))
    })
  }

  it("drops the previous account's answers that land after logout", async () => {
    const { stores, initial } = await signedIn()
    // Every data request hangs until released, then answers with a body
    // that each of these stores would accept as data.
    const held: Array<() => void> = []
    otherwise = () =>
      new Promise((resolve) => {
        held.push(() =>
          resolve(
            json(200, {
              id: 'previous_account',
              items: [{ id: 'previous_account' }],
              total: 3,
              unread: 5,
              next_cursor: null,
            }),
          ),
        )
      })
    const inFlight = [
      useAdminStore().fetchDashboard(true),
      useAdminStore().fetchOverview('week'),
      useDiaryStore().fetchFeed(),
      useDiaryStore().fetchEntry('entry_1'),
      useDiaryStore().loadInsights('practice_1'),
      usePracticesStore().fetchPractice('practice_1'),
      // The bookings and calendar stores hold no server data since FE-166
      // steps 3-4, and neither do the schools hub (no store at all) and the
      // master store since step 5, nor the bell's badge since step 6; their
      // queries are Colada entries, emptied by the account scope
      // (composables/queries/setup.test.ts, schoolsHub.test.ts,
      // master.test.ts, notifications.test.ts).
    ]

    await useAuthStore().logout()
    for (const release of held) release()
    await Promise.all(inFlight)

    expectInitial(stores, initial)
  })

  // The store's own request is the one answered 401: the reset happens
  // inside it, and its catch must not write into the next account's store.
  const ownRequests: Array<[string, () => Promise<unknown>]> = [
    ['admin dashboard', () => useAdminStore().fetchDashboard(true)],
    ['admin overview', () => useAdminStore().fetchOverview('week')],
    ['diary feed', () => useDiaryStore().fetchFeed()],
    ['diary entry', () => useDiaryStore().fetchEntry('entry_1')],
    ['diary insights', () => useDiaryStore().loadInsights('practice_1')],
    ['practice detail', () => usePracticesStore().fetchPractice('practice_1')],
  ]
  for (const [name, run] of ownRequests) {
    it(`after a 401 to the store's own request: ${name}`, async () => {
      const { stores, initial } = await signedIn()
      otherwise = () => json(401, {})

      await run()

      expectInitial(stores, initial)
    })
  }
})
