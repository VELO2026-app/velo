import { onMounted, onBeforeUnmount } from 'vue'
import router from '@/router'
import { KEYBOARD_VIEWPORT_THRESHOLD } from '@/utils/constants'
import { resetKeyboardViewportState } from '@/utils/keyboardViewportState'

/**
 * App-root keyboard-viewport publisher. Mounted ONCE from App.vue (the
 * always-mounted root); the single visualViewport listener for CSS state.
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
 * any platform, by construction (see the composable's own guardrail below:
 * this function is wired ONLY to mount + orientationchange, NEVER to a
 * visualViewport resize/scroll handler -- doing so would defeat the whole
 * point, since that IS the keyboard signal).
 *
 * The "dancing background" is fixed STRUCTURALLY now (batch K): #app::before is an
 * absolute child of #app's stable box (global.css), so it no longer tracks
 * the visual viewport and there is nothing to counter-shift per frame. This
 * composable therefore no longer writes `--velo-bg-shift` or freezes any transform.
 *
 * Its other remaining job: keyboard-aware LAYOUT. It publishes the visual-viewport
 * HEIGHT as `--velo-vvh` and toggles `is-keyboard-open`, BOTH on :root
 * (documentElement) so teleported modals (under <body>, outside #app) inherit them.
 * The gated rules in global.css cap the scroll container / modal to `--velo-vvh`
 * ONLY while that class is present. At rest the class is absent → the rules are
 * inert → layout is byte-identical. Threshold is shared with useKeyboardOpen
 * (KEYBOARD_VIEWPORT_THRESHOLD) so the two never drift. `--velo-vvh` is a
 * SEPARATE signal from `--velo-frozen-vh` above -- it stays exactly as it was,
 * live, keyboard-reactive, and is what the `.velo-kbd-scroll` scroll-cap
 * mechanism reads; it does not drive #app's height and never has.
 *
 * Writes are rAF-throttled (one style write per frame). No-ops where
 * visualViewport is absent (SSR / desktop → class never added).
 *
 * K3f — on every route change it (1) blurs the active element so a focused field
 * releases and the keyboard dismisses on navigation, (2) resets the state, and
 * (3) opens a short SUPPRESSION window during which it will NOT re-assert
 * `is-keyboard-open` / `--velo-vvh`. Without it, a still-closing keyboard fires
 * more visualViewport resizes right after the reset and repaints keyboard-open
 * geometry (the max-height cap → a fog "line" band + reflow lag) onto the freshly
 * navigated screen.
 */
// K3f suppression window (ms): a soft keyboard animates shut over ~250ms; hold
// at-rest geometry a touch longer so no closing-keyboard frame re-caps the new screen.
const NAV_SUPPRESS_MS = 350

// Orientation settle window (ms): rotation dimensions aren't always final the
// instant `orientationchange` fires; a short delay avoids capturing mid-rotation.
const ORIENTATION_SETTLE_MS = 300

/**
 * Capture the current viewport height ONCE as a literal px value into
 * `--velo-frozen-vh`. Read (visualViewport?.height ?? innerHeight) -- the
 * same fallback pair the rest of the keyboard machinery uses -- but written
 * to a var that NOTHING else ever touches live. Call sites: mount (before any
 * keyboard can be open) and orientationchange (a genuine size change) ONLY.
 */
function freezeAppHeight(): void {
  if (typeof window === 'undefined') return
  const h = window.visualViewport?.height ?? window.innerHeight
  document.documentElement.style.setProperty('--velo-frozen-vh', `${h}px`)
}

export function useBackgroundStabilizer(): void {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null
  let rafId = 0
  let stopAfterEach: (() => void) | null = null
  let orientationSettleId = 0
  // Timestamp (ms, epoch) until which keyboard-open geometry is suppressed after a
  // navigation. 0 = not suppressing.
  let suppressUntil = 0

  function onOrientationChange(): void {
    window.clearTimeout(orientationSettleId)
    orientationSettleId = window.setTimeout(freezeAppHeight, ORIENTATION_SETTLE_MS)
  }

  function setShift(): void {
    rafId = 0
    if (!vv) return
    const root = document.documentElement
    // K3f: while the post-navigation window is open, hold at-rest geometry so a
    // closing keyboard can't paint the cap onto the screen the user just opened.
    if (Date.now() < suppressUntil) {
      root.classList.remove('is-keyboard-open')
      root.style.setProperty('--velo-vvh', '')
      return
    }
    // Keyboard-aware layout state, published on :root so teleported modals inherit
    // it. See global.css `html.is-keyboard-open`.
    root.style.setProperty('--velo-vvh', `${vv.height}px`)
    root.classList.toggle(
      'is-keyboard-open',
      window.innerHeight - vv.height > KEYBOARD_VIEWPORT_THRESHOLD,
    )
  }

  function schedule(): void {
    if (rafId) return
    rafId = window.requestAnimationFrame(setShift)
  }

  onMounted(() => {
    // Capture the frozen anchor height FIRST, before any keyboard listener is
    // wired -- guarantees this read happens at the pristine, keyboard-closed
    // moment. Unconditional (not gated on `vv`): freezeAppHeight has its own
    // window/visualViewport fallback and must run even where visualViewport
    // is unsupported (desktop/older engines).
    freezeAppHeight()
    window.addEventListener('orientationchange', onOrientationChange)

    if (!vv) return
    vv.addEventListener('resize', schedule)
    vv.addEventListener('scroll', schedule)
    setShift()
    // K3f + the between-screens "fog lag": clear stale keyboard state the instant
    // the route changes, dismiss the keyboard, then suppress re-assertion while it
    // animates shut so the next screen never inherits keyboard-open geometry.
    stopAfterEach = router.afterEach(() => {
      ;(document.activeElement as HTMLElement | null)?.blur?.()
      resetKeyboardViewportState()
      suppressUntil = Date.now() + NAV_SUPPRESS_MS
      // Re-sync truth once the window closes (the keyboard may legitimately still
      // be open on the new screen — rare, but then this restores the cap).
      window.setTimeout(schedule, NAV_SUPPRESS_MS)
    })
  })

  onBeforeUnmount(() => {
    window.clearTimeout(orientationSettleId)
    window.removeEventListener('orientationchange', onOrientationChange)
    if (rafId) {
      window.cancelAnimationFrame(rafId)
      rafId = 0
    }
    vv?.removeEventListener('resize', schedule)
    vv?.removeEventListener('scroll', schedule)
    stopAfterEach?.()
    stopAfterEach = null
    resetKeyboardViewportState()
  })
}
