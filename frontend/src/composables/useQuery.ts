// =============================================================================
// VELO Frontend -- screen data cache: stale-while-revalidate (report §8.3.2)
// =============================================================================
//
// Why: a screen that keeps its data in a local ref loses it on unmount, so
// every visit (tab switch, «back») starts from a spinner and then swaps the
// content in with a jump. This is the small in-house answer, deliberately not
// a dependency (Pinia Colada / TanStack would bring far more than the app
// uses):
//
//   - one entry per KEY, shared by every screen that asks for it;
//   - a cached entry renders immediately; if it is older than `staleTime` it
//     is refreshed in the background (stale-while-revalidate);
//   - a failed refresh NEVER wipes data that is already on screen -- only
//     `error` is set, the screen decides how to mention it;
//   - concurrent requests for one key share one promise (dedupe);
//   - `keepPrevious`: while a NEW key loads (next week, next id), the previous
//     key's data stays on screen instead of collapsing to a skeleton;
//   - `placeholder`: a seed shown until the first response (e.g. the list
//     card's data for a detail screen); never stored as fresh data.
//
// HTTP stays in src/api (the query function is an api wrapper call). Server
// state only -- filters, drafts and selections stay in stores/components.
// The cache is cleared on sign-out (stores/auth.ts) and reset per test file
// (test-setup.ts). `persist: true` mirrors a key into composables/
// persistedCache (survives a reload, per account): the copy renders at once
// on the next start and is always revalidated in the background.
// =============================================================================

import {
  computed,
  onScopeDispose,
  shallowRef,
  toValue,
  watch,
  type ComputedRef,
  type MaybeRefOrGetter,
  type ShallowRef,
} from 'vue'
import { onDocumentEvent, isDocumentHidden } from '@/platform/dom'
import { readPersisted, writePersisted } from '@/composables/persistedCache'

export type QueryKey = readonly (string | number | boolean | null)[]

export interface QueryOptions<T> {
  key: QueryKey
  query: () => Promise<T>
  /** Data younger than this is fresh: no refetch on use (ms). */
  staleTime?: number
  /** Seed rendered until the first response; not cached. */
  placeholder?: () => T | undefined
  /** false = do not fetch (e.g. id not known yet). */
  enabled?: boolean
  /** Mirror this key across reloads (small, non-sensitive payloads only). */
  persist?: boolean
}

export interface UseQueryOptions {
  /** Keep the previous key's data on screen while a new key loads. */
  keepPrevious?: boolean
}

export interface QueryResult<T> {
  /** Cached data, else the previous key's (keepPrevious), else the placeholder. */
  data: ComputedRef<T | undefined>
  error: ComputedRef<unknown>
  /** Nothing to show yet and a request is in flight -- the skeleton state. */
  isPending: ComputedRef<boolean>
  /** Any request in flight (also a background refresh of shown data). */
  isFetching: ComputedRef<boolean>
  /** `data` is not this key's own response (placeholder / previous key). */
  isPlaceholder: ComputedRef<boolean>
  /** Refetch now (ignores staleTime); resolves when settled, never rejects. */
  refresh: () => Promise<void>
  /** Refresh only if stale -- what a fresh mount would do. For a screen kept
   * alive (TabRouterView) on re-activation; shown data stays on screen. */
  revalidate: () => Promise<void>
}

export const DEFAULT_STALE_TIME_MS = 30_000
/** Entries kept without subscribers; the oldest unused ones are dropped. */
const MAX_ENTRIES = 120

interface Entry {
  data: ShallowRef<unknown>
  error: ShallowRef<unknown>
  fetching: ShallowRef<boolean>
  /** 0 = never loaded or invalidated. */
  updatedAt: number
  promise: Promise<void> | null
  /** Last query function seen for this key (used by invalidate/refocus). */
  query: (() => Promise<unknown>) | null
  staleTime: number
  subscribers: number
  /** Bumped by setData/clear so an older in-flight response cannot overwrite. */
  version: number
  /** Mirrored into persistedCache. */
  persist: boolean
  /** serializeKey(key) of this entry. */
  hash: string
}

