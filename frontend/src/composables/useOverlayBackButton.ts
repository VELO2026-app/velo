// =============================================================================
// VELO Frontend -- useOverlayBackButton (FE-233, the tail of package 2)
// =============================================================================
//
// While a modal, a bottom sheet, a confirm dialog or the diary search is open,
// the host's native Back button (Telegram's, top-left) is shown, and a tap on
// it closes the TOP overlay -- the same request an Escape press makes, through
// the kit's layer stack. A guarded form answers it with "Discard changes?"
// instead of dropping its edits (`dismissAttempt`).
//
// Back reaches the overlay before anything else: the app has no other use of
// the native button (every screen draws its own VBackButton), and when it gets
// one, its handler must be registered only while no layer is open.
//
// Outside Telegram `platform.showBackButton` is a no-op: the browser has its
// own Back, and the standalone app is unchanged.
//
// Mounted once, in App.vue.
// =============================================================================

import { onUnmounted, watch } from 'vue'
import { platform } from '@/platform'
import { dismissTopLayer, hasOpenLayer } from '@/components/ui'

/**
 * Show the native Back button while an overlay is open; a tap closes the top
 * overlay. Call once in the app root's setup.
 */
export function useOverlayBackButton(): void {
  let shown = false

  function show(): void {
    shown = true
    platform.showBackButton(() => {
      dismissTopLayer()
    })
  }

  // Only what this composable showed is its to hide: the watch below also runs
  // once at setup with no overlay open, and the root unmounting must not hide a
  // button it never showed.
  function hide(): void {
    if (!shown) return
    shown = false
    platform.hideBackButton()
  }

  watch(hasOpenLayer, (open) => (open ? show() : hide()), { immediate: true })

  // The root going away (a test, hot reload) must not leave the button up.
  onUnmounted(hide)
}
