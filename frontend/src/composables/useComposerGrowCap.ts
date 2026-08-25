import { computed, type ComputedRef, type Ref } from 'vue'
import { visibleHeight } from './useViewportGeometry'

/**
 * VELO Frontend -- composer autogrow cap (PROMPT №741, track 3).
 *
 * Restores the viewport-aware growth the pre-extraction DiaryComposer had
 * (PROMPT №630) and wires it as the shared Composer's `growCap` prop, so B40
 * is not just structural (bounded + internal scroll, track 2) but actually
 * bounded by what the SCREEN leaves available, for both consumers.
 *
 * Formula [FE-9 rework, 2026-08-25]: the composing cap is ONE THIRD of the
 * LIVE visible height, clamped to [FLOOR 80, CEILING 240] -- the owner's own
 * "~1/3 of the screen" figure (PROMPT №630) applied to the keyboard-shrunk
 * viewport instead of the full screen. The old flat 300px target ate ~3/4 of
 * the 412px visible area while typing (the "textarea swallows the screen,
 * context disappears" bug). At the device-measured 412px this yields 137px
 * (~5-6 lines, Telegram's own ballpark); without the keyboard (768) it
 * reaches the 240px ceiling. FLOOR 80 stays: a very short viewport must not
 * collapse the field to one line.
 *   - not composing: unchanged fixed 120px -- this was never viewport-driven
 *     (the keyboard is closed, there is no shortage of room); it is a
 *     compactness choice for the idle field, so it is NOT recomputed live.
 */
export const COMPOSING_HEIGHT_CEILING = 240
export const COMPOSING_HEIGHT_FLOOR = 80
export const COLLAPSED_HEIGHT_CAP = 120

/** Pure function, exported for unit tests -- the whole point of extracting
 *  this out of a component is that the formula itself is checkable without a
 *  browser. */
export function composerGrowCap(composing: boolean, viewportHeight: number): number {
  if (!composing) return COLLAPSED_HEIGHT_CAP
  return Math.max(
    COMPOSING_HEIGHT_FLOOR,
    Math.min(COMPOSING_HEIGHT_CEILING, Math.round(viewportHeight / 3)),
  )
}

/** Reactive wrapper: reads the shared live-viewport signal
 *  (useViewportGeometry.ts) so the cap recomputes as the keyboard opens/
 *  closes, exactly as the pre-extraction DiaryComposer's own
 *  `watch(visibleHeight, ...)` did. */
export function useComposerGrowCap(composing: Ref<boolean>): ComputedRef<number> {
  return computed(() => {
    const vh = visibleHeight.value || window.innerHeight
    return composerGrowCap(composing.value, vh)
  })
}
