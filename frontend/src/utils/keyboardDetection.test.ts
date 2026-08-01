// =============================================================================
// VELO Frontend -- keyboardDetection.ts Unit Tests (PROMPT №650, T24-1 fix)
// =============================================================================

import { describe, it, expect } from 'vitest'
import { isKeyboardOpen } from '@/utils/keyboardDetection'

describe('isKeyboardOpen', () => {
  it('detects the keyboard under the ANDROID SHRINK model, where the browser delta alone collapses to ~0', () => {
    // The WebView's own rendering surface shrunk before the CSS engine saw
    // it (useBackgroundStabilizer.ts's own header) -- innerHeight and
    // visualViewport.height moved together, so the browser-only delta is
    // near-zero even though the keyboard genuinely covers ~300px. The
    // native delta (Telegram's own stableHeight - height) is unaffected by
    // that WebView quirk and reports the real gap.
    const nativeDelta = 300
    const layoutHeight = 800
    const visualHeight = 795 // browser delta = 5, well under threshold
    const threshold = 150

    expect(isKeyboardOpen(nativeDelta, layoutHeight, visualHeight, threshold)).toBe(true)
  })

  it('detects the keyboard under the OVERLAY model (no native signal), same as before this fix', () => {
    const nativeDelta = null
    const layoutHeight = 800
    const visualHeight = 500 // browser delta = 300, over threshold
    const threshold = 150

    expect(isKeyboardOpen(nativeDelta, layoutHeight, visualHeight, threshold)).toBe(true)
  })

  it('reports closed at rest, with a native signal available (delta ~0)', () => {
    expect(isKeyboardOpen(2, 800, 798, 150)).toBe(false)
  })

  it('reports closed at rest, with no native signal (browser delta ~0)', () => {
    expect(isKeyboardOpen(null, 800, 798, 150)).toBe(false)
  })

  it('a native delta of exactly the threshold is NOT open (strictly greater, matches the existing >)', () => {
    expect(isKeyboardOpen(150, 800, 798, 150)).toBe(false)
  })
})
