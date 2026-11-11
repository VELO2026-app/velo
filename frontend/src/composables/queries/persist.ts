// =============================================================================
// VELO Frontend -- Colada queries that survive a reload (FE-157 4F)
// =============================================================================
//
// The Colada side of composables/persistedCache: a query that opts in with
// `meta: { persist: true }` is mirrored into the same per-account
// sessionStorage copy the stores use, and on the next
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
// Registered in coladaOptions (FE-166 step 2) with the first persisted
// queries: the stats (./stats.ts) and the schools tab (./schools.ts). The
// slot prefix changed with the move (`q:` -> `colada:`), so the first start
// after the release is one cold start for those two.
// =============================================================================

import type { EntryKey, PiniaColadaPluginContext, QueryCache, UseQueryEntry } from '@pinia/colada'
import {
  persistedNames,
  readPersisted,
  removePersisted,
  writePersisted,
} from '@/composables/persistedCache'

declare module '@pinia/colada' {
  interface TypesConfig {
    queryMeta: {
      /** Mirror this query across reloads (small, non-sensitive payloads only). */
      persist?: boolean
    }
  }
}

/** persistedCache slot of one Colada entry (prefix apart from the stores' slots). */
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

const SLOT_PREFIX = persistSlot('')

/** `prefix` matches `key` the way Colada matches a key filter: element by element, objects partially. */
function isPrefixOf(prefix: readonly unknown[], key: readonly unknown[]): boolean {
  return prefix.every((part, i) => isSubset(part, key[i]))
}

function isSubset(part: unknown, whole: unknown): boolean {
  if (part === whole) return true
  if (!part || !whole || typeof part !== 'object' || typeof whole !== 'object') return false
  return Object.entries(part).every(([k, v]) => isSubset(v, (whole as Record<string, unknown>)[k]))
}

/**
 * Drop the persisted copies under `prefix` that this session never loaded.
 *
 * @remarks
 * The ADR rule for invalidating data that is not in memory: an entry this
 * session holds is refetched (and rewritten) by the invalidation itself, but a
 * copy only on disk would be hydrated on the next read and show the state the
 * mutation just changed -- e.g. a cancelled booking on a dashboard opened
 * after the cancellation, until its own request answers.
 */
export function forgetPersisted(queryCache: QueryCache, prefix: EntryKey): void {
  for (const name of persistedNames(SLOT_PREFIX)) {
    let key: unknown
    try {
      key = JSON.parse(name.slice(SLOT_PREFIX.length))
    } catch {
      continue
    }
    if (!Array.isArray(key) || !isPrefixOf(prefix, key)) continue
    if (queryCache.get(key) === undefined) removePersisted(name)
  }
}
