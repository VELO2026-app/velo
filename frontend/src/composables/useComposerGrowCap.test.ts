// =============================================================================
// VELO Frontend -- useComposerGrowCap Unit Tests (PROMPT №741, track 3)
// =============================================================================
//
// The formula and the four numbers below are NOT new: they are the same
// composing/collapsed cap DiaryComposer.vue computed before PROMPT №740's
// extraction flattened it to a static 240px token, and the same four cases
// DiaryComposer.test.ts's own (now-replaced) "autogrow cap" describe block
// pinned. Restoring them here as a pure-function test is the point --
// checkable without a browser, unlike the viewport itself.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import {
  composerGrowCap,
  useComposerGrowCap,
  COMPOSING_HEIGHT_CEILING,
  COMPOSING_HEIGHT_FLOOR,
  COLLAPSED_HEIGHT_CAP,
} from './useComposerGrowCap'

describe('composerGrowCap (pure formula, [FE-9]: clamp(round(vh/3), 80, 240))', () => {
  it('not composing: flat 120px regardless of viewport height', () => {
    expect(composerGrowCap(false, 768)).toBe(COLLAPSED_HEIGHT_CAP)
    expect(composerGrowCap(false, 200)).toBe(COLLAPSED_HEIGHT_CAP)
    expect(composerGrowCap(false, 1200)).toBe(COLLAPSED_HEIGHT_CAP)
  })

  it('a keyboard-shrunk viewport (412, the device-measured session) caps at a third -- 137px, context stays visible', () => {
    // round(412 / 3) = 137: ~5-6 lines of text, the old flat 300px target
    // ate three quarters of this viewport.
    expect(composerGrowCap(true, 412)).toBe(137)
  })

  it('a generous viewport (768, no keyboard) reaches the 240px ceiling', () => {
    // round(768 / 3) = 256, clamped down to CEILING.
    expect(composerGrowCap(true, 768)).toBe(COMPOSING_HEIGHT_CEILING)
    expect(composerGrowCap(true, 768)).toBe(240)
  })

  it('an extremely short viewport (150) hits the floor, never below 80px', () => {
    // round(150 / 3) = 50, floored to 80 so the field cannot collapse.
    expect(composerGrowCap(true, 150)).toBe(COMPOSING_HEIGHT_FLOOR)
    expect(composerGrowCap(true, 150)).toBe(80)
  })

  it('the constants ([FE-9] rework): ceiling matches the CSS token, floor and idle cap unchanged', () => {
    expect(COMPOSING_HEIGHT_CEILING).toBe(240)
    expect(COMPOSING_HEIGHT_FLOOR).toBe(80)
    expect(COLLAPSED_HEIGHT_CAP).toBe(120)
  })
})

describe('useComposerGrowCap (reactive wrapper)', () => {
  it('falls back to window.innerHeight when the shared visibleHeight has not published yet (0, the un-mounted default)', () => {
    // useViewportGeometry() is a component-lifecycle mount (App.vue only);
    // in this unit test nothing ever called it, so its exported
    // `visibleHeight` ref is still its module-level default, 0 -- exactly
    // the "no visualViewport support" case the pre-extraction DiaryComposer
    // also fell back from.
    const composing = ref(true)
    const cap = useComposerGrowCap(composing)
    const expected = composerGrowCap(true, window.innerHeight)
    expect(cap.value).toBe(expected)
  })

  it('reacts to the composing flag flipping (idle 120 <-> composing formula)', () => {
    const composing = ref(false)
    const cap = useComposerGrowCap(composing)
    expect(cap.value).toBe(COLLAPSED_HEIGHT_CAP)

    composing.value = true
    expect(cap.value).toBe(composerGrowCap(true, window.innerHeight))
  })
})
