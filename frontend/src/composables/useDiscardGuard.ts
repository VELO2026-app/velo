// =============================================================================
// VELO Frontend -- useDiscardGuard (FE-233, package 2)
// =============================================================================
//
// Glue between a form in a bottom sheet or a modal and the "Discard changes?"
// question. While the form has unsaved edits the overlay is not dismissible: a
// swipe, a scrim tap, Escape, the native Back button or the cancel button emit
// `dismissAttempt`, and `ask` opens the confirm dialog instead of dropping the
// edits silently. Both VBottomSheet and VModal have the pair.
//
//   <VBottomSheet :dismissible="guard.dismissible.value"
//                 @dismiss-attempt="guard.ask" @close="emit('close')">
//   <DiscardChangesDialog :open="guard.confirming.value"
//                         @discard="guard.discard"
//                         @keep-editing="guard.keepEditing" />
//
// A cancel button INSIDE a modal's slot is the form's own: it calls `leave`,
// which asks when the form is dirty and closes at once when it is not.
//
// A form backed by `useFormDraft` drops its stored draft in `onDiscard`
// (`draft.discard(); emit('close')`), so a half-filled form does not come back.
// No sheet has a draft today: the guard stays free of that dependency.
// =============================================================================

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'

/** Options of `useDiscardGuard`. */
export interface DiscardGuardOptions {
  /** True while the form holds edits worth keeping. */
  dirty: () => boolean
  /** Reset the form and close the sheet: runs after the person confirms. */
  onDiscard: () => void
  /**
   * Whether the overlay is open. The question goes away with it: a parent that
   * closes the overlay on its own (a screen left, a request done) must not
   * leave "Discard changes?" hanging. Omit for a form that never closes that way.
   */
  open?: () => boolean
}

/** What `useDiscardGuard` returns. */
export interface DiscardGuard {
  /** Bind to the sheet's `dismissible`. */
  dismissible: ComputedRef<boolean>
  /** Bind to the confirm dialog's `open`. */
  confirming: Ref<boolean>
  /** The overlay's `dismissAttempt`: open the question (nothing when clean). */
  ask: () => void
  /** The form's own cancel button: open the question, or close at once when clean. */
  leave: () => void
  /** The dialog's confirm: drop the edits and close the sheet. */
  discard: () => void
  /** The dialog's cancel: back to the form. */
  keepEditing: () => void
}

/**
 * Guard a sheet or modal form against losing unsaved edits.
 *
 * @param options - See `DiscardGuardOptions`.
 */
export function useDiscardGuard(options: DiscardGuardOptions): DiscardGuard {
  const confirming = ref(false)
  const dismissible = computed(() => !options.dirty())

  const { open } = options
  if (open) {
    watch(open, (isOpen) => {
      if (!isOpen) confirming.value = false
    })
  }

  function ask(): void {
    if (options.dirty()) confirming.value = true
  }

  function leave(): void {
    if (options.dirty()) ask()
    else options.onDiscard()
  }

  function discard(): void {
    confirming.value = false
    options.onDiscard()
  }

  function keepEditing(): void {
    confirming.value = false
  }

  return { dismissible, confirming, ask, leave, discard, keepEditing }
}
