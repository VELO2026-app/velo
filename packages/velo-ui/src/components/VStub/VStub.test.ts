// =============================================================================
// @velo/ui -- VStub test (P1 pipeline specimen, FE-116)
// =============================================================================
// happy-dom law (tz-whitelabel §3): tokens ride var(), which happy-dom does
// not resolve -- DOM shape only, never computed styles.

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import VStub from './VStub.vue'

describe('VStub', () => {
  it('renders its slot content', () => {
    const wrapper = mount(VStub, { slots: { default: () => 'pipeline ok' } })
    expect(wrapper.text()).toBe('pipeline ok')
  })

  it('carries the data-velo-* machine layer on the root (§7.2 convention)', () => {
    const wrapper = mount(VStub, { slots: { default: () => 'x' } })
    expect(wrapper.attributes('data-velo-stub')).toBeDefined()
  })
})
