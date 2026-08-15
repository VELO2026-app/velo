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
  COMPOSING_HEIGHT_TARGET,
  COMPOSING_CHROME_OFFSET,
  COMPOSING_HEIGHT_FLOOR,
  COLLAPSED_HEIGHT_CAP,
} from './useComposerGrowCap'

describe('composerGrowCap (pure formula)', () => {
  it('not composing: flat 120px regardless of viewport height', () => {
    expect(composerGrowCap(false, 768)).toBe(COLLAPSED_HEIGHT_CAP)
    expect(composerGrowCap(false, 200)).toBe(COLLAPSED_HEIGHT_CAP)
    expect(composerGrowCap(false, 1200)).toBe(COLLAPSED_HEIGHT_CAP)
  })

  it('composing on a generous viewport (768, e.g. no keyboard/happy-dom default) reaches the full 300px target', () => {
    // 768 - 176 = 592, well above 300 -- the target applies unbounded.
    expect(composerGrowCap(true, 768)).toBe(COMPOSING_HEIGHT_TARGET)
    expect(composerGrowCap(true, 768)).toBe(300)
  })

  it("a short viewport (300) bounds the cap below 300px -- the physical limit, not a second guess at the owner's number", () => {
    // 300 - 176 = 124 -- below the 300px target, so the bound wins.
    expect(composerGrowCap(true, 300)).toBe(124)
  })

  it('an extremely short viewport (200) hits the floor, never below 80px', () => {
    // 200 - 176 = 24, floored to 80 so the field cannot collapse to one line.
    expect(composerGrowCap(true, 200)).toBe(COMPOSING_HEIGHT_FLOOR)
    expect(composerGrowCap(true, 200)).toBe(80)
  })

  it('the constants match what shipped before track 2 flattened them (regression guard on the numbers themselves)', () => {
    expect(COMPOSING_HEIGHT_TARGET).toBe(300)
    expect(COMPOSING_CHROME_OFFSET).toBe(176)
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
