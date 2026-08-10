// =============================================================================
// VELO Frontend -- useKeyboardFieldScroll (M5/M6, PROMPT №273)
// =============================================================================
//
// A @focus handler that scrolls a text field into view AFTER the soft keyboard
// finishes animating in.
//
// The previous per-view handlers (MasterSupportView SP-1, EditProfileView PE-2c)
// scrolled on focus AND on EVERY visualViewport `resize` frame — but the keyboard
// animates over several frames, so scrolling mid-animation raced the keyboard and
// the field could still settle under it. This DEBOUNCES on the resize frames:
// each resize resets a short timer, and the scroll fires once the frames stop
// (~the viewport settled), so it lands after the keyboard, not during it.
//
// Reads the existing window.visualViewport signal only. It writes none of the
// shared keyboard state (--velo-vvh / is-keyboard-open stay owned by
// useBackgroundStabilizer / keyboardViewportState) — no new global machinery.
// Desktop / no visualViewport → a single deferred scroll (unchanged fallback).
// =============================================================================

import { onUnmounted } from 'vue'

/** Time (ms) with no visualViewport resize before we treat the keyboard as
 *  settled and scroll the field into view. */
const SETTLE_MS = 120

export function useKeyboardFieldScroll() {
  // The listener this composable currently has attached to the (long-lived,
  // global) window.visualViewport, if any. Normally removed on the field's
  // own `blur` -- but if the component unmounts first (nav away with the
  // keyboard still open, the exact case this file exists for), `blur` never
  // fires and the listener -- plus everything its closure keeps alive --
  // stays attached to `visualViewport` forever. Reaped here instead.
  let activeCleanup: (() => void) | null = null

  onUnmounted(() => {
    activeCleanup?.()
    activeCleanup = null
  })

  /** Bind as `@focus` on the field (input / textarea). Listeners self-remove on
   *  the field's own `blur`, or on the owning component's unmount. */
  function onFieldFocus(e: FocusEvent): void {
    const el = e.target as HTMLElement | null
    if (!el) return

    const bring = (): void => el.scrollIntoView({ block: 'center' })

    const vv = window.visualViewport
    if (!vv) {
      // No visualViewport (older webview): settle after a fixed keyboard delay.
      window.setTimeout(bring, 300)
      return
    }

    // Debounce on the keyboard's own resize frames: reset the timer on each
    // resize, fire once when they stop (keyboard finished) so the scroll lands
    // after the animation instead of racing it.
    let settle = 0
    const onResize = (): void => {
      window.clearTimeout(settle)
      settle = window.setTimeout(bring, SETTLE_MS)
    }
    vv.addEventListener('resize', onResize)

    const cleanup = (): void => {
      vv.removeEventListener('resize', onResize)
      window.clearTimeout(settle)
      activeCleanup = null
    }
    activeCleanup = cleanup
    el.addEventListener('blur', cleanup, { once: true })

    // Kick once: if the keyboard is already open (focus without a resize), the
    // debounce still fires a single settle scroll.
    onResize()
  }

  return { onFieldFocus }
}
