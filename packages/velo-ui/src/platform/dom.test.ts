// =============================================================================
// @velo/ui -- document seam Unit Tests (FE-143)
// =============================================================================
//
// Pins the seam's OBSERVABLE behavior only: a listener bound through
// onDocumentEvent fires on a real document dispatch, offDocumentEvent
// detaches it, and the two write helpers land on the exact DOM state the
// body-scroll lock (src/useBodyScrollLock.test.ts) and the host layout
// rely on. The functions are one-line pass-throughs to the DOM -- there is
// no branching logic to cover beyond proving the door works.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import { onDocumentEvent, offDocumentEvent, setBodyOverflow, toggleRootClass } from './dom'

describe('platform/dom (the kit document seam, FE-143)', () => {
  afterEach(() => {
    document.body.style.overflow = ''
    document.documentElement.classList.remove('velo-seam-test-locked')
  })

  it('onDocumentEvent binds a listener the document dispatch reaches', () => {
    const heard: KeyboardEvent[] = []
    const onKeydown = (e: KeyboardEvent): void => {
      heard.push(e)
    }

    onDocumentEvent('keydown', onKeydown)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(heard).toHaveLength(1)
    expect(heard[0]!.key).toBe('Escape')

    offDocumentEvent('keydown', onKeydown)
  })

  it('offDocumentEvent detaches: a later dispatch is not heard', () => {
    let heard = 0
    const onKeydown = (): void => {
      heard += 1
    }

    onDocumentEvent('keydown', onKeydown)
    offDocumentEvent('keydown', onKeydown)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(heard).toBe(0)
  })

  it('setBodyOverflow writes body.style.overflow both ways (lock and release)', () => {
    setBodyOverflow('hidden')
    expect(document.body.style.overflow).toBe('hidden')

    setBodyOverflow('')
    expect(document.body.style.overflow).toBe('')
  })

  it('toggleRootClass toggles a documentElement class by force (add and remove)', () => {
    toggleRootClass('velo-seam-test-locked', true)
    expect(document.documentElement.classList.contains('velo-seam-test-locked')).toBe(true)

    toggleRootClass('velo-seam-test-locked', false)
    expect(document.documentElement.classList.contains('velo-seam-test-locked')).toBe(false)
  })
})
