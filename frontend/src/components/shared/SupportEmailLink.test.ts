// =============================================================================
// SupportEmailLink -- the brand's support address or nothing (FE-251)
// =============================================================================
// The address comes from the skin package (SKIN_SUPPORT_EMAIL). The core
// build and a package without supportEmail have none: the line is not shown.
// =============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const brand = vi.hoisted(() => ({ email: null as string | null }))
vi.mock('virtual:skin-brand', () => ({
  SKIN_BRAND: 'Fixture',
  SKIN_HAS_LOGO: true,
  get SKIN_SUPPORT_EMAIL() {
    return brand.email
  },
}))

import SupportEmailLink from './SupportEmailLink.vue'

afterEach(() => {
  brand.email = null
})

const render = () => mount(SupportEmailLink)

describe('SupportEmailLink', () => {
  it("links to the brand's address and names it in the text", () => {
    brand.email = 'help@fixture.example'
    const link = render().get('a')
    expect(link.attributes('href')).toBe('mailto:help@fixture.example')
    expect(link.text()).toBe('Не дождались ответа? Напишите на help@fixture.example')
  })

  it('without an address shows nothing', () => {
    expect(render().find('a').exists()).toBe(false)
  })
})
