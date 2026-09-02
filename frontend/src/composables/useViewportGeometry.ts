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
 * sheets) needs zero changes. `--velo-vv-offset` (px, visualViewport.offsetTop)
 * is read by the debug panel only as of PROMPT №663 -- the diary's own
 * composer/header rules that used to consume it were removed (ruling 4's
 * normal-flow rebuild made them unnecessary; see DiaryFeedView.vue).
 *
 * PROMPT №663: `keyboardOpen`'s decision input changed from
 * `nativeKeyboardDelta()` (Telegram's stableHeight vs height) to
 * `restBaselineDelta()`, a self-captured rest-height baseline -- a DEVICE
 * measurement showed both the native AND browser deltas collapse to ~0 on
 * (at least) one real Android/Telegram combination, so `is-keyboard-open`
 * had never matched there at all. This is APP-WIDE, not diary-only: every
 * `.velo-kbd-scroll` consumer (global.css) and the tab bar (`useKeyboardOpen`)
 * read the SAME `keyboardOpen` ref and were equally silently inert on that
 * device class. See restBaselineDelta's own docstring for the full mechanism.
 */

// K3f suppression window (ms): a soft keyboard animates shut over ~250ms; hold
// at-rest geometry a touch longer so no closing-keyboard frame re-caps the
// freshly navigated screen. Unchanged value, moved verbatim from
// useBackgroundStabilizer.ts.
const NAV_SUPPRESS_MS = 350

// [FE-44] CLOSE-SETTLE window (ms): how long the close-time hold lasts --
// the root freeze (html.is-keyboard-closing -> body position:fixed,
// global.css), the publish suppression and the final truth re-check all key
// off this ONE timer. Must outlast BOTH the fold animation (~250-300ms) AND
// iOS's late focus-scroll restore, which can land well after the keyboard is
// visually gone (the "old above-keyboard view flashes back" report).
const KEYBOARD_CLOSE_SETTLE_MS = 700

// PROMPT №663: settle window (ms) before trusting a post-rotation reading as
// the new rest baseline -- same VALUE and REASON as
// useBackgroundStabilizer's own ORIENTATION_SETTLE_MS (rotation dimensions
// aren't always final the instant `orientationchange` fires), duplicated
// here deliberately rather than imported, so this file's rest-height capture
// stays fully independent of that other mechanism (see restBaselineDelta's
// own docstring for why that independence matters).
const ORIENTATION_SETTLE_MS = 300

/**
 * Telegram's own (stableHeight - height), or null when there's no native
 * signal to use (standalone/browser, or the @tma.js/sdk-vue viewport never
 * mounted). Pure, exported for unit tests -- unchanged from the retired
 * utils/keyboardDetection.ts. KEPT as a diagnostic cross-check (the debug
 * panel still reads it) but NO LONGER the decision input -- see
 * restBaselineDelta below for why, and the PROMPT №663 comment on `publish()`.
 */
export function nativeKeyboardDelta(): number | null {
  if (!viewport.isMounted()) return null
  return viewport.stableHeight() - viewport.height()
}

/**
 * Delta (px) between a first-observed "rest" visual-viewport height and the
 * current one, or null while no baseline is established yet (restHeight <= 0
 * -- the very first reading seeds it and cannot judge itself against it).
 *
 * PROMPT №663, added after a DEVICE measurement (five screenshots, the
 * owner's Android, prod `2d4fb6ce`): with the keyboard visibly open,
 * `viewport.stableHeight()` reported the SAME shrunken value as
 * `viewport.height()` (523.7 == 523.7), so `nativeKeyboardDelta()` returned
 * ~0 -- Telegram itself considers the shrunken height "stable" on this
 * device. `window.innerHeight` moved in lockstep with `visualViewport.height`
 * too (523 vs 523.7), so the browser fallback (`layoutHeight - visualHeight`)
 * failed identically -- the WebView's own rendering surface shrinks before
 * the CSS engine ever sees it, so neither existing signal has a FIXED point
 * to measure from. `is-keyboard-open` had therefore never matched on this
 * device; every consumer of `keyboardOpen` was silently inert.
 *
 * This baseline is captured HERE, independently -- deliberately NOT reusing
 * useBackgroundStabilizer's `--velo-frozen-vh`, which is a DIFFERENT
 * mechanism with its own unresolved mount-timing race (B29). Reaching into
 * it would inherit that race; this capture is self-contained and self-heals
 * from an early undersized reading the same way `updateRestHeight` does
 * below (a later, taller reading raises the baseline, never the reverse).
 */
export function restBaselineDelta(restHeight: number, currentHeight: number): number | null {
  if (restHeight <= 0) return null
  return restHeight - currentHeight
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
const _signal = ref<'baseline' | 'native' | 'browser'>('browser')
const _restHeight = ref(0)

/** Live visual-viewport height (px). Same meaning as the old --velo-vvh. */
export const visibleHeight = readonly(_visibleHeight)
/** Live visual-viewport pan from the layout viewport's top (px). NEW. */
export const viewportOffsetTop = readonly(_offsetTop)
/** True while the on-screen keyboard is open. */
export const keyboardOpen = readonly(_keyboardOpen)
/** Which signal decided the current `keyboardOpen` value -- for diagnostics. */
export const keyboardSignal = readonly(_signal)
/** The self-captured "rest" baseline restBaselineDelta measures against -- for diagnostics (PROMPT №663). */
export const keyboardRestHeight = readonly(_restHeight)

/** A taller reading raises the baseline (covers a slow-finishing native
 *  expand()); it never lowers it here -- a genuine rest-state change
 *  (rotation) is handled by resetting it to 0 on orientationchange, below. */
function updateRestHeight(h: number): void {
  if (h > _restHeight.value) _restHeight.value = h
}

function publish(vv: VisualViewport): void {
  _visibleHeight.value = vv.height
  _offsetTop.value = vv.offsetTop

  // PROMPT №663: restBaselineDelta first -- computed against the baseline AS
  // OF BEFORE this call updates it, so the very first-ever reading (baseline
  // still 0) correctly falls through to the old native/browser pair instead
  // of judging itself against itself. nativeKeyboardDelta() stays as a
  // diagnostic cross-check (the debug panel still shows it) but is no longer
  // the decision input -- see restBaselineDelta's own docstring for why.
  const baselineDelta = restBaselineDelta(_restHeight.value, vv.height)
  updateRestHeight(vv.height)

  const nativeDelta = nativeKeyboardDelta()
  const decidingDelta = baselineDelta ?? nativeDelta
  _signal.value = baselineDelta !== null ? 'baseline' : nativeDelta !== null ? 'native' : 'browser'
  _keyboardOpen.value = isKeyboardOpenFrom(
    decidingDelta,
    window.innerHeight,
    vv.height,
    KEYBOARD_VIEWPORT_THRESHOLD,
  )

  const root = document.documentElement
  root.style.setProperty('--velo-vvh', `${vv.height}px`)
  root.style.setProperty('--velo-vv-offset', `${vv.offsetTop}px`)
  root.classList.toggle('is-keyboard-open', _keyboardOpen.value)
  // [FE-7] root pan is undone by the scroll/touchend listeners inside
  // useViewportGeometry() (the pan always fires a window scroll event);
  // publish() itself stays pure geometry.
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
  let orientationResetId = 0

  function setShift(): void {
    rafId = 0
    if (!vv) return
    if (Date.now() < suppressUntil) {
      resetState()
      return
    }
    // [FE-44] A RISING height while the keyboard is open is the CLOSE (or
    // the native expand()) animating: intermediate resizes lag the visual
    // reveal, and every one of them used to re-assert the keyboard cap at a
    // stale smaller height -- the keyboard slid away faster than the events
    // arrived, exposing body-white, and only the FINAL resize restored the
    // full height (the owner's "уезжает плохо: белый фон, потом
    // растягивается"). The iOS keyboard is an OVERLAY: an app already at
    // full height is simply progressively revealed -- nothing to track.
    // So: drop the cap on the FIRST rising frame and hold at-rest geometry
    // through the animation, exactly like the K3f navigation window above.
    if (_keyboardOpen.value && vv.height > _visibleHeight.value) {
      beginCloseHold()
      return
    }
    publish(vv)
  }

  function schedule(): void {
    if (rafId) return
    rafId = window.requestAnimationFrame(setShift)
  }

  // PROMPT №663: a genuine rotation can make the true rest height SMALLER
  // than before (portrait -> landscape) -- updateRestHeight only ever raises
  // the baseline, so without this it would stay wrongly stuck at the old
  // orientation's height forever, and a landscape screen would misread as
  // "keyboard open" permanently. Mirrors useBackgroundStabilizer's own
  // orientationchange handling in shape only, not by importing it (see
  // restBaselineDelta's docstring).
  function onOrientationChange(): void {
    window.clearTimeout(orientationResetId)
    orientationResetId = window.setTimeout(() => {
      _restHeight.value = 0
      schedule()
    }, ORIENTATION_SETTLE_MS)
  }

  // [FE-44] Keyboard-close helpers. TWO tiers of close detection:
  //  - focus lands on ANOTHER editable (field-to-field move -- the keyboard
  //    stays): skip entirely.
  //  - focus left every editable (or the first RISING resize arrived, see
  //    setShift): the keyboard IS closing -> beginCloseHold(). A delayed-only
  //    heal left the app capped at the stale keyboard-open height for the
  //    whole close animation, painting body-white in the space the keyboard
  //    vacates (the FE-44 device report). Resetting early is safe in BOTH
  //    worlds: if close-resizes DO fire afterwards, the suppression window
  //    holds at-rest geometry while the keyboard itself still covers the area
  //    below -- nothing white is ever exposed; if they never fire, the app is
  //    already at rest when the keyboard finishes sliding.
  //    PLUS the root-pan undo: FE-7's own device HUD measured the focus pan
  //    SURVIVING the keyboard close (scrollY stayed 154 with no scroll event
  //    afterwards to trigger onRootScroll) -- the panned root displaces the
  //    whole app column and, on iOS, drags the position:fixed background
  //    layer along without repainting it: body-white bottom band that NO
  //    keyboard-state reset can cure. So the close path zeroes the pan too,
  //    rAF-deferred exactly like onTouchEnd (never synchronously inside the
  //    event pipeline).
  function unpanRootSoon(): void {
    window.requestAnimationFrame(() => keepRootUnpanned())
  }

  // [FE-44] The close-time end-jump ("моргание"): the app returns to FULL
  // height the moment the close starts, but the VISUAL viewport only grows
  // back over the ~250ms animation -- mid-flight the document is taller than
  // the visible area, a scroll range EXISTS, and iOS's own close-time
  // restore scrolls into it, then clamps back to 0 when the range collapses
  // at animation end: one visible jolt right after the keyboard leaves.
  // Pinning the root to 0 on EVERY frame of the close window (skipping
  // active touches -- FE-7's mid-gesture rule) leaves iOS nothing to clamp:
  // scrollY is already 0 when the range disappears.
  let closePinRaf = 0
  let closeSettleTimer = 0

  function pinRootDuringClose(): void {
    if (closePinRaf) window.cancelAnimationFrame(closePinRaf)
    const until = Date.now() + NAV_SUPPRESS_MS + 100 // past the animation
    const pin = (): void => {
      if (!touching) keepRootUnpanned()
      closePinRaf = Date.now() < until ? window.requestAnimationFrame(pin) : 0
    }
    closePinRaf = window.requestAnimationFrame(pin)
  }

  /** [FE-44] The ONE close path (focusout with no editable target, or the
   * first rising resize while open): drop the keyboard cap immediately,
   * suppress re-caps for the fold animation, freeze the root (body fixed --
   * see global.css) long enough to also swallow iOS's LATE focus-scroll
   * restore, and re-check truth after everything settles. */
  function beginCloseHold(): void {
    suppressUntil = Date.now() + NAV_SUPPRESS_MS
    resetState()
    pinRootDuringClose()
    document.documentElement.classList.add('is-keyboard-closing')
    window.clearTimeout(closeSettleTimer)
    closeSettleTimer = window.setTimeout(() => {
      document.documentElement.classList.remove('is-keyboard-closing')
      unpanRootSoon()
      schedule()
    }, KEYBOARD_CLOSE_SETTLE_MS)
  }

  /** [FE-44] A genuine (re)open outranks any close hold: focus landing on
   * an editable cancels the suppression AND the root freeze so the cap
   * re-asserts from the very first falling resize, at full scroll physics. */
  function onFocusIn(e: FocusEvent): void {
    const t = e.target
    if (t instanceof HTMLElement && t.closest('input, textarea, select, [contenteditable]')) {
      suppressUntil = 0
      document.documentElement.classList.remove('is-keyboard-closing')
      window.clearTimeout(closeSettleTimer)
    }
  }

  function onFocusOut(e: FocusEvent): void {
    const next = e.relatedTarget
    if (next instanceof HTMLElement && next.closest('input, textarea, select, [contenteditable]')) {
      return
    }
    // At rest (nothing keyboard-open to close) the hold is a no-op -- a
    // focused BUTTON blurring must not freeze the root for 700ms.
    if (!_keyboardOpen.value) return
    beginCloseHold()
  }

  // [FE-7] iOS keyboard PAN undo (device-measured 2026-08-24, iPhone/Telegram):
  // WebKit does not honour index.html's `interactive-widget=resizes-visual`
  // (Chromium-only), so on focus it BOTH shrinks the visual viewport AND pans
  // the ROOT document up to "reveal" the caret -- a pan that bypasses the
  // ROOT-LOCK's overflow:hidden (global.css rule 0 documents the same escape
  // on Android). The app column is already sized to the live visible height
  // (the composer sits exactly on the keyboard's top edge), so the pan is
  // pure damage: the whole screen rides up (device HUD: scrollY 154, diary
  // top -154, composer 175px above the keyboard) and the pan also STAYS after
  // the keyboard closes. ROOT-LOCK already guarantees the root can never
  // scroll legitimately -- any scrollY != 0 is this escape, so we zero it.
  //
  // NEVER during an active touch (device finding, same session): a
  // programmatic scrollTo(0,0) fired mid-gesture CANCELS the native inner
  // scroll outright (the feed refused to scroll at all). So the undo runs on
  // touchend (after the gesture released) and on viewport publishes that land
  // outside a gesture; during the gesture itself the pan may ride up and is
  // snapped back the instant the finger lifts. `overscroll-behavior` (CSS,
  // global.css + the diary feed) keeps the gesture from chaining to the root
  // in the first place, so normally there is nothing to snap.
  let touching = false

  function keepRootUnpanned(): void {
    if (window.scrollY !== 0) window.scrollTo(0, 0)
  }

  function onRootScroll(): void {
    if (!touching) keepRootUnpanned()
  }

  function onTouchStart(): void {
    touching = true
  }

  function onTouchEnd(e: TouchEvent): void {
    touching = false
    // [FE-7] If this very tap is a FOCUS tap, do not scroll AT ALL this
    // frame: a programmatic scrollTo racing iOS's own tap-to-focus pipeline
    // CANCELS the keyboard activation outright. "Focus tap" includes the
    // composer PILL as a whole -- with unsent text the tap lands on the
    // preview SPAN while the textarea itself is still hidden, so matching
    // input/textarea alone misses it (the exact device bug: keyboard stopped
    // opening on the second tap once text existed).
    const t = e.changedTouches[0]
    const el = t ? document.elementFromPoint(t.clientX, t.clientY) : null
    if (el?.closest('input, textarea, select, [contenteditable], .composer__field')) return
    // Non-focus tap / scroll release: snap AFTER the gesture pipeline settles
    // (rAF), never synchronously inside the event.
    window.requestAnimationFrame(() => keepRootUnpanned())
  }

  onMounted(() => {
    if (!vv) return
    vv.addEventListener('resize', schedule)
    vv.addEventListener('scroll', schedule)
    window.addEventListener('orientationchange', onOrientationChange)
    // [FE-7] the pan itself fires a root scroll (NOT a visualViewport event on
    // iOS), so the undo needs its own listener to catch it the moment it starts.
    window.addEventListener('scroll', onRootScroll, { passive: true })
    // [FE-7] touch gating -- see keepRootUnpanned: no programmatic scroll
    // mid-gesture (it cancels the native inner scroll), snap back on release.
    window.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('touchend', onTouchEnd, { passive: true })
    // [FE-44] keyboard-close safety net -- see onFocusOut/onFocusIn.
    window.addEventListener('focusout', onFocusOut)
    window.addEventListener('focusin', onFocusIn)
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
    if (closePinRaf) {
      window.cancelAnimationFrame(closePinRaf)
      closePinRaf = 0
    }
    window.clearTimeout(closeSettleTimer)
    document.documentElement.classList.remove('is-keyboard-closing')
    window.clearTimeout(orientationResetId)
    vv?.removeEventListener('resize', schedule)
    vv?.removeEventListener('scroll', schedule)
    window.removeEventListener('orientationchange', onOrientationChange)
    window.removeEventListener('scroll', onRootScroll)
    window.removeEventListener('touchstart', onTouchStart)
    window.removeEventListener('touchend', onTouchEnd)
    window.removeEventListener('focusout', onFocusOut)
    window.removeEventListener('focusin', onFocusIn)
    stopAfterEach?.()
    stopAfterEach = null
    resetState()
  })
}
