// =============================================================================
// VELO Frontend -- Body scroll-lock (shared, ref-counted) (W16, PROMPT №409)
// =============================================================================
//
// VModal and VBottomSheet each used to set document.body.style.overflow
// directly and independently. With two overlays open at once (e.g. a
// VBottomSheet opened from inside a VModal), whichever one closed SECOND
// unlocked the body even if the other overlay was still open -- the
// background could scroll behind a still-visible modal.
//
// Module-level reference count: "hidden" is applied once on the first lock
// and only removed once every caller that locked has released it. Each
// caller must pair calls 1:1 (see VModal.vue / VBottomSheet.vue for the
// per-instance `locked` guard that makes this safe against a watch firing
// more than once, or unmounting without ever having opened).
//
// The app's real scroller is MobileLayout's <main>, not body: the root class
// SCROLL_LOCK_CLASS lets that layout freeze its own overflow too, so the
// feed under an open sheet/modal does not scroll through on iOS.
// =============================================================================

import { setBodyOverflow, toggleRootClass } from '@/platform/dom'

/** Root class applied while the body scroll is locked, so MobileLayout can freeze its own scroller too. */
export const SCROLL_LOCK_CLASS = 'velo-scroll-locked'

let lockCount = 0

/** Lock background scrolling (ref-counted: the body unlocks only when every locker has released). */
export function lockBodyScroll(): void {
  lockCount += 1
  if (lockCount === 1) {
    setBodyOverflow('hidden')
    toggleRootClass(SCROLL_LOCK_CLASS, true)
  }
}

/** Release one scroll-lock hold (ref-counted counterpart of lockBodyScroll). */
export function unlockBodyScroll(): void {
  lockCount = Math.max(0, lockCount - 1)
  if (lockCount === 0) {
    setBodyOverflow('')
    toggleRootClass(SCROLL_LOCK_CLASS, false)
  }
}