const entries = new Map<string, Entry>()

export function serializeKey(key: QueryKey): string {
  return JSON.stringify(key)
}

function entryFor(hash: string): Entry {
  let entry = entries.get(hash)
  if (!entry) {
    entry = {
      data: shallowRef<unknown>(undefined),
      error: shallowRef<unknown>(null),
      fetching: shallowRef(false),
      updatedAt: 0,
      promise: null,
      query: null,
      staleTime: DEFAULT_STALE_TIME_MS,
      subscribers: 0,
      version: 0,
      persist: false,
      hash,
    }
    entries.set(hash, entry)
    evictUnused()
  }
  return entry
}

function evictUnused(): void {
  if (entries.size <= MAX_ENTRIES) return
  for (const [hash, entry] of entries) {
    if (entries.size <= MAX_ENTRIES) return
    if (entry.subscribers === 0 && !entry.promise) entries.delete(hash)
  }
}

const persistName = (hash: string): string => `q:${hash}`

/** Opt a key into persistence; an empty entry takes the persisted copy
 * (left stale on purpose, so it is revalidated right away). */
function enablePersist(hash: string, entry: Entry): void {
  entry.persist = true
  if (entry.data.value !== undefined) return
  const saved = readPersisted<unknown>(persistName(hash))
  if (saved) entry.data.value = saved.data
}

function isStale(entry: Entry): boolean {
  // `staleTime: 0` is "always revalidate" -- also when the previous response
  // landed in the same millisecond as this mount (a fast remount in one tick
  // must not pin the cached copy).
  return (
    entry.updatedAt === 0 || entry.staleTime <= 0 || Date.now() - entry.updatedAt > entry.staleTime
  )
}

function run(entry: Entry): Promise<void> {
  if (entry.promise) return entry.promise
  const query = entry.query
  if (!query) return Promise.resolve()
  const version = entry.version
  entry.fetching.value = true
  entry.promise = query()
    .then((data) => {
      if (entry.version !== version) return
      entry.data.value = data
      entry.error.value = null
      entry.updatedAt = Date.now()
      if (entry.persist) writePersisted(persistName(entry.hash), data)
    })
    .catch((err: unknown) => {
      if (entry.version !== version) return
      // Data already on screen stays; the caller reads `error`.
      entry.error.value = err
    })
    .finally(() => {
      entry.fetching.value = false
      entry.promise = null
    })
  return entry.promise
}

let focusListenerInstalled = false
/** Returning to the app (Telegram minimize, tab switch) refreshes what is on
 * screen and stale -- one listener for the whole cache. */
function installFocusRefetch(): void {
  if (focusListenerInstalled) return
  focusListenerInstalled = true
  onDocumentEvent('visibilitychange', () => {
    if (isDocumentHidden()) return
    for (const entry of entries.values()) {
      if (entry.subscribers > 0 && isStale(entry)) void run(entry)
    }
  })
}

