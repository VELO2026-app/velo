// =============================================================================
// @velo/ui -- the document seam (FE-143, tz-ui-package.md §4 P5)
// =============================================================================
//
// The kit's ONE door to `document`, mirroring the app's platform/dom.ts
// (frontend/src/platform/dom.ts) under the same law: package code meets
// window/document only inside src/platform/**, enforced here by
// no-restricted-globals exactly like the frontend's seam.
//
// Mini on purpose (FE-143): only what the kit's own residents need. The
// event pair onDocumentEvent/offDocumentEvent is what the P6 overlays
// (VModal/VBottomSheet) bind for their document-level Escape keydown; the
// write pair setBodyOverflow/toggleRootClass is what the kit's ref-counted
// body-scroll lock (src/useBodyScrollLock.ts, moved from the app in
// FE-143) applies and releases. Anything a future resident needs grows
// HERE, never as a bare global in a component.
// =============================================================================

/** document.addEventListener typed over the document event map. */
export function onDocumentEvent<K extends keyof DocumentEventMap>(
  type: K,
  listener: (this: Document, ev: DocumentEventMap[K]) => unknown,
  options?: AddEventListenerOptions | boolean,
): void {
  document.addEventListener(type, listener as EventListener, options)
}

/** document.removeEventListener, the pair of onDocumentEvent. */
export function offDocumentEvent<K extends keyof DocumentEventMap>(
  type: K,
  listener: (this: Document, ev: DocumentEventMap[K]) => unknown,
  options?: EventListenerOptions | boolean,
): void {
  document.removeEventListener(type, listener as EventListener, options)
}

/** document.body.style.overflow = value (the body-scroll lock's on/off). */
export function setBodyOverflow(value: string): void {
  document.body.style.overflow = value
}

/** document.documentElement.classList.toggle -- the body-scroll lock marks
 *  the root so a host layout can freeze its own scroller while an overlay
 *  is open (the VELO app's MobileLayout does, on SCROLL_LOCK_CLASS). */
export function toggleRootClass(cls: string, force: boolean): void {
  document.documentElement.classList.toggle(cls, force)
}

/** getComputedStyle(document.documentElement).getPropertyValue(prop) -- a
 *  token on the host root, read as-is (no var() resolution). */
export function rootStyleValue(prop: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(prop)
}

/** A duration token on the root (`--velo-dur-*`) in ms. The unit-test DOM
 *  (happy-dom resolves no styles) yields the fallback -- the same law as
 *  everywhere in this package: tokens ride var(), tests assert the DOM,
 *  never computed styles.
 *
 * @returns `fallback` where the token is not set or not parseable. */
export function rootDurationMs(prop: string, fallback: number): number {
  const raw = rootStyleValue(prop).trim()
  const value = parseFloat(raw)
  if (!Number.isFinite(value)) return fallback
  return raw.endsWith('ms') ? value : raw.endsWith('s') ? value * 1000 : value
}

/** The user asked the OS for less motion (animations become instant). */
export function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}
