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
// =============================================================================

let lockCount = 0

export function lockBodyScroll(): void {
  lockCount += 1
  if (lockCount === 1) document.body.style.overflow = 'hidden'
}

export function unlockBodyScroll(): void {
  lockCount = Math.max(0, lockCount - 1)
  if (lockCount === 0) document.body.style.overflow = ''
}
