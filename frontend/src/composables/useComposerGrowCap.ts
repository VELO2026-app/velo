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
 * Formula, constants and reasoning are UNCHANGED from the pre-extraction
 * DiaryComposer.vue -- moved here verbatim, not re-derived, so the numbers
 * below match what shipped and was tested before track 2 flattened them to
 * the static 240px token:
 *   - composing: the owner's own figure (PROMPT №630), ~1/3 of the SCREEN --
 *     a fixed 300px TARGET, bounded by what the visual viewport actually
 *     leaves above the composer chrome (a physical limit, not a second guess
 *     at his number), floored at 80px so a very short viewport cannot
 *     collapse the field to one line.
 *   - not composing: unchanged fixed 120px -- this was never viewport-driven
 *     (the keyboard is closed, there is no shortage of room); it is a
 *     compactness choice for the idle field, so it is NOT recomputed live.
 */
export const COMPOSING_HEIGHT_TARGET = 300
export const COMPOSING_HEIGHT_FLOOR = 80
export const COLLAPSED_HEIGHT_CAP = 120

/**
 * CHROME_OFFSET is a DEVICE-MEASURED constant from the diary screen's own
 * chrome (96px composer chrome + 80px top gap, PROMPT №630/№657) -- reused
 * here for BOTH consumers rather than re-measured per screen. Diary's chrome
 * and the chat thread's chrome (`.chat-thread__composer` padding,
 * `.chat-thread__feed`'s 88px header clearance) are not identical, so this
 * is an APPROXIMATION for chat, not a second measurement -- flagged in the
 * DONE report, not silently assumed. Re-tune on-device if chat's cap reads
 * visibly wrong.
 */
export const COMPOSING_CHROME_OFFSET = 176

/** Pure function, exported for unit tests -- the whole point of extracting
 *  this out of a component is that the formula itself is checkable without a
 *  browser. */
export function composerGrowCap(composing: boolean, viewportHeight: number): number {
  if (!composing) return COLLAPSED_HEIGHT_CAP
  return Math.max(
    COMPOSING_HEIGHT_FLOOR,
    Math.min(COMPOSING_HEIGHT_TARGET, viewportHeight - COMPOSING_CHROME_OFFSET),
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
