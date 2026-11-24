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
//  3. Backdrop dismiss: a tap closes the overlay only when the press did not
//     START inside the dialog. Selecting text and releasing the finger on the
//     backdrop used to close it (`@click.self` alone fires for that gesture).
//
// The approach of 2 and 3 follows the modal / dismiss modules of Vercel's UI
// SDK (https://github.com/vercel-labs/ui, Apache-2.0); this is an independent
// re-implementation for Vue 3 and the kit's document seam, not a copy.
//
// The Escape stack is separate (src/escapeStack.ts, FE-215), and so is the
// scroll lock (src/useBodyScrollLock.ts). Document access goes through the
// seam (src/platform/dom.ts).
// =============================================================================

import { onUnmounted, watch } from 'vue'
import { bodyChildren, focusedElement } from './platform/dom'

/** Top-level elements that must stay reachable while an overlay is open. */
const LIVE_REGION = '[role="status"], [role="alert"], [aria-live]:not([aria-live="off"])'

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

/**
 * Make the page under an overlay inert and move focus into it, for as long as
 * `isOpen()` is true.
 *
 * @remarks
 * On open (after render) every direct child of `<body>` that is not one of
 * `roots()` and not a live region becomes `inert`; the previously focused
 * element is remembered and `focusTarget()` takes focus. On close or unmount
 * exactly those elements are released and focus goes back to the remembered
 * element, unless the user has already moved focus somewhere outside the
 * overlay. An overlay opened on top of another one inerts the lower one (its
 * roots are body children too); the lower one stays inert until the upper one
 * releases it. Must be called inside a component's setup.
 *
 * @param isOpen - Reactive getter; the layer is active exactly while it returns true.
 * @param roots - The overlay's own top-level elements (teleported scrim and overlay).
 * @param focusTarget - The element that receives focus on open (give it `tabindex="-1"`).
 *
 * @see FE-233
 */
export function useOverlayLayer(
  isOpen: () => boolean,
  roots: () => ReadonlyArray<HTMLElement | null | undefined>,
  focusTarget: () => HTMLElement | null | undefined,
): void {
  let held: HTMLElement[] = []
  let opener: HTMLElement | null = null
  let active = false
  // Captured on open: by close time Vue has already cleared the template refs
  // behind roots() (the elements linger only for the leave transition).
  let own: ReadonlyArray<HTMLElement | null | undefined> = []

  function activate(): void {
    if (active) return
    active = true
    own = roots()
    opener = focusedElement()
    held = bodyChildren().filter((el) => !own.includes(el) && !el.matches(LIVE_REGION))
    held.forEach(holdInert)
    focusTarget()?.focus({ preventScroll: true })
  }

  function deactivate(): void {
    if (!active) return
    active = false
    held.forEach(releaseInert)
    held = []
    const back = opener
    opener = null
    if (!back) return
    const current = focusedElement()
    // Focus still inside the overlay (or lost to <body>): hand it back.
    // Anywhere else means the caller already moved it on purpose.
    if (!current || own.some((el) => el?.contains(current))) back.focus({ preventScroll: true })
  }

  watch(isOpen, (open) => (open ? activate() : deactivate()), {
    immediate: true,
    flush: 'post',
  })
  onUnmounted(deactivate)
}

/**
 * Backdrop-tap handlers that ignore a press that began inside the dialog.
 *
 * @remarks
 * Bind `onPointerdown` and `onClick` on the overlay element. A click whose
 * target is the overlay itself dismisses only if the matching pointerdown also
 * landed on the overlay. A click with no pointerdown at all (assistive tech,
 * synthetic click) still dismisses.
 *
 * @param dismiss - Called for a genuine backdrop tap.
 *
 * @see FE-233
 */
export function useBackdropDismiss(dismiss: () => void): {
  onPointerdown: (event: PointerEvent) => void
  onClick: (event: MouseEvent) => void
} {
  let pressStartedInside = false
  return {
    onPointerdown(event) {
      pressStartedInside = event.target !== event.currentTarget
    },
    onClick(event) {
      if (event.target !== event.currentTarget) return
      const startedInside = pressStartedInside
      pressStartedInside = false
      if (!startedInside) dismiss()
    },
  }
}
