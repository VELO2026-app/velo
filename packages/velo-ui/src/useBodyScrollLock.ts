// =============================================================================
// @velo/ui -- body scroll lock (shared, ref-counted; W16, PROMPT №409)
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
// caller must pair calls 1:1 (see the overlays' per-instance `locked` guard
// that makes this safe against a watch firing more than once, or unmounting
// without ever having opened).
//
// A generic kit citizen since FE-143 (moved from the app's
// @/composables/useBodyScrollLock): the count, the API and the root-class
// contract are the kit's own, and every document write goes through the
// kit's document seam (src/platform/dom.ts) -- the app's @/platform/dom
// stays behind in the app. The host's real scroller is often NOT body (in
// the VELO app it is MobileLayout's <main>): the root class
// SCROLL_LOCK_CLASS lets a host layout freeze its own overflow too, so the
// feed under an open sheet/modal does not scroll through on iOS.
// =============================================================================

import { setBodyOverflow, toggleRootClass } from './platform/dom'

/**
 * The root class applied while the body is locked. A host layout may freeze
 * its own scroller on it (the VELO app's MobileLayout does -- the app's
 * real scroller is the layout main, not body).
 */
export const SCROLL_LOCK_CLASS = 'velo-scroll-locked'

let lockCount = 0

/**
 * Lock body scroll, ref-counted: `hidden` lands on the FIRST lock and stays
 * until every caller that locked has released. Callers must pair with
 * unlockBodyScroll 1:1.
 */
export function lockBodyScroll(): void {
  lockCount += 1
  if (lockCount === 1) {
    setBodyOverflow('hidden')
    toggleRootClass(SCROLL_LOCK_CLASS, true)
  }
}

/**
 * Release one lock. An extra release beyond the lock count is clamped at
 * zero (never negative, never stuck locked); only the release that returns
 * the count to zero actually unlocks.
 */
export function unlockBodyScroll(): void {
  lockCount = Math.max(0, lockCount - 1)
  if (lockCount === 0) {
    setBodyOverflow('')
    toggleRootClass(SCROLL_LOCK_CLASS, false)
  }
}
