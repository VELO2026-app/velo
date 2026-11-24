// =============================================================================
// VELO Frontend -- useListboxNav tests
// =============================================================================
// The keyboard contract of a search field with a suggestion list: arrows move
// a wrapping highlight, Enter picks it, IME composition is left alone, and the
// highlight clears when the list changes.
// =============================================================================

import { describe, it, expect, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useListboxNav } from './useListboxNav'

function key(k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: k, cancelable: true, ...init })
}

function setup(count = 3) {
  const n = ref(count)
  const onSelect = vi.fn()
  const scope = effectScope()
  const nav = scope.run(() => useListboxNav({ count: () => n.value, onSelect, resetOn: n }))!
  return { nav, n, onSelect, scope }
}

describe('useListboxNav', () => {
  it('ArrowDown from the last option wraps to the first', () => {
    const { nav, scope } = setup(3)
    nav.onKeydown(key('ArrowUp')) // nothing -> last
    expect(nav.activeIndex.value).toBe(2)
    nav.onKeydown(key('ArrowDown'))
    expect(nav.activeIndex.value).toBe(0)
    scope.stop()
  })

  it('arrows and Enter are ignored while an IME composition is active', () => {
    const { nav, onSelect, scope } = setup(3)
    const down = key('ArrowDown', { isComposing: true })
    expect(nav.onKeydown(down)).toBe(false)
    expect(down.defaultPrevented).toBe(false)
    expect(nav.activeIndex.value).toBe(-1)
    nav.onKeydown(key('ArrowDown'))
    expect(nav.onKeydown(key('Enter', { isComposing: true }))).toBe(false)
    expect(onSelect).not.toHaveBeenCalled()
    scope.stop()
  })

  it('Enter picks the highlighted option; with none highlighted it is left to the caller', () => {
    const { nav, onSelect, scope } = setup(3)
    const idle = key('Enter')
    expect(nav.onKeydown(idle)).toBe(false)
    expect(idle.defaultPrevented).toBe(false)
    nav.onKeydown(key('ArrowDown'))
    nav.onKeydown(key('ArrowDown'))
    expect(nav.onKeydown(key('Enter'))).toBe(true)
    expect(onSelect).toHaveBeenCalledWith(1)
    scope.stop()
  })

  it('an empty list ignores the arrows', () => {
    const { nav, scope } = setup(0)
    const down = key('ArrowDown')
    expect(nav.onKeydown(down)).toBe(false)
    expect(down.defaultPrevented).toBe(false)
    scope.stop()
  })

  it('clears the highlight when the reset source changes', async () => {
    const { nav, n, scope } = setup(3)
    nav.onKeydown(key('ArrowDown'))
    expect(nav.optionAttrs(0).class).toBe('velo-listbox-active')
    n.value = 4
    await nextTick()
    expect(nav.activeIndex.value).toBe(-1)
    scope.stop()
  })

  it('options are not tab stops and the selected one says so', () => {
    const { nav, scope } = setup(2)
    expect(nav.optionAttrs(0, true)).toMatchObject({ 'aria-selected': true, tabindex: '-1' })
    expect(nav.optionAttrs(1)).toMatchObject({ 'aria-selected': false })
    scope.stop()
  })
})
