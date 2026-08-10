import { onMounted, onBeforeUnmount } from 'vue'
import { viewport } from '@tma.js/sdk-vue'
import { platform } from '@/platform'

/**
 * App-root FROZEN-HEIGHT publisher. Mounted ONCE from App.vue (the
 * always-mounted root).
 *
 * PROMPT №657 (rebuild): this file used to ALSO own the ongoing
 * visualViewport listener (--velo-vvh / is-keyboard-open publishing, the K3f
 * route-suppression window). That half moved to useViewportGeometry.ts,
 * which is the one place that now reads live viewport signals for keyboard
 * state -- see that file's header for the full reasoning. What stays here,
 * UNCHANGED, is the one-shot frozen-height capture: per the standing
 * guardrail, freezeAppHeight() is wired ONLY to mount + orientationchange,
 * NEVER to a visualViewport resize/scroll handler -- wiring it to the
 * keyboard signal would defeat the whole point (see the function's own
 * docstring below). This file's job, singular, is that capture.
 *
 * ANDROID FIX (batch bg-freeze, 2026-07-13 — audit PROMPT №378): `#app`'s
 * `100lvh` was assumed stable across the keyboard (batch K/N/root-lock), but
 * `lvh`'s keyboard-immunity depends entirely on the platform respecting
 * index.html's `interactive-widget=resizes-visual` -- a Chromium-only hint.
 * On Android WebViews that don't honour it (older "Android System WebView"
 * builds, or a host Activity using `adjustResize`), the keyboard resizes the
 * WebView's own rendering surface BEFORE the CSS engine ever sees it, so
 * `100lvh` silently degrades to tracking the shrunk surface -- #app's box (and
 * #app::before's bg, `inset:0` against it) rescales. `freezeAppHeight()`
 * below breaks that dependency entirely: it captures the viewport height ONCE
 * (before any keyboard can possibly be open) into `--velo-frozen-vh`, a plain
 * px custom property that NOTHING but this function's own writes can ever
 * change. global.css re-anchors html/body/#app/.app-frame to that var instead
 * of `100lvh` -- their height becomes immune to ANY live viewport signal, on
 * any platform, by construction (see the guardrail below: this function is
 * wired ONLY to mount + orientationchange, NEVER to a visualViewport
 * resize/scroll handler -- doing so would defeat the whole point, since that
 * IS the keyboard signal).
 *
 * T24-4 (mount-time race, white rounded-corner slivers) -- PROMPT №650: a
 * `queueMicrotask` defer alone only proves `webApp.expand()` was CALLED
 * before the freeze, not that the native resize it triggers has FINISHED --
 * a microtask elapses before the next paint, not before a native-host
 * round-trip. `scheduleInitialFreeze()` below now waits for Telegram's own
 * `viewport.isStable` signal (via `@tma.js/sdk-vue`, already integrated
 * elsewhere in this app for safe-area -- see platform/telegram-sdk.ts) to
 * confirm the expansion has genuinely settled, with a bounded timeout
 * fallback so the freeze is never left unset. See that function's own
 * docstring for the full reasoning and why this does NOT violate the
 * guardrail above (still exactly ONE freeze per mount, never wired to an
 * ongoing keyboard signal).
 *
 * The "dancing background" is fixed STRUCTURALLY now (batch K): #app::before is an
 * absolute child of #app's stable box (global.css), so it no longer tracks
 * the visual viewport and there is nothing to counter-shift per frame. This
 * composable therefore no longer writes `--velo-bg-shift` or freezes any transform.
 */

// Orientation settle window (ms): rotation dimensions aren't always final the
// instant `orientationchange` fires; a short delay avoids capturing mid-rotation.
const ORIENTATION_SETTLE_MS = 300

// PROMPT №650: bounded wait for viewport.isStable after mount, polled rather
// than event-subscribed (simpler to reason about correctly than nested
// signal listeners for a one-shot, non-hot-path wait). Generous margin over
// a typical native expand animation (well under 500ms) -- this is a safety
// ceiling, not the expected wait; on a client that never reports isStable at
// all it is what stands between "stuck forever unset" and "eventually
// freezes something reasonable".
const EXPAND_SETTLE_TIMEOUT_MS = 1200
const EXPAND_SETTLE_POLL_MS = 50

/**
 * Capture the current viewport height ONCE as a literal px value into
 * `--velo-frozen-vh`. Read (visualViewport?.height ?? innerHeight) -- the
 * same fallback pair the rest of the keyboard machinery uses -- but written
 * to a var that NOTHING else ever touches live. Call sites: mount (deferred,
 * see below) and orientationchange (a genuine size change) ONLY.
 */
function freezeAppHeight(): void {
  if (typeof window === 'undefined') return
  const h = window.visualViewport?.height ?? window.innerHeight
  document.documentElement.style.setProperty('--velo-frozen-vh', `${h}px`)
}

/**
 * PROMPT №650 (T24-4): call `freezeAppHeight()` exactly ONCE, but only after
 * the initial viewport expansion has genuinely settled -- not merely been
 * requested. Outside Telegram (or before the SDK viewport has mounted at
 * all) there is no native "expand finished" signal to wait for, so this
 * falls back to the pre-existing microtask-defer behaviour, unchanged.
 *
 * NOT a violation of the guardrail above: this still fires exactly once per
 * mount. It is not subscribed to `viewport.isStable` at all -- it POLLS a
 * bounded number of times, stops the instant the viewport reports settled,
 * and never runs again after that.
 */
function scheduleInitialFreeze(): void {
  if (platform.name !== 'telegram') {
    // No native expand animation to wait for -- unchanged from before
    // PROMPT №650.
    queueMicrotask(freezeAppHeight)
    return
  }
  const deadline = Date.now() + EXPAND_SETTLE_TIMEOUT_MS
  const tick = (): void => {
    if (viewport.isMounted() && viewport.isStable()) {
      freezeAppHeight()
      return
    }
    if (Date.now() >= deadline) {
      // Safety net -- see the constant's own comment above.
      freezeAppHeight()
      return
    }
    window.setTimeout(tick, EXPAND_SETTLE_POLL_MS)
  }
  tick()
}

export function useBackgroundStabilizer(): void {
  let orientationSettleId = 0

  function onOrientationChange(): void {
    window.clearTimeout(orientationSettleId)
    orientationSettleId = window.setTimeout(freezeAppHeight, ORIENTATION_SETTLE_MS)
  }

  onMounted(() => {
    // T24-4/PROMPT №650: NOT called synchronously here -- see
    // scheduleInitialFreeze's own docstring for why (waits for the
    // viewport to genuinely settle, not just for expand() to be called).
    scheduleInitialFreeze()
    window.addEventListener('orientationchange', onOrientationChange)
  })

  onBeforeUnmount(() => {
    window.clearTimeout(orientationSettleId)
    window.removeEventListener('orientationchange', onOrientationChange)
  })
}
