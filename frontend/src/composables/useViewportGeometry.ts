import { onMounted, onBeforeUnmount, ref, readonly } from 'vue'
import { viewport } from '@tma.js/sdk-vue'
import router from '@/router'
import { KEYBOARD_VIEWPORT_THRESHOLD } from '@/utils/constants'
import { resetKeyboardViewportState } from '@/utils/keyboardViewportState'

/**
 * VELO Frontend -- the ONE canonical live-viewport/keyboard reader (PROMPT
 * №657, rebuild).
 *
 * BEFORE this file, four independent places each read the viewport on their
 * own: useBackgroundStabilizer's setShift() (--velo-vvh / is-keyboard-open),
 * utils/keyboardDetection.ts (the native/browser delta pair), useKeyboardOpen
 * (the tab bar, its own visualViewport listener), and DiaryComposer's own
 * autogrow() (a bare `window.visualViewport?.height` read for its grow cap).
 * NONE of the four ever read `visualViewport.offsetTop` -- confirmed by a
 * repo-wide grep before this file existed, zero hits outside the debug
 * panel's own (read-only) display. Chromium's own visual-viewport explainer
 * says positioning an element relative to the keyboard "should be translated
 * into visual-viewport space... by subtracting visualViewport.offsetTop" --
 * this file is the one place that now does that, and the one place every
 * consumer reads from instead of touching window.visualViewport / the tma.js
 * viewport SDK itself.
 *
 * Does NOT touch freezeAppHeight() / scheduleInitialFreeze() -- that one-shot
 * mount+orientationchange capture stays in useBackgroundStabilizer.ts,
 * untouched, per the standing guardrail (wiring it to a live viewport signal
 * defeats the whole point of freezing). This file owns everything ELSE that
 * useBackgroundStabilizer used to also do: the ongoing visualViewport
 * listener, is-keyboard-open / --velo-vvh publishing, and the K3f
 * route-change suppression window -- all moved here verbatim, not
 * reinvented.
 *
 * CSS contract kept IDENTICAL to before (`--velo-vvh`, `html.is-keyboard-open`)
 * so every existing consumer outside the diary (`.velo-kbd-scroll`, modal
 * sheets) needs zero changes. One CSS var is NEW: `--velo-vv-offset` (px,
 * visualViewport.offsetTop) -- the diary composer/header are the only current
 * consumers of it (DiaryFeedView.vue).
 */

// K3f suppression window (ms): a soft keyboard animates shut over ~250ms; hold
// at-rest geometry a touch longer so no closing-keyboard frame re-caps the
// freshly navigated screen. Unchanged value, moved verbatim from
// useBackgroundStabilizer.ts.
const NAV_SUPPRESS_MS = 350

/**
 * Telegram's own (stableHeight - height), or null when there's no native
 * signal to use (standalone/browser, or the @tma.js/sdk-vue viewport never
 * mounted). Pure, exported for unit tests -- unchanged from the retired
 * utils/keyboardDetection.ts.
 */
export function nativeKeyboardDelta(): number | null {
  if (!viewport.isMounted()) return null
  return viewport.stableHeight() - viewport.height()
}

/**
 * True if the on-screen keyboard should be treated as open. Pure, exported
 * for unit tests -- unchanged logic from the retired utils/keyboardDetection.ts.
 */
export function isKeyboardOpenFrom(
  nativeDelta: number | null,
  layoutHeight: number,
  visualHeight: number,
  threshold: number,
): boolean {
  const delta = nativeDelta ?? layoutHeight - visualHeight
  return delta > threshold
}

/**
 * The composer/header positioning formula (PROMPT №657, the documented gap):
 * an element pinned to the live visible area's bottom edge, inside a box
 * whose own height is the FROZEN (pre-keyboard) height, needs its `bottom`
 * offset shifted by (frozenVh - visibleBottom), where visibleBottom is the
 * true bottom of what's actually on screen -- offsetTop + visibleHeight, NOT
 * visibleHeight alone. Pure, exported for unit tests; mirrored 1:1 by the CSS
 * calc() in DiaryFeedView.vue (calc(frozen - vvh - offset) is algebraically
 * `frozenVh - (offsetTop + vvh)`, the same expression re-associated).
 */
export function computeKeyboardBottomOffset(
  frozenVh: number,
  visibleHeight: number,
  offsetTop: number,
): number {
  return frozenVh - (offsetTop + visibleHeight)
}

const _visibleHeight = ref(0)
const _offsetTop = ref(0)
const _keyboardOpen = ref(false)
const _signal = ref<'native' | 'browser'>('browser')

/** Live visual-viewport height (px). Same meaning as the old --velo-vvh. */
export const visibleHeight = readonly(_visibleHeight)
/** Live visual-viewport pan from the layout viewport's top (px). NEW. */
export const viewportOffsetTop = readonly(_offsetTop)
/** True while the on-screen keyboard is open. */
export const keyboardOpen = readonly(_keyboardOpen)
/** Which signal decided the current `keyboardOpen` value -- for diagnostics. */
export const keyboardSignal = readonly(_signal)

function publish(vv: VisualViewport): void {
  _visibleHeight.value = vv.height
  _offsetTop.value = vv.offsetTop

  const nativeDelta = nativeKeyboardDelta()
  _signal.value = nativeDelta !== null ? 'native' : 'browser'
  _keyboardOpen.value = isKeyboardOpenFrom(
    nativeDelta,
    window.innerHeight,
    vv.height,
    KEYBOARD_VIEWPORT_THRESHOLD,
  )

  const root = document.documentElement
  root.style.setProperty('--velo-vvh', `${vv.height}px`)
  root.style.setProperty('--velo-vv-offset', `${vv.offsetTop}px`)
  root.classList.toggle('is-keyboard-open', _keyboardOpen.value)
}

function resetState(): void {
  resetKeyboardViewportState()
  document.documentElement.style.setProperty('--velo-vv-offset', '')
  _keyboardOpen.value = false
  _offsetTop.value = 0
}

/**
 * Mount ONCE from App.vue (the always-mounted root) -- the single
 * visualViewport listener for live keyboard/viewport state. See the file
 * header for what this replaces.
 */
export function useViewportGeometry(): void {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null
  let rafId = 0
  let stopAfterEach: (() => void) | null = null
  let suppressUntil = 0

  function setShift(): void {
    rafId = 0
    if (!vv) return
    if (Date.now() < suppressUntil) {
      resetState()
      return
    }
    publish(vv)
  }

  function schedule(): void {
    if (rafId) return
    rafId = window.requestAnimationFrame(setShift)
  }

  onMounted(() => {
    if (!vv) return
    vv.addEventListener('resize', schedule)
    vv.addEventListener('scroll', schedule)
    setShift()
    // K3f (moved verbatim from useBackgroundStabilizer.ts): clear stale
    // keyboard state the instant the route changes, dismiss the keyboard,
    // then suppress re-assertion while it animates shut so the next screen
    // never inherits keyboard-open geometry.
    stopAfterEach = router.afterEach(() => {
      ;(document.activeElement as HTMLElement | null)?.blur?.()
      resetState()
      suppressUntil = Date.now() + NAV_SUPPRESS_MS
      window.setTimeout(schedule, NAV_SUPPRESS_MS)
    })
  })

  onBeforeUnmount(() => {
    if (rafId) {
      window.cancelAnimationFrame(rafId)
      rafId = 0
    }
    vv?.removeEventListener('resize', schedule)
    vv?.removeEventListener('scroll', schedule)
    stopAfterEach?.()
    stopAfterEach = null
    resetState()
  })
}
