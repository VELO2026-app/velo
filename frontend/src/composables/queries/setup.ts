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
import { persistPlugin } from '@/composables/queries/persist'
import { replaceEqualDeep } from '@/utils/structuralShare'

/** Default staleness window of every query that does not set its own (ms). */
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
 * Holds no state of its own beyond the session generation. Created by
 * `coladaOptions`'s plugin at install; platform/session.ts enrolls it like
 * any store with a `$reset()`, and `resetAccountScope()` (stores/auth.ts, at
 * every session end) calls it. A mutation entry keeps the variables and the
 * answer of its last call, so it goes too.
 *
 * A mutation still in flight cannot be cancelled and its `onSuccess` still
 * runs when the answer lands -- by then on the next session's (reset)
 * stores. The same generation guard every account-scope store keeps for its
 * own requests (bumped by `$reset`) covers it: a mutation captures
 * `generation()` in `onMutate` and its `onSuccess` returns early when the
 * value moved on (see queries/bookings.ts).
 */
export const useQueryScopeStore = defineStore(QUERY_SCOPE_STORE_ID, () => {
  const queryCache = useQueryCache()
  const mutationCache = useMutationCache()
  // Bumped by $reset: a mutation answered after it belongs to the previous session.
  let sessionGeneration = 0

  /** The current session generation (changes at every session end). */
  function generation(): number {
    return sessionGeneration
  }

  function $reset(): void {
    sessionGeneration += 1
    clearQueryCache(queryCache)
    for (const entry of mutationCache.getEntries()) mutationCache.remove(entry)
  }

  return { generation, $reset }
})

/** Colada plugin: create the account-scope member as soon as Colada is installed. */
function accountScope({ pinia }: PiniaColadaPluginContext): void {
  useQueryScopeStore(pinia)
}

/**
 * Colada plugin: structural sharing for every query answer.
 *
 * @remarks
 * Colada stores each answer as it arrives, so a revalidation that brings the
 * SAME data hands the screen new objects everywhere -- every computed over it
 * re-runs and the DOM is patched (a list re-renders, an animation restarts).
 * The in-house cache and the stores kept the shown references for an
 * unchanged answer (utils/structuralShare). This keeps that rule: a success
 * state's data is merged into the data already held -- unchanged parts keep
 * their references, an unchanged answer keeps all of them.
 *
 * Runs before the action (Pinia `$onAction` callbacks run first), on the very
 * state object the action is about to store.
 */
function structuralSharing({ queryCache }: PiniaColadaPluginContext): void {
  queryCache.$onAction(({ name, args }) => {
    if (name !== 'setEntryState') return
    const [entry, state] = args
    const held: unknown = entry.state.value.data
    if (state.status !== 'success' || held === undefined) return
    state.data = replaceEqualDeep(held, state.data)
  })
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
  plugins: [accountScope, structuralSharing, persistPlugin],
}
