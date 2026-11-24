import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useDiscardGuard } from '@/composables/useDiscardGuard'

function setup(initialDirty: boolean) {
  const state = ref({ dirty: initialDirty })
  const onDiscard = vi.fn()
  const discardDraft = vi.fn()
  const guard = useDiscardGuard({ dirty: () => state.value.dirty, onDiscard, discardDraft })
  return { state, guard, onDiscard, discardDraft }
}

describe('useDiscardGuard', () => {
  it('lets a clean form go: dismissible, and an attempt asks nothing', () => {
    const { guard } = setup(false)

    expect(guard.dismissible.value).toBe(true)
    guard.ask()
    expect(guard.confirming.value).toBe(false)
  })

  it('holds a form with edits: not dismissible, and an attempt opens the question', () => {
    const { guard, onDiscard } = setup(true)

    expect(guard.dismissible.value).toBe(false)
    guard.ask()
    expect(guard.confirming.value).toBe(true)
    expect(onDiscard).not.toHaveBeenCalled()
  })

  it('keep editing closes the question and leaves everything as it was', () => {
    const { guard, onDiscard, discardDraft } = setup(true)
    guard.ask()
    guard.keepEditing()

    expect(guard.confirming.value).toBe(false)
    expect(onDiscard).not.toHaveBeenCalled()
    expect(discardDraft).not.toHaveBeenCalled()
  })

  it('discard drops the stored draft, then closes the sheet', () => {
    const { guard, onDiscard, discardDraft } = setup(true)
    const order: string[] = []
    discardDraft.mockImplementation(() => order.push('draft'))
    onDiscard.mockImplementation(() => order.push('close'))
    guard.ask()
    guard.discard()

    expect(guard.confirming.value).toBe(false)
    expect(order).toEqual(['draft', 'close'])
  })

  it('follows the form: edits undone make the sheet dismissible again', () => {
    const { guard, state } = setup(true)
    state.value.dirty = false
    expect(guard.dismissible.value).toBe(true)
  })
})
