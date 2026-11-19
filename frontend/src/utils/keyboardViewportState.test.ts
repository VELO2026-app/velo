// =============================================================================
// VELO Frontend -- keyboardViewportState.ts Unit Tests (dancing-bg #4, item 6)
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest'
import { resetKeyboardViewportState } from '@/utils/keyboardViewportState'

describe('resetKeyboardViewportState', () => {
  beforeEach(() => {
    document.documentElement.className = ''
    document.documentElement.style.removeProperty('--velo-vvh')
  })

  it('drops is-keyboard-open and clears --velo-vvh', () => {
    document.documentElement.classList.add('is-keyboard-open')
    document.documentElement.style.setProperty('--velo-vvh', '540px')

    resetKeyboardViewportState()

    expect(document.documentElement.classList.contains('is-keyboard-open')).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--velo-vvh')).toBe('')
  })

  it('is a no-op on an already at-rest document (idempotent)', () => {
    resetKeyboardViewportState()

    expect(document.documentElement.classList.contains('is-keyboard-open')).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--velo-vvh')).toBe('')
  })
})