export function useQuery<T>(
  options: MaybeRefOrGetter<QueryOptions<T>>,
  { keepPrevious = false }: UseQueryOptions = {},
): QueryResult<T> {
  installFocusRefetch()
  const current = shallowRef<Entry | null>(null)
  const previousData = shallowRef<unknown>(undefined)
  const placeholder = computed(() => toValue(options).placeholder?.())

  watch(
    () => {
      const o = toValue(options)
      return o.enabled === false ? null : serializeKey(o.key)
    },
    (hash) => {
      const prev = current.value
      if (prev) {
        if (keepPrevious && prev.data.value !== undefined) previousData.value = prev.data.value
        prev.subscribers -= 1
      }
      if (hash === null) {
        current.value = null
        return
      }
      const o = toValue(options)
      const entry = entryFor(hash)
      entry.subscribers += 1
      entry.query = o.query
      entry.staleTime = o.staleTime ?? DEFAULT_STALE_TIME_MS
      if (o.persist) enablePersist(hash, entry)
      current.value = entry
      if (entry.data.value !== undefined) previousData.value = undefined
      if (isStale(entry)) void run(entry)
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    if (current.value) current.value.subscribers -= 1
    current.value = null
  })

  const own = computed(() => current.value?.data.value as T | undefined)
  const data = computed<T | undefined>(
    () => own.value ?? (previousData.value as T | undefined) ?? placeholder.value,
  )
  const isFetching = computed(() => current.value?.fetching.value ?? false)

  return {
    data,
    error: computed(() => current.value?.error.value ?? null),
    isPending: computed(() => data.value === undefined && isFetching.value),
    isFetching,
    isPlaceholder: computed(() => own.value === undefined && data.value !== undefined),
    refresh: () => (current.value ? run(current.value) : Promise.resolve()),
    revalidate: () =>
      current.value && isStale(current.value) ? run(current.value) : Promise.resolve(),
  }
}

/** Imperative access for prefetch, optimistic updates and invalidation. */
export const queryCache = {
  /** This key's cached data (undefined when never loaded). */
  get<T>(key: QueryKey): T | undefined {
    return entries.get(serializeKey(key))?.data.value as T | undefined
  },

  /** Write data (optimistic update / response of a mutation). Wins over any
   * response still in flight for the key. `undefined` from the updater = no-op. */
  setData<T>(key: QueryKey, updater: (old: T | undefined) => T | undefined): void {
    const entry = entryFor(serializeKey(key))
    const next = updater(entry.data.value as T | undefined)
    if (next === undefined) return
    entry.version += 1
    entry.data.value = next
    entry.error.value = null
    entry.updatedAt = Date.now()
    if (entry.persist) writePersisted(persistName(serializeKey(key)), next)
  },

  /** Placeholder from a list that already holds the same DTO: written only
   * when the key has no data, and left stale so the first reader refetches. */
  seed<T>(key: QueryKey, data: T): void {
    const entry = entryFor(serializeKey(key))
    if (entry.data.value === undefined) entry.data.value = data
  },

  /** True when this key's data was loaded within the last `maxAgeMs`. */
  isFresh(key: QueryKey, maxAgeMs: number): boolean {
    const entry = entries.get(serializeKey(key))
    return !!entry && entry.updatedAt > 0 && Date.now() - entry.updatedAt <= maxAgeMs
  },

  /** Load a key ahead of navigation; resolves when settled (never rejects).
   * Fresh data is not refetched. */
  prefetch<T>(
    key: QueryKey,
    query: () => Promise<T>,
    staleTime = DEFAULT_STALE_TIME_MS,
    persist = false,
  ): Promise<void> {
    const hash = serializeKey(key)
    const entry = entryFor(hash)
    entry.query = entry.query ?? query
    entry.staleTime = staleTime
    if (persist) enablePersist(hash, entry)
    return isStale(entry) ? run(entry) : Promise.resolve()
  },

  /** Mark every key that starts with `prefix` stale; keys on screen refetch now. */
  invalidate(prefix: QueryKey): void {
    for (const [hash, entry] of entries) {
      if (!startsWith(hash, prefix)) continue
      entry.updatedAt = 0
      if (entry.subscribers > 0) void run(entry)
    }
  },

  /** Drop everything (sign-out, account switch, tests). */
  clear(): void {
    for (const entry of entries.values()) entry.version += 1
    entries.clear()
  },
}

function startsWith(hash: string, prefix: QueryKey): boolean {
  if (prefix.length === 0) return true
  const head = serializeKey(prefix).slice(0, -1) // drop the closing bracket
  return hash === `${head}]` || hash.startsWith(`${head},`)
}
