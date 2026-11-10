// =============================================================================
// VELO Frontend -- Pinia Colada install options and the account scope (FE-157 4F)
// =============================================================================
//
// app.ts installs Colada with `coladaOptions`; tests mount with the same
// object, so a screen under test sees the production defaults.
//
// Account scope: the Colada caches are Pinia stores, but setup stores without
// a `$reset()`, so platform/session.ts (accountScopePlugin) does not enroll
// them and the end of a session would leave the previous account's answers in
// memory for the next one. `useQueryScopeStore` is the member that does own a
// `$reset()`: it empties both caches. The Colada plugin below creates it at
// install, so it is enrolled before any query runs -- no screen has to
// remember it, and stores/auth.ts needs no new line.
// =============================================================================

import {
  useMutationCache,
  useQueryCache,
  type PiniaColadaOptions,
  type PiniaColadaPluginContext,
  type QueryCache,
} from '@pinia/colada'
import { defineStore } from 'pinia'

/** Default staleness window: the same 30 s as the in-house useQuery, so both caches age data alike while they coexist. */
export const QUERY_STALE_MS = 30_000

/** Pinia id of the account-scope member that empties the Colada caches. */
export const QUERY_SCOPE_STORE_ID = 'queryScope'

/**
 * Empty the query cache at the end of a session.
 *
 * @remarks
 * An answer still in flight is cancelled, so it lands nowhere (Colada drops
 * the result of a cancelled fetch). An entry nobody uses is removed. An entry
 * a mounted or kept-alive screen still holds cannot be removed (the screen
 * would keep a detached copy), so it is emptied in place instead: back to
 * `pending` with no data, and stale, so its next reader fetches again.
 */
export function clearQueryCache(queryCache: QueryCache): void {
  for (const entry of queryCache.getEntries()) {
    queryCache.cancel(entry)
    if (entry.active) {
      queryCache.setEntryState(entry, { status: 'pending', data: undefined, error: null })
      entry.placeholderData = null
      queryCache.invalidate(entry)
    } else {
      queryCache.remove(entry)
    }
  }
}

/**
 * Account-scope member for the Pinia Colada caches: its `$reset()` empties the
 * query cache and forgets every mutation entry.
 *
 * @remarks
 * Holds no state of its own. Created by `coladaOptions`'s plugin at
 * install; platform/session.ts enrolls it like any store with a `$reset()`,
 * and `resetAccountScope()` (stores/auth.ts, at every session end) calls it.
 * A mutation entry keeps the variables and the answer of its last call, so
 * it goes too; a mutation still in flight finishes on its own.
 */
export const useQueryScopeStore = defineStore(QUERY_SCOPE_STORE_ID, () => {
  const queryCache = useQueryCache()
  const mutationCache = useMutationCache()

  function $reset(): void {
    clearQueryCache(queryCache)
    for (const entry of mutationCache.getEntries()) mutationCache.remove(entry)
  }

  return { $reset }
})

/** Colada plugin: create the account-scope member as soon as Colada is installed. */
function accountScope({ pinia }: PiniaColadaPluginContext): void {
  useQueryScopeStore(pinia)
}

/**
 * Options for `app.use(PiniaColada, coladaOptions)`, shared by app.ts and the tests.
 *
 * @remarks
 * Install AFTER `app.use(pinia)`: Colada keeps its caches in that Pinia, and
 * the account scope needs `accountScopePlugin` registered on it first.
 */
export const coladaOptions: PiniaColadaOptions = {
  queryOptions: { staleTime: QUERY_STALE_MS },
  plugins: [accountScope],
}
