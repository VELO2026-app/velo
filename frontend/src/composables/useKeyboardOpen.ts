import { ref, onMounted, onBeforeUnmount } from 'vue'
import { KEYBOARD_VIEWPORT_THRESHOLD } from '@/utils/constants'
import { isKeyboardOpen, nativeKeyboardDelta } from '@/utils/keyboardDetection'

/**
 * Reactive "is the on-screen keyboard open" flag, derived from visualViewport
 * (or, when available, Telegram's own native viewport signal -- see below).
 *
 * When the soft keyboard opens, the visual viewport height shrinks well below
 * the layout viewport (window.innerHeight). We treat a shrink larger than
 * `threshold` px as "keyboard open".
 *
 * Used to hide the floating bottom tab bar while typing, so it does not ride up
 * and overlap a focused input (e.g. BookingConfirmedView's "запрос мастеру").
 *
 * PROMPT №651 (T24-1, second half): the browser-only delta above only
 * detects the keyboard under the "overlay resize" model -- on an Android
 * WebView that shrinks its own rendering surface instead (see
 * useBackgroundStabilizer.ts's header for the full mechanism), innerHeight
 * and visualViewport.height move together and the delta collapses toward 0,
 * so the tab bar never hid and sat where the keyboard now covers it ("no
 * buttons show below" the focused field, as reported). `update()` now goes
 * through the SAME `isKeyboardOpen`/`nativeKeyboardDelta` pair
 * useBackgroundStabilizer.ts uses -- ONE decision, not a second copy of it.
 *
 * No-ops gracefully where visualViewport is unavailable (flag stays false).
 */
export function useKeyboardOpen(threshold = KEYBOARD_VIEWPORT_THRESHOLD) {
  const keyboardOpen = ref(false)
  const vv = typeof window !== 'undefined' ? window.visualViewport : null

  function update(): void {
    if (!vv) return
    keyboardOpen.value = isKeyboardOpen(
      nativeKeyboardDelta(),
      window.innerHeight,
      vv.height,
      threshold,
    )
  }

  onMounted(() => {
    if (!vv) return
    vv.addEventListener('resize', update)
    update()
  })

  onBeforeUnmount(() => {
    vv?.removeEventListener('resize', update)
  })

  return { keyboardOpen }
}
