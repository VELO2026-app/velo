// =============================================================================
// VELO Frontend -- Telegram SDK bootstrap (@tma.js/sdk) -- safe-area
// =============================================================================
//
// Initializes @tma.js/sdk and mounts the viewport so the app can read a
// reliable, reactive content safe-area inset (via useSafeArea()).
//
// IMPORTANT (safe-area): we do NOT call requestFullscreen() here. Forcing
// programmatic fullscreen made Telegram report contentSafeAreaInsetTop = 0,
// which broke the padding (it had nothing to apply). Letting Telegram decide
// the mode natively (e.g. fullscreen when launched from the chat list) keeps
// the content safe-area inset populated (device-verified ~46px), which is what
// the layout padding consumes. Fullscreen handling can be revisited separately
// once the inset is confirmed working.
//
// Runs in parallel with the existing window.Telegram.WebApp platform layer
// during the migration. GUARDED: the SDK throws when not launched from
// Telegram (standalone browser, unit tests), so we detect the environment and
// swallow errors to keep the standalone build and the test gate green.
// =============================================================================

import { init, viewport } from '@tma.js/sdk-vue'

/** True when running inside a real Telegram client (launch params present). */
function isTelegramEnv(): boolean {
  const wa = (window as unknown as { Telegram?: { WebApp?: { initData?: string } } }).Telegram
    ?.WebApp
  return !!wa?.initData
}

let _initialized = false
/** Settles once the viewport (safe-area insets, heights) is mounted -- or at
 * once outside Telegram / when the SDK is unavailable. */
let _viewportSettled: Promise<void> = Promise.resolve()

export function initTelegramSdk(): void {
  if (_initialized) return
  if (!isTelegramEnv()) return

  try {
    init()
    _viewportSettled = mountViewport()
    _initialized = true
  } catch {
    // Outside Telegram or unsupported client -- standalone/tests fall through.
  }
}

/** Mount viewport and bind its CSS vars (best-effort). No fullscreen request. */
async function mountViewport(): Promise<void> {
  try {
    if (viewport.mount.isAvailable()) {
      await viewport.mount()
    }
    if (viewport.bindCssVars.isAvailable()) {
      viewport.bindCssVars()
    }
  } catch {
    // Viewport not supported on this client/version -- safe-area falls back to 0.
  }
}

/** The first-screen gate waits for this (capped) so the insets are final
 * before the first screen paints -- no safe-area jump right after start. */
export function viewportSettled(): Promise<void> {
  return _viewportSettled
}

export function isTelegramSdkReady(): boolean {
  return _initialized
}
