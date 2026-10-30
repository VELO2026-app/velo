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
// the screen-data cache (composables/useQuery). Opening a practice that is
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
import { queryCache } from '@/composables/useQuery'
import { queryKeys } from '@/composables/queryKeys'
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
export function prefetchPractice(id: string): Promise<void> {
  return queryCache.prefetch(queryKeys.practice(id), () => getPractice(id), PRELOAD_HANDOFF_MS)
}

/** Lists holding full practices (same DTO as the detail) prime the cache so
 * the detail screen opens with content instead of a skeleton. */
export function seedPractices(list: readonly PracticeResponse[]): void {
  for (const practice of list) queryCache.seed(queryKeys.practice(practice.id), practice)
}

export const usePracticesStore = defineStore('practices', () => {
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
    const key = queryKeys.practice(id)
    const known =
      queryCache.get<PracticeResponse>(key) ??
      (selected.value?.id === id ? selected.value : undefined) ??
      seed
    if (known) selected.value = known

    selectedLoading.value = !known
    selectedError.value = null
    try {
      const result = await getPractice(id)
      queryCache.setData<PracticeResponse>(key, () => result)
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
    const key = queryKeys.practice(id)
    const fresh = queryCache.get<PracticeResponse>(key)
    if (fresh && queryCache.isFresh(key, PRELOAD_HANDOFF_MS)) {
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

  return {
    selected,
    selectedLoading,
    selectedError,
    fetchPractice,
    openPractice,
    clearSelected,
  }
})
