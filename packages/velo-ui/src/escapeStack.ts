// =============================================================================
// @velo/ui -- the Escape stack: one Escape closes only the top layer (FE-215)
// =============================================================================
//
// VModal and VBottomSheet each used to bind their own document keydown and
// close on Escape whenever they were open. With two overlays open at once
// (a VConfirmDialog over a VBottomSheet, a modal over a modal) one Escape
// closed BOTH: every listener saw the key, and none knew which overlay was
// on top.
//
// Module-level stack of open layers, ordered by the moment each one OPENED
// (not mounted: an overlay kept mounted with open=false and opened later
// must land on top of one that opened before it). A single document
// keydown listener, bound while the stack is non-empty, hands Escape to the
// top entry only; the next Escape reaches the next entry once the parent
// has closed the first one.
//
// The listener sits in the BUBBLE phase on purpose: an open VMenu takes
// Escape in the CAPTURE phase and stops it (FE-213), so a menu inside an
// overlay still closes first and the overlay never sees that key press.
//
// Document access goes through the kit's document seam (src/platform/dom.ts).
// The body-scroll lock is separate (src/useBodyScrollLock.ts): it counts
// holders, while this stack needs their order.
// =============================================================================

import { onUnmounted, watch } from 'vue'
import { onDocumentEvent, offDocumentEvent } from './platform/dom'

interface EscapeLayer {
  onEscape: () => void
}

const stack: EscapeLayer[] = []

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  // Someone below already handled this Escape, or it only ends an IME
  // composition: neither is a request to close a layer.
  if (event.defaultPrevented || event.isComposing) return
  stack[stack.length - 1]?.onEscape()
}

function push(layer: EscapeLayer): void {
  if (stack.includes(layer)) return
  stack.push(layer)
  if (stack.length === 1) onDocumentEvent('keydown', onDocumentKeydown)
}

function remove(layer: EscapeLayer): void {
  const index = stack.indexOf(layer)
  if (index === -1) return
  stack.splice(index, 1)
  if (stack.length === 0) offDocumentEvent('keydown', onDocumentKeydown)
}

/**
 * Register the calling component as an Escape-dismissable layer while `isOpen()` is true.
 *
 * @remarks
 * The layer joins the top of the shared stack when `isOpen()` turns true
 * (immediately, if it already is at setup) and leaves it when `isOpen()`
 * turns false or the component unmounts. Escape on the document calls
 * `onEscape` of the top layer only. Must be called inside a component's
 * setup (it registers an unmount hook).
 *
 * @param isOpen - Reactive getter; the layer is on the stack exactly while it returns true.
 * @param onEscape - Called when Escape is pressed and this layer is on top; usually emits `close`.
 *
 * @example
 * useEscapeLayer(() => props.open, () => emit('close'))
 *
 * @see FE-215
 */
export function useEscapeLayer(isOpen: () => boolean, onEscape: () => void): void {
  const layer: EscapeLayer = { onEscape }
  watch(isOpen, (open) => (open ? push(layer) : remove(layer)), { immediate: true })
  onUnmounted(() => remove(layer))
}
