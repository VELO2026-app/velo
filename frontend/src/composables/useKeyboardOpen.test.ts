// =============================================================================
// VELO Frontend -- useKeyboardOpen Unit Tests (PROMPT №657, rebuild)
// =============================================================================
//
// PROMPT №657: useKeyboardOpen no longer owns a visualViewport listener or a
// copy of the detection logic -- both moved to useViewportGeometry.ts, which
// owns the full overlay/shrink/pan test matrix (useViewportGeometry.test.ts).
// This file only proves the CONTRACT this wrapper exists for: it returns the
// exact same shared ref, not a second instance, and does so without mounting
// anything of its own (no onMounted/onBeforeUnmount left to test).
// =============================================================================

import { describe, it, expect } from 'vitest'
import { useKeyboardOpen } from '@/composables/useKeyboardOpen'
import { keyboardOpen } from '@/composables/useViewportGeometry'

describe('useKeyboardOpen', () => {
  it('returns the shared keyboardOpen ref from useViewportGeometry, not a copy', () => {
    const { keyboardOpen: fromWrapper } = useKeyboardOpen()
    expect(fromWrapper).toBe(keyboardOpen)
  })
})
