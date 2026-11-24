// =============================================================================
// @velo/ui -- overlay accessibility and resilience (FE-233, package 1)
// =============================================================================
//
// Three small behaviours shared by VModal and VBottomSheet (VConfirmDialog
// rides VModal):
//
//  1. Focus: opening an overlay moves focus INTO it; closing returns focus to
//     the element that opened it.
//  2. Inert page: while an overlay is open, every other direct child of <body>
//     gets `inert` (Tab and screen readers no longer reach the page under it).
//     Live regions (toasts, role=status/alert, aria-live) stay reachable. A
//     per-element counter keeps nested overlays from clearing each other's
//     `inert`.
//  3. Backdrop dismiss: a tap closes the overlay only when the press both
//     STARTED and ENDED on the backdrop. Selecting text and releasing the
//     finger on the backdrop (or the reverse) used to close it, because
//     `@click.self` alone fires for both gestures.
//
// The approach of 2 and 3 follows the modal / dismiss modules of Vercel's UI
// SDK (https://github.com/vercel-labs/ui, Apache-2.0); this is an independent
// re-implementation for Vue 3 and the kit's document seam, not a copy.
//
// The Escape stack is separate (src/escapeStack.ts, FE-215), and so is the
// scroll lock (src/useBodyScrollLock.ts). Document access goes through the
// seam (src/platform/dom.ts).
// =============================================================================

import { nextTick, onUnmounted, watch } from 'vue'
import { bodyChildren, elementAtPoint, focusedElement, onDocumentEvent } from './platform/dom'

type Root = HTMLElement | null | undefined

/** Top-level elements that must stay reachable while an overlay is open. */
const LIVE_REGION = '[role="status"], [role="alert"], [aria-live]:not([aria-live="off"])'

/** What a tap can realistically have opened an overlay from. */
const FOCUSABLE = 'button, a[href], input, select, textarea, summary, [role="button"], [tabindex]'

/** How many open overlays currently hold each element inert. */
const inertHolders = new Map<HTMLElement, number>()

function holdInert(el: HTMLElement): void {
  const holders = inertHolders.get(el) ?? 0
  if (holders === 0) el.setAttribute('inert', '')
  inertHolders.set(el, holders + 1)
}

function releaseInert(el: HTMLElement): void {
  const holders = (inertHolders.get(el) ?? 0) - 1
  if (holders > 0) {
    inertHolders.set(el, holders)
    return
  }
  inertHolders.delete(el)
  el.removeAttribute('inert')
}

// WebKit (iOS) does not focus a <button> on tap, so `activeElement` is <body>
// when an overlay opens from one. The last pointerdown target stands in as the
// element to hand focus back to. Bound once, on the first overlay set up.
let lastPressTarget: Element | null = null
let trackingPress = false

function trackPress(): void {
  if (trackingPress) return
  trackingPress = true
  onDocumentEvent(
    'pointerdown',
    (event) => {
      lastPressTarget = event.target instanceof Element ? event.target : null
    },
    { capture: true, passive: true },
  )
}

interface Layer {
  /** False once closed or unmounted; a layer closed before its batch ran never holds anything. */
  live: boolean
  roots: () => ReadonlyArray<Root>
  focusTarget: () => Root
  /** Filled when the batch runs: the template refs are set by then. */
  ownRoots: ReadonlyArray<Root>
  focusReturnTarget: HTMLElement | null
  held: HTMLElement[]
}

// Layers that opened in the same tick are applied together, so none of them
// makes another one's roots inert (a modal and a sheet nested in its slot,
// both mounted open). A layer opened in a LATER tick does inert the earlier
// ones: they are ordinary body children to it.
let batch: Layer[] = []

function applyBatch(): void {
  const layers = batch.filter((layer) => layer.live)
  batch = []
  for (const layer of layers) {
    // Roots are read now and kept: by close time Vue has cleared the template
    // refs behind roots() (the elements linger only for the leave transition).
    layer.ownRoots = layer.roots()
    layer.focusReturnTarget = resolveFocusReturnTarget(layer.ownRoots)
  }
  const batchRoots = layers.flatMap((layer) => layer.ownRoots)
  for (const layer of layers) {
    layer.held = bodyChildren().filter((el) => !batchRoots.includes(el) && !el.matches(LIVE_REGION))
    layer.held.forEach(holdInert)
  }
  // Document order = open order: the last layer of the batch is the top one.
  for (const layer of layers) layer.focusTarget()?.focus({ preventScroll: true })
}

