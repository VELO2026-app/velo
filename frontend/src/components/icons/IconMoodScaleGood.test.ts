// =============================================================================
// VELO Frontend -- IconMoodScaleGood: the F2.0 var() probe (tz-whitelabel §3.1)
// =============================================================================
// Step 0's question: does an inline SVG pick up var() in its paint
// properties? Answer locked here STRUCTURALLY: the gradient stops must carry
// token-first styles with the source hex as fallback. (Rendering itself is
// not assertable in happy-dom -- getComputedStyle does not resolve var()
// from stylesheets -- so the visual sign-off stays manual, per the TZ; the
// fallback keeps the pixels identical everywhere regardless.)
// =============================================================================

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import IconMoodScaleGood from './IconMoodScaleGood.vue'

describe('IconMoodScaleGood -- the F2.0 var() probe', () => {
  it('gradient stops paint through tokens, hex only as the fallback', () => {
    const wrapper = mount(IconMoodScaleGood)
    const stops = wrapper.findAll('stop')
    expect(stops).toHaveLength(2)
    const [roseStop, peachStop] = stops
    expect(roseStop).toBeDefined()
    expect(peachStop).toBeDefined()

    expect(roseStop?.attributes('style')).toContain(
      'stop-color: var(--velo-mood-fill-rose, #f9cbd1)',
    )
    expect(peachStop?.attributes('style')).toContain(
      'stop-color: var(--velo-mood-fill-peach, #fddfc4)',
    )
    // No bare presentation-attribute colors left on the stops.
    expect(roseStop?.attributes('stop-color')).toBeUndefined()
    expect(peachStop?.attributes('stop-color')).toBeUndefined()
  })

  it('still renders the approved art (gradient fill + stroke geometry)', () => {
    const wrapper = mount(IconMoodScaleGood)
    expect(wrapper.find('rect[fill^="url(#mood-scale-good-"]').exists()).toBe(true)
    // The three approved strokes stay untouched by the probe: same geometry,
    // now painted token-first with the source hex as fallback (batch (а)).
    expect(
      wrapper.findAll('path[style*="stroke: var(--velo-primary-dark, #4c6589)"]'),
    ).toHaveLength(3)
  })
})
