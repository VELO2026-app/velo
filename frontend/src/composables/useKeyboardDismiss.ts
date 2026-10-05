// =============================================================================
// VELO Frontend -- useKeyboardDismiss (batch L, B1 — GLOBAL tap-to-dismiss)
// =============================================================================
//
// ONE app-level owner of "tap a blank area to dismiss the soft keyboard",
// replacing the seven copy-pasted per-view dismissKeyboardOnBlank handlers (K3
// systemic-fix philosophy: single owner, zero drift). Installed once from the
// app root (App.vue).
//
// A document-level click listener in CAPTURE phase. It blurs the focused field
// ONLY when the tap is a genuine blank tap on a keyboard-bearing focus:
//   · act only when document.activeElement is an INPUT / TEXTAREA /
//     [contenteditable] — never when nothing keyboard-focused (so a focused
//     native <select>, a button, etc. are left alone);
//   · never blur when the tap landed on an interactive / keyboard element —
//     the field itself, another input, buttons, links, labels, selects,
//     contenteditable. Tapping those keeps / moves focus as normal.
//
// Because it fires on `click` (a discrete tap), scrolling never triggers it, so
// scrolling a thread / list while a composer is focused won't dismiss the
// keyboard. Pickers that don't focus a text field (VSelect = native <select>,
// DatePickerSheet / TimePickerSheet wheels) never satisfy the activeElement
// gate, so they're inert. Inputs inside modals (e.g. the delete-confirm field)
// behave like any field: a blank tap dismisses, tapping the field keeps focus.
// =============================================================================

import { onDocumentEvent, offDocumentEvent, activeHTMLElement } from '@/platform/dom'
import { onBeforeUnmount, onMounted } from 'vue'

/** Elements a tap may land on without dismissing the keyboard (the field, other
 *  fields, and interactive chrome). Mirrors the old per-view selector plus
 *  [contenteditable] (now that contenteditable focus is also dismissible). */
const INTERACTIVE_SELECTOR =
  'input, textarea, select, button, [role="button"], a, label, [contenteditable]'

export function useKeyboardDismiss(): void {
  function onDocumentClick(e: MouseEvent): void {
    const active = activeHTMLElement()
    if (!active) return

    // Only a keyboard-bearing focus is dismissible.
    const tag = active.tagName
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !active.isContentEditable) return

    const target = e.target as HTMLElement | null
    if (!target) return

    // Tap landed on the field / another field / interactive chrome — leave it.
    if (target.closest(INTERACTIVE_SELECTOR)) return

    active.blur()
  }

  onMounted(() => onDocumentEvent('click', onDocumentClick, true))
  onBeforeUnmount(() => offDocumentEvent('click', onDocumentClick, true))
}
