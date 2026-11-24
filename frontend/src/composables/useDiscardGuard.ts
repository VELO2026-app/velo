// =============================================================================
// VELO Frontend -- useDiscardGuard (FE-233, package 2)
// =============================================================================
//
// Glue between a form in a bottom sheet and the "Discard changes?" question.
// While the form has unsaved edits the sheet is not dismissible: a swipe, a
// scrim tap, Escape or the cancel button emit `dismissAttempt`, and `ask`
// opens the confirm dialog instead of dropping the edits silently.
//
//   <VBottomSheet :dismissible="guard.dismissible.value"
//                 @dismiss-attempt="guard.ask" @close="emit('close')">
//   <VConfirmDialog :open="guard.confirming.value" ...
//                   @confirm="guard.discard" @cancel="guard.keepEditing" />
//
// A form backed by `useFormDraft` drops its stored draft in `onDiscard`
// (`draft.discard(); emit('close')`), so a half-filled form does not come back.
// No sheet has a draft today: the guard stays free of that dependency.
// =============================================================================

import { computed, ref, type ComputedRef, type Ref } from 'vue'

/** Options of `useDiscardGuard`. */
export interface DiscardGuardOptions {
  /** True while the form holds edits worth keeping. */
  dirty: () => boolean
  /** Reset the form and close the sheet: runs after the person confirms. */
  onDiscard: () => void
}

/** What `useDiscardGuard` returns. */
export interface DiscardGuard {
  /** Bind to the sheet's `dismissible`. */
  dismissible: ComputedRef<boolean>
  /** Bind to the confirm dialog's `open`. */
  confirming: Ref<boolean>
  /** The sheet's `dismissAttempt`: open the question (nothing when clean). */
  ask: () => void
  /** The dialog's confirm: drop the edits and close the sheet. */
  discard: () => void
  /** The dialog's cancel: back to the form. */
  keepEditing: () => void
}

/**
 * Guard a sheet form against losing unsaved edits.
 *
 * @param options - See `DiscardGuardOptions`.
 */
export function useDiscardGuard(options: DiscardGuardOptions): DiscardGuard {
  const confirming = ref(false)
  const dismissible = computed(() => !options.dirty())

  function ask(): void {
    if (options.dirty()) confirming.value = true
  }

  function discard(): void {
    confirming.value = false
    options.onDiscard()
  }

  function keepEditing(): void {
    confirming.value = false
  }

  return { dismissible, confirming, ask, discard, keepEditing }
}
