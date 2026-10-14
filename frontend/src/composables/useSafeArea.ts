// =============================================================================
// VELO Frontend -- useSafeArea Composable (@tma.js/sdk-vue)
// =============================================================================
//
// Single source of truth for the top safe-area offset the app content must
// leave clear: in Telegram fullscreen, backed by the official SDK viewport
// signals; outside Telegram, the system inset (see below).
//
// FORMULA (device-tuned):
//   offset = safeAreaInset.top + contentSafeAreaInset.top - OVERLAP
//   where OVERLAP (20px) compensates for the fact that the system status-bar
//   area and Telegram's controls strip partially overlap; adding the two raw
//   insets (44 + 46 = 90) pushed the content a bit too low, leaving a gap
//   below the buttons. 90 - 20 = 70 sits the content just under the controls.
//
//   Guarded so the offset never goes negative: out of fullscreen (launched
//   from a chat) both insets are 0, the sum is 0, and we return 0 -- we do NOT
//   subtract OVERLAP there, otherwise the content would slide UP under
//   Telegram's own header. The subtraction only applies when there is a real
//   inset to trim (fullscreen).
//
//   Device-verified via the diagnostic panel:
//     fullscreen: safeAreaInset.top=44, contentSafeAreaInset.top=46 -> 70px
//     in-chat:    both 0 -> 0px
//
// WHY SIGNALS (not a CSS var): insets arrive asynchronously after first paint;
// the vendored SDK's raw setProperty did not trigger a style recompute in the
// Telegram iOS WebView, so a CSS var() stayed at 0. useSignal() turns each SDK
// signal into a Vue ref, so an inline style bound to the value re-renders when
// the inset arrives -- which is what moves the content.
//
// INSIDE TELEGRAM a viewport that never mounted (older client) gives 0, as it
// always did.
//
// OUTSIDE TELEGRAM (BE-149: browser, app installed on the home screen) the
// offset is the system's own inset, env(safe-area-inset-top): the installed
// iOS app draws under a translucent status bar (index.html,
// black-translucent), and platform/launch.ts sets viewport-fit=cover there so
// env() carries the real value. In a plain browser tab it is 0.
//
// The branch is chosen by PLATFORM, not by "viewport mounted": a Telegram
// client whose viewport never mounted must stay at 0, not pick up env() --
// the Telegram webview keeps its old viewport tag, so env() there is not the
// value this layout was tuned against.
//
// The value is therefore a CSS LENGTH STRING ('70px' or 'env(...)'), bound
// as-is into inline styles.
// =============================================================================

import { computed, type ComputedRef } from 'vue'
import { viewport, useSignal } from '@tma.js/sdk-vue'
import { platform } from '@/platform'

/** Top clearance outside Telegram: the system inset (0 where there is none). */
export const STANDALONE_SAFE_TOP = 'env(safe-area-inset-top, 0px)'

/** Overlap (px) between the status-bar area and Telegram's controls strip. */
const OVERLAP_PX = 20

function toNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Reactive top safe-area offset as a CSS length: in Telegram, the clearance
 * the content needs below Telegram's controls in fullscreen, with the overlap
 * trimmed ('70px', '0px'); outside Telegram, STANDALONE_SAFE_TOP.
 *
 * Bind to an inline style so the padding re-renders reactively:
 *   :style="{ paddingTop: contentSafeTopCss }"
 */
export function useSafeArea(): { contentSafeTopCss: ComputedRef<string> } {
  const isMounted = useSignal(viewport.isMounted)
  const safeTop = useSignal(viewport.safeAreaInsetTop)
  const contentTop = useSignal(viewport.contentSafeAreaInsetTop)

  const telegramSafeTop = computed<number>(() => {
    if (!isMounted.value) return 0
    const sum = toNum(safeTop.value) + toNum(contentTop.value)
    // Only trim the overlap when there's a real inset (fullscreen). Out of
    // fullscreen sum is 0 -> return 0, never negative.
    return sum > 0 ? Math.max(sum - OVERLAP_PX, 0) : 0
  })

  const contentSafeTopCss = computed<string>(() =>
    platform.name === 'telegram' ? `${telegramSafeTop.value}px` : STANDALONE_SAFE_TOP,
  )

  return { contentSafeTopCss }
}
