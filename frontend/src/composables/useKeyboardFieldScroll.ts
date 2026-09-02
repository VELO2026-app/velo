// =============================================================================
// VELO Frontend -- useKeyboardFieldScroll (M5/M6, PROMPT №273)
// =============================================================================
//
// A @focus handler that scrolls a text field into view AFTER the soft keyboard
// finishes animating in.
//
// [FE-45 follow-up] MINIMAL-SCROLL semantics: the scroll fires ONLY when the
// field is not already fully visible, and then just enough to reveal it.
// The old unconditional scrollIntoView({block:'center'}) re-centered the field
// in the scrollport EVEN WHEN IT ALREADY FIT -- on the group-create form
// (whose column keeps its at-rest height while typing, see that SFC) focusing
// «Описание» used to sweep the legend/title/name field up out of view
// («улетает наверх, хотя место есть»). scrollIntoViewIfNeeded(false) is the
// exact "only if needed, nearest edge" primitive, present in every WebKit and
// Chromium this app runs in (Safari 4+); scrollIntoView({block:'nearest'}) is
// the standard-spelled fallback for anything else. A field genuinely under
// the keyboard still gets scrolled clear -- that is this composable's whole
// job and is unchanged.
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

    // [FE-45 follow-up] See the banner: only-if-needed, minimal scroll. The
    // old block:'center' re-centered regardless of visibility.
    // scrollIntoViewIfNeeded is a WebKit/Chromium non-standard (absent from
    // TS DOM lib) -- typed locally, feature-detected at runtime.
    const bring = (): void => {
      const needs = el as HTMLElement & {
        scrollIntoViewIfNeeded?: (centerIfNeeded?: boolean) => void
      }
      if (typeof needs.scrollIntoViewIfNeeded === 'function') {
        needs.scrollIntoViewIfNeeded(false)
        return
      }
      el.scrollIntoView({ block: 'nearest' })
    }

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