function resolveFocusReturnTarget(ownRoots: ReadonlyArray<Root>): HTMLElement | null {
  const focused = focusedElement()
  if (focused) return focused
  const pressed = lastPressTarget?.closest<HTMLElement>(FOCUSABLE) ?? null
  lastPressTarget = null
  return pressed && !ownRoots.some((root) => root?.contains(pressed)) ? pressed : null
}

/**
 * Make the page under an overlay inert and move focus into it, for as long as
 * `isOpen()` is true.
 *
 * @remarks
 * On open (after render) every direct child of `<body>` that is not one of
 * `roots()` and not a live region becomes `inert`, and `focusTarget()` takes
 * focus. The element to return focus to is the focused one, or, where the
 * platform did not focus the tapped button (iOS), the last pointerdown target
 * outside the overlay. On close or unmount exactly the elements this layer
 * made inert are released and focus goes back, unless the caller already moved
 * it outside the overlay or the opener left the document. An overlay opened
 * on top of another one inerts the lower one; the lower one stays inert until
 * the upper one releases it. Overlays opened in the same tick do not inert
 * each other. Must be called inside a component's setup.
 *
 * @param isOpen - Reactive getter; the layer is active exactly while it returns true.
 * @param roots - The overlay's own top-level elements (teleported scrim and overlay).
 * @param focusTarget - The element that receives focus on open (give it `tabindex="-1"`).
 *
 * @see FE-233
 */
export function useOverlayLayer(
  isOpen: () => boolean,
  roots: () => ReadonlyArray<Root>,
  focusTarget: () => Root,
): void {
  trackPress()
  let layer: Layer | null = null

  function activate(): void {
    layer = { live: true, roots, focusTarget, ownRoots: [], focusReturnTarget: null, held: [] }
    batch.push(layer)
    if (batch.length === 1) void nextTick(applyBatch)
  }

  function deactivate(): void {
    const closing = layer
    layer = null
    if (!closing) return
    closing.live = false
    closing.held.forEach(releaseInert)
    const back = closing.focusReturnTarget
    if (!back?.isConnected) return
    const current = focusedElement()
    // Focus still inside the overlay (or lost to <body>): hand it back.
    // Anywhere else means the caller already moved it on purpose.
    if (!current || closing.ownRoots.some((root) => root?.contains(current))) {
      back.focus({ preventScroll: true })
    }
  }

  watch(isOpen, (open) => (open ? activate() : deactivate()), {
    immediate: true,
    flush: 'post',
  })
  onUnmounted(deactivate)
}

/**
 * Backdrop-tap handlers: a tap dismisses only when the press started AND ended
 * on the backdrop.
 *
 * @remarks
 * Bind `onPointerdown`, `onPointerup`, `onPointercancel` and `onClick` on the
 * overlay element. The gesture is judged at pointerup (a click after a drag
 * lands on the common ancestor, which is the backdrop for any press that
 * started inside the dialog); the flag is cleared there, and on pointercancel.
 * Touch pointers are implicitly captured by the element they went down on, so
 * their release position is read with `elementFromPoint`. A click with no
 * pointer events at all (assistive technology, synthetic click) dismisses.
 *
 * @param dismiss - Called for a genuine backdrop tap.
 *
 * @see FE-233
 */
export function useBackdropDismiss(dismiss: () => void): {
  onPointerdown: (event: PointerEvent) => void
  onPointerup: (event: PointerEvent) => void
  onPointercancel: () => void
  onClick: (event: MouseEvent) => void
} {
  let downOnBackdrop = false
  // null: no pointer gesture seen for this click (assistive tech, synthetic).
  let verdict: boolean | null = null
  return {
    onPointerdown(event) {
      downOnBackdrop = event.target === event.currentTarget
    },
    onPointerup(event) {
      const upTarget =
        event.pointerType === 'touch' ? elementAtPoint(event.clientX, event.clientY) : event.target
      verdict = downOnBackdrop && upTarget === event.currentTarget
      downOnBackdrop = false
    },
    onPointercancel() {
      downOnBackdrop = false
      verdict = false
    },
    onClick(event) {
      const ok = verdict !== false
      verdict = null
      if (event.target === event.currentTarget && ok) dismiss()
    },
  }
}
