// =============================================================================
// VELO Frontend -- delayed loading indicator (loading system, report §8.3.1)
// =============================================================================
//
// A loading indicator that shows for a fast response is worse than none: it
// flashes for one frame and reads as a glitch (NN/g: no animation for waits
// under ~1 s). The rule for the whole app:
//   - nothing is shown until the wait has lasted `delay` (300 ms) -- an answer
//     inside it never shows a placeholder at all (the block keeps its
//     reserved, empty height and the content just fades in, VLoadingSwap);
//   - once shown, it stays at least `minDuration` (450 ms), so it never
//     blinks off right after it blinked on.
// The flag is logic, not animation -- the fade itself stays in CSS.
//
// useLoadingHold() is what screens use: it keeps the placeholder mounted from
// the first moment (VSkeleton/VLoader stay CSS-invisible for
// --velo-skeleton-delay, the same 300 ms) and holds it for the minimum once it
// was actually seen. `reveal` says the content is arriving AFTER a visible
// placeholder, so it fades in (.velo-reveal); content that was ready before
// the delay appears as is, without any animation.
// =============================================================================

import {
  computed,
  onScopeDispose,
  readonly,
  ref,
  toValue,
  watch,
  type ComputedRef,
  type MaybeRefOrGetter,
  type Ref,
} from 'vue'

export interface DelayedFlagOptions {
  /** How long `source` must stay true before the flag turns on (ms). */
  delay?: number
  /** Once on, the flag stays on at least this long (ms). */
  minDuration?: number
}

export const LOADING_DELAY_MS = 300
export const LOADING_MIN_DURATION_MS = 450

export function useDelayedFlag(
  source: MaybeRefOrGetter<boolean>,
  { delay = LOADING_DELAY_MS, minDuration = LOADING_MIN_DURATION_MS }: DelayedFlagOptions = {},
): Readonly<Ref<boolean>> {
  const shown = ref(false)
  let showTimer: ReturnType<typeof setTimeout> | null = null
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  let shownAt = 0

  function clearShow(): void {
    if (showTimer !== null) clearTimeout(showTimer)
    showTimer = null
  }
  function clearHide(): void {
    if (hideTimer !== null) clearTimeout(hideTimer)
    hideTimer = null
  }

  watch(
    () => toValue(source),
    (on) => {
      if (on) {
        clearHide()
        if (shown.value || showTimer !== null) return
        showTimer = setTimeout(() => {
          showTimer = null
          shown.value = true
          shownAt = Date.now()
        }, delay)
        return
      }
      clearShow()
      if (!shown.value || hideTimer !== null) return
      const left = Math.max(0, minDuration - (Date.now() - shownAt))
      hideTimer = setTimeout(() => {
        hideTimer = null
        shown.value = false
      }, left)
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    clearShow()
    clearHide()
  })

  return readonly(shown)
}

export interface LoadingHold {
  /** Render the placeholder: while loading, and through the minimum display
   *  once it became visible. The content renders when this is false. */
  showSkeleton: ComputedRef<boolean>
  /** The placeholder was seen at least once -- content now fades in. */
  reveal: Readonly<Ref<boolean>>
  /** Resolves once the placeholder is gone and the content is mounted next
   *  (await it before measuring or scrolling the content). */
  settled: () => Promise<void>
}

export function useLoadingHold(
  pending: MaybeRefOrGetter<boolean>,
  options: DelayedFlagOptions = {},
): LoadingHold {
  const seen = useDelayedFlag(pending, options)
  const showSkeleton = computed(() => toValue(pending) || seen.value)
  const reveal = ref(false)
  watch(seen, (on) => {
    if (on) reveal.value = true
  })

  function settled(): Promise<void> {
    if (!showSkeleton.value) return Promise.resolve()
    return new Promise((resolve) => {
      const stop = watch(
        showSkeleton,
        (on) => {
          if (on) return
          stop()
          resolve()
        },
        { flush: 'post' },
      )
    })
  }

  return { showSkeleton, reveal: readonly(reveal), settled }
}
