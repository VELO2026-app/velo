// =============================================================================
// VELO Frontend -- useBodyScrollLock Unit Tests
// =============================================================================
// W16 (PROMPT №409): VModal/VBottomSheet each used to set
// document.body.style.overflow directly -- with two overlays open at once,
// whichever closed SECOND unlocked the body even though the other was still
// open. lockBodyScroll/unlockBodyScroll are ref-counted so "hidden" only
// comes off once every caller that locked has released it.
//
// Module-level state (the whole point -- a shared lock across every VModal/
// VBottomSheet instance). Each test below pairs its own lock/unlock calls so
// the count returns to 0 at the end -- order-independent, no reset needed.
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest'
import { lockBodyScroll, unlockBodyScroll } from '@/composables/useBodyScrollLock'

describe('useBodyScrollLock (W16 -- ref-counted, no premature unlock)', () => {
  beforeEach(() => {
    document.body.style.overflow = ''
  })

  it('locks on the first caller', () => {
    lockBodyScroll()
    expect(document.body.style.overflow).toBe('hidden')
    unlockBodyScroll()
  })

  it('a second overlay opening while the first is open keeps the body locked, and releasing the second first does NOT unlock it', () => {
    lockBodyScroll() // overlay A opens
    lockBodyScroll() // overlay B opens (A still open)
    expect(document.body.style.overflow).toBe('hidden')

    unlockBodyScroll() // B closes first
    expect(document.body.style.overflow).toBe('hidden') // A still open -- must stay locked

    unlockBodyScroll() // A closes
    expect(document.body.style.overflow).toBe('') // now released
  })

  it('unlocking more times than locked never goes negative or gets stuck locked', () => {
    lockBodyScroll()
    unlockBodyScroll()
    unlockBodyScroll() // extra release -- must not corrupt the count
    expect(document.body.style.overflow).toBe('')

    lockBodyScroll()
    expect(document.body.style.overflow).toBe('hidden')
    unlockBodyScroll()
    expect(document.body.style.overflow).toBe('')
  })
})
