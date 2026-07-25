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
// =============================================================================

import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getPractice } from '@/api/practices'
import { extractApiError } from '@/composables/useApiError'
import type { PracticeResponse } from '@/api/types'

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
   */
  async function fetchPractice(id: string): Promise<void> {
    _currentFetchId = id

    selectedLoading.value = true
    selectedError.value = null
    try {
      const result = await getPractice(id)
      // F-01: discard stale response if user navigated to another practice.
      if (_currentFetchId === id) {
        selected.value = result
      }
    } catch (e) {
      if (_currentFetchId === id) {
        selectedError.value = extractApiError(e, 'Не удалось загрузить практику')
        selected.value = null
      }
    } finally {
      if (_currentFetchId === id) {
        selectedLoading.value = false
      }
    }
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
    clearSelected,
  }
})
