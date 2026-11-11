// =============================================================================
// VELO Frontend -- a screen's loading / error state over a Colada query (FE-166)
// =============================================================================
//
// Colada's `isPending` is `status === 'pending'`: no data has EVER landed. A
// retry after a failed first load stays `status === 'error'` while it runs,
// so a screen that showed `isPending` would keep its error state up, with no
// feedback, until the retry answers. The screens want the rule the in-house
// cache had: the skeleton whenever there is nothing to show and a request is
// in flight; the error only when there is nothing to show and nothing is
// being tried.
// =============================================================================

import { computed, type ComputedRef } from 'vue'
import type { UseQueryReturn } from '@pinia/colada'

/** Loading and error flags of a screen that renders one query's data. */
export interface ScreenQueryState {
  /** Nothing to show and a request is in flight -- the skeleton / loader. */
  loading: ComputedRef<boolean>
  /** Nothing to show, the last request failed and none is running -- the error state. */
  failed: ComputedRef<boolean>
}

/** Derive a screen's loading and error flags from a Colada query (see the header). */
export function screenQueryState(
  query: Pick<UseQueryReturn<unknown, unknown, unknown>, 'data' | 'error' | 'asyncStatus'>,
): ScreenQueryState {
  const empty = computed(() => query.data.value === undefined)
  const running = computed(() => query.asyncStatus.value === 'loading')
  return {
    loading: computed(() => empty.value && running.value),
    failed: computed(() => empty.value && !running.value && query.error.value != null),
  }
}
