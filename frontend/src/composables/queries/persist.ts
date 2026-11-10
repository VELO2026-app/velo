// =============================================================================
// VELO Frontend -- Colada queries that survive a reload (FE-157 4F)
// =============================================================================
//
// The Colada side of composables/persistedCache: a query that opts in with
// `meta: { persist: true }` is mirrored into the same per-account
// sessionStorage copy the in-house cache and the stores use, and on the next
// start an empty entry takes that copy at once -- left stale, so its screen
// revalidates it right away (the rule persistedCache already states).
//
// Why a plugin over persistedCache and not the official
// @pinia/colada-plugin-cache-persister: persistedCache already owns the
// account boundary (one key per account, every other account's copy dropped
// on owner change, all of it on sign-out), the size cap and the batched
// write, and the stores still on it share one budget with Colada. The
// official persister writes one storage key for the whole filtered cache and
// knows nothing of accounts.
//
// Not registered in coladaOptions yet: no Colada query persists in the pilot.
// The migration registers it with the first persisted query (the dashboard's
// upcoming list and stats, the schools tab -- see persistedCache's list).
// =============================================================================

import type { PiniaColadaPluginContext, UseQueryEntry } from '@pinia/colada'
import { readPersisted, writePersisted } from '@/composables/persistedCache'

/** persistedCache slot of one Colada entry (prefix apart from the in-house cache's `q:`). */
export function persistSlot(keyHash: string): string {
  return `colada:${keyHash}`
}

function persists(entry: UseQueryEntry): boolean {
  return entry.meta.persist === true
}

/**
 * Colada plugin: mirror the queries marked `meta: { persist: true }` across
 * reloads through composables/persistedCache.
 *
 * @remarks
 * Hydrates an entry the first time it is ensured with no data (status
 * `pending`, never fetched): the copy is set as data with `when` left at 0,
 * so the entry is stale and its reader fetches at once. Writes every success
 * state -- a fetch answer and a `setQueryData()` from a mutation alike.
 * `meta` is read from the entry, which takes it when it is created: a key
 * first written by `setQueryData()` before any `useQuery()` asked for it is
 * not persisted until it is created again.
 */
export function persistPlugin({ queryCache }: PiniaColadaPluginContext): void {
  let hydrating = false
  queryCache.$onAction(({ name, args, after }) => {
    if (name === 'ensure') {
      after((entry) => {
        if (!persists(entry) || entry.state.value.status !== 'pending' || entry.when !== 0) return
        const saved = readPersisted<unknown>(persistSlot(entry.keyHash))
        if (!saved) return
        hydrating = true
        try {
          queryCache.setEntryState(entry, { status: 'success', data: saved.data, error: null })
        } finally {
          hydrating = false
        }
        entry.when = 0
      })
    } else if (name === 'setEntryState' && !hydrating) {
      const [entry, state] = args
      if (persists(entry) && state.status === 'success') {
        writePersisted(persistSlot(entry.keyHash), state.data)
      }
    }
  })
}
