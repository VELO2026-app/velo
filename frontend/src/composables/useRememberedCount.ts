// =============================================================================
// VELO Frontend -- skeleton sized like the last answer (loading system)
// =============================================================================
//
// A skeleton of three cards that resolves into an empty state is the biggest
// jump a loading block can make. This remembers how many items a block had
// the last time it settled (per tab, platform/session-memo) and returns the
// number of placeholders to draw now: the last count, clamped to
// [min, max]; `fallback` before anything is known. An empty block is drawn
// with `min` (1) placeholder -- the height animation (VLoadingSwap) covers the
// rest.
// =============================================================================

import { computed, ref, toValue, watch, type ComputedRef, type MaybeRefOrGetter } from 'vue'
import { readSessionNumber, writeSessionNumber } from '@/platform/session-memo'

export interface RememberedCountOptions {
  /** Placeholders before anything is known. */
  fallback: number
  /** Never draw more than this (the block's own display cap). */
  max: number
  /** Never draw fewer than this (default 1). */
  min?: number
}

const PREFIX = 'velo:skeleton-count:'

export function useRememberedCount(
  key: string,
  count: MaybeRefOrGetter<number>,
  ready: MaybeRefOrGetter<boolean>,
  { fallback, max, min = 1 }: RememberedCountOptions,
): ComputedRef<number> {
  const storageKey = PREFIX + key
  const last = ref<number | null>(readSessionNumber(storageKey))

  // Only an answer counts: a block that starts "ready" with nothing in it
  // has simply not asked yet, and must not teach the next skeleton "0".
  let loaded = false
  watch(
    () => (toValue(ready) ? toValue(count) : null),
    (value) => {
      if (value === null) {
        loaded = true
        return
      }
      if (!loaded) return
      last.value = value
      writeSessionNumber(storageKey, value)
    },
    { immediate: true },
  )

  return computed(() => Math.min(max, Math.max(min, last.value ?? fallback)))
}
