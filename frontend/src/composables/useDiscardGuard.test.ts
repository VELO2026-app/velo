// The dialog and sheet wiring is pinned in ReportUserSheet.test.ts; this file
// holds what only the composable itself decides.

import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useDiscardGuard } from '@/composables/useDiscardGuard'

describe('useDiscardGuard', () => {
  it('asks nothing of a clean form: an attempt opens no question', () => {
    const guard = useDiscardGuard({ dirty: () => false, onDiscard: vi.fn() })

    guard.ask()

    expect(guard.confirming.value).toBe(false)
  })

  it('follows the form: edits make the sheet hold, undoing them lets it go', () => {
    const dirty = ref(true)
    const guard = useDiscardGuard({ dirty: () => dirty.value, onDiscard: vi.fn() })
    expect(guard.dismissible.value).toBe(false)

    dirty.value = false

    expect(guard.dismissible.value).toBe(true)
  })

  it('keep editing closes the question without discarding', () => {
    const onDiscard = vi.fn()
    const guard = useDiscardGuard({ dirty: () => true, onDiscard })
    guard.ask()

    guard.keepEditing()

    expect(guard.confirming.value).toBe(false)
    expect(onDiscard).not.toHaveBeenCalled()
  })
})
