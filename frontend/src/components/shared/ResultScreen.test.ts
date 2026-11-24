// =============================================================================
// VELO Frontend -- ResultScreen: the root class MobileLayout's fog rule keys on
// =============================================================================
//
// The full-screen result takeover (check-in / feedback / reflection success,
// practice sold-out) sits inside the masked scroller of a fog screen.
// MobileLayout lifts the mask with `.mobile-layout__main--fog:has(.result-screen)`
// (FE-261); happy-dom computes neither :has() nor masks, so the layout itself is
// browser-verified (the top strip of the screen painted as page background under
// the fog). This test holds the one half it can: the root class stays.
// =============================================================================

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ResultScreen from '@/components/shared/ResultScreen.vue'

describe('ResultScreen', () => {
  it('wraps its content in a .result-screen root (the class the fog-mask lift matches)', () => {
    const wrapper = mount(ResultScreen, {
      props: { title: 'Check-in sent', text: 'Your state has been recorded.' },
      slots: { actions: '<button type="button">Home</button>' },
    })

    expect(wrapper.element.classList.contains('result-screen')).toBe(true)
    expect(wrapper.element.querySelector('.result-screen__title')?.textContent).toBe(
      'Check-in sent',
    )
    expect(wrapper.element.querySelector('button')?.textContent).toBe('Home')
  })
})
