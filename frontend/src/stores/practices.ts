// =============================================================================
// VELO Frontend -- Practices Store (Phase F3.1)
// =============================================================================
//
// Pinia store for single practice detail (PracticeDetailView and the
// live/checkin/reflection/feedback flow views). Uses api/practices.ts
// for typed API calls.
//
// The catalog (list) data flow this store originally also held has
// moved to stores/calendar.ts and MasterPublicView.vue -- see git
// history if you need the old paginated-catalog implementation.
//
// Stale-while-revalidate (loading system): every fetched practice is kept in
// the Colada query cache under `keys.practices.detail(id)` (FE-166 step 2),
// so the booking mutations' invalidation (composables/queries/invalidation)
// reaches it. Opening a practice that is
// already known -- seen before, or present in a list the caller passes as a
// seed -- renders it AT ONCE and refreshes it silently; `selectedLoading`
// (the skeleton) is only for a practice there is nothing to show for yet. A
// failed refresh keeps the shown practice, unless the server says it is gone.
// =============================================================================

import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getPractice } from '@/api/practices'
import { ApiResponseError } from '@/api/client'
import { extractApiError } from '@/composables/useApiError'
import { useQueryCache, type QueryCache } from '@pinia/colada'
import { keys } from '@/composables/queries/keys'
import { practiceDetailQuery } from '@/composables/queries/practices'
import type { PracticeResponse } from '@/api/types'
import i18n from '@/locales'

const { t } = i18n.global

/** How long a just-loaded practice counts as current for the screen opening it. */
const PRELOAD_HANDOFF_MS = 3_000

/**
 * Route preload (router meta.preload): start loading the practice while the
 * navigation is still pending, so the screen usually opens with it in hand.
 * Never rejects -- a failure surfaces when the screen fetches for itself.
 */
export async function prefetchPractice(id: string): Promise<void> {
  const queryCache = useQueryCache()
  if (isJustLoaded(queryCache, id)) return
  const entry = practiceEntry(queryCache, id)
  // An answer already on its way is shared, not asked for twice.
  await (entry.pending?.refreshCall ?? queryCache.fetch(entry)).catch(() => undefined)
}

/** Lists holding full practices (same DTO as the detail) prime the cache so
 * the detail screen opens with content instead of a skeleton. A seed never
 * replaces a loaded practice, and is left stale: its first reader refetches. */
export function seedPractices(list: readonly PracticeResponse[]): void {
  const queryCache = useQueryCache()
  for (const practice of list) {
    const entry = practiceEntry(queryCache, practice.id)
    if (entry.state.value.data !== undefined) continue
    queryCache.setEntryState(entry, { status: 'success', data: practice, error: null })
    entry.when = 0
  }
}

/**
 * The cache entry of one practice, created with the query's options.
 *
 * @remarks
 * Always through `ensure()`, never a bare `setQueryData()` on an unknown key:
 * Colada garbage-collects only entries that carry options (gcTime), and the
 * calendar seeds every week it shows -- without them the cache would only
 * grow (the in-house cache capped itself at 120 entries).
 */
function practiceEntry(queryCache: QueryCache, id: string) {
  return queryCache.ensure(practiceDetailQuery(id))
}

/** The practice was loaded within the last PRELOAD_HANDOFF_MS (and not invalidated since). */
function isJustLoaded(queryCache: QueryCache, id: string): boolean {
  const entry = queryCache.get(keys.practices.detail(id))
  return (
    !!entry &&
    entry.state.value.status === 'success' &&
    entry.when > 0 &&
    Date.now() - entry.when <= PRELOAD_HANDOFF_MS
  )
}

/** Single practice detail with stale-while-revalidate over the screen-data cache. */
export const usePracticesStore = defineStore('practices', () => {
  const queryCache = useQueryCache()
  // -- Single practice detail --
  const selected = ref<PracticeResponse | null>(null)
  const selectedLoading = ref(false)
  const selectedError = ref<string | null>(null)

  /**
   * Tracks the ID of the most recently requested practice.
   * F-01: prevents a slow response for practice A from overwriting
   * selected when the user has already navigated to practice B.
   */
  let _currentFetchId: string | null = null

  /**
   * Fetch a single practice by ID for the detail view.
   *
   * F-01: race condition guard -- if a newer fetchPractice() call was
   * made while this one was in-flight, the stale result is discarded.
   *
   * `seed`: the same practice as a list already holds it (same DTO), shown
   * until the response lands when the cache has nothing fresher.
   */
  async function fetchPractice(id: string, seed?: PracticeResponse): Promise<void> {
    _currentFetchId = id
    const key = keys.practices.detail(id)
    const known =
      queryCache.getQueryData<PracticeResponse>(key) ??
      (selected.value?.id === id ? selected.value : undefined) ??
      seed
    if (known) selected.value = known

    selectedLoading.value = !known
    selectedError.value = null
    try {
      const result = await getPractice(id)
      // The session ended meanwhile ($reset cleared the fetch id): the answer
      // belongs to the previous account and lands nowhere, cache included.
      if (_currentFetchId === null) return
      queryCache.setEntryState(practiceEntry(queryCache, id), {
        status: 'success',
        data: result,
        error: null,
      })
      // F-01: discard stale response if user navigated to another practice.
      if (_currentFetchId === id) {
        selected.value = result
      }
    } catch (e) {
      if (_currentFetchId === id && (!known || isGone(e))) {
        selectedError.value = extractApiError(e, t('storeErrors.practices.selected'))
        selected.value = null
      }
    } finally {
      if (_currentFetchId === id) {
        selectedLoading.value = false
      }
    }
  }

  /**
   * Open a practice screen. A response that landed moments ago (the route
   * preload below, racing the screen mount) is reused instead of refetched;
   * otherwise this is fetchPractice() -- cached or seeded data shows at once.
   */
  function openPractice(id: string): Promise<void> {
    const fresh = queryCache.getQueryData<PracticeResponse>(keys.practices.detail(id))
    if (fresh && isJustLoaded(queryCache, id)) {
      _currentFetchId = id
      selected.value = fresh
      selectedLoading.value = false
      selectedError.value = null
      return Promise.resolve()
    }
    return fetchPractice(id)
  }

  /** The practice no longer exists for this viewer -- never keep showing it. */
  function isGone(e: unknown): boolean {
    return e instanceof ApiResponseError && (e.status === 404 || e.status === 403)
  }

  function clearSelected(): void {
    selected.value = null
    selectedError.value = null
  }

  /** Back to the initial state at the account boundary (platform/session.ts).
   * Clearing the fetch id also drops any answer still in flight (F-01 guard). */
  function $reset(): void {
    _currentFetchId = null
    selected.value = null
    selectedLoading.value = false
    selectedError.value = null
  }

  return {
    selected,
    selectedLoading,
    selectedError,
    fetchPractice,
    openPractice,
    clearSelected,
    $reset,
  }
})
