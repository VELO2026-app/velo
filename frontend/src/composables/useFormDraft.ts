// =============================================================================
// VELO Frontend -- useFormDraft (FE-157 stage 4, track 4A; was L1 / B2 inside
// CreatePracticeView)
// =============================================================================
//
// A debounced localStorage draft of a form, so a half-filled form survives an
// accidental navigation away. The draft is NOT auto-restored: on mount a
// meaningful draft is only OFFERED (`offered`), and the screen asks the person
// to restore it or start over. Storage failures (full, disabled, malformed
// JSON) are non-fatal: the draft is simply lost or dropped.
// =============================================================================

import { nextTick, onMounted, ref, watch, type Ref } from 'vue'

/** Options of `useFormDraft`. */
export interface FormDraftOptions {
  /** Storage key, read on every save; scope it per user so drafts never cross accounts. */
  key: () => string
  /** Whether a stored draft is worth offering; a draft that is not is swept from storage. */
  isMeaningful: (draft: Record<string, unknown>) => boolean
  /** Debounce of the autosave. @defaultValue 500 */
  delayMs?: number
}

/** What `useFormDraft` returns. */
export interface FormDraft {
  /** True while a stored draft waits for the person's answer. */
  offered: Ref<boolean>
  /** Fill the form from the offered draft and close the offer. */
  restore: () => void
  /** Drop the stored draft and close the offer; the form stays as it is. */
  discard: () => void
  /** The draft is fulfilled: drop it and stop autosaving for good (no late save resurrects it). */
  finish: () => void
  /** Run a programmatic fill (a template, say) that must not be saved as the person's draft. */
  withoutAutosave: (fill: () => void) => void
}

/**
 * Autosave `form` to localStorage and offer a stored draft back on mount.
 *
 * @remarks Only the person's own edits are saved: a fill run through
 * `withoutAutosave` (or `restore`) is skipped -- the save watcher fires in
 * the same flush, and autosave is re-enabled on the next tick.
 */
export function useFormDraft(form: object, options: FormDraftOptions): FormDraft {
  const delayMs = options.delayMs ?? 500
  const offered = ref(false)
  let pending: Record<string, unknown> | null = null
  let suppressed = false
  let finished = false
  let timer: ReturnType<typeof setTimeout> | undefined

  function clear(): void {
    clearTimeout(timer)
    try {
      localStorage.removeItem(options.key())
    } catch {
      // Storage disabled: nothing stored to remove.
    }
  }

  watch(
    form,
    () => {
      if (suppressed || finished) return
      clearTimeout(timer)
      timer = setTimeout(() => {
        try {
          localStorage.setItem(options.key(), JSON.stringify(form))
        } catch {
          // Storage full or disabled: a lost draft is non-fatal.
        }
      }, delayMs)
    },
    { deep: true },
  )

  function withoutAutosave(fill: () => void): void {
    suppressed = true
    fill()
    void nextTick(() => {
      suppressed = false
    })
  }

  function close(): void {
    offered.value = false
    pending = null
  }

  function restore(): void {
    const draft = pending
    if (draft) withoutAutosave(() => Object.assign(form, draft))
    close()
  }

  function discard(): void {
    clear()
    close()
  }

  function finish(): void {
    finished = true
    clear()
  }

  onMounted(() => {
    try {
      const raw = localStorage.getItem(options.key())
      if (!raw) return
      const parsed = JSON.parse(raw) as Record<string, unknown> | null
      if (parsed && options.isMeaningful(parsed)) {
        pending = parsed
        offered.value = true
      } else {
        clear()
      }
    } catch {
      // A malformed draft is dropped, never thrown into the mount.
      clear()
    }
  })

  return { offered, restore, discard, finish, withoutAutosave }
}
