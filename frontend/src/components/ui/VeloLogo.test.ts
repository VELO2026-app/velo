// =============================================================================
// VeloLogo -- the logo set or the brand icon (FE-230)
// =============================================================================
// A skin package may leave the logo set out (contract 2.1); the build then
// reports SKIN_HAS_LOGO = false and the logo places show the brand's app icon.
// =============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const brand = vi.hoisted(() => ({ hasLogo: true, supportMark: 'logo' as 'logo' | 'icon' }))
vi.mock('virtual:skin-brand', () => ({
  SKIN_BRAND: null,
  get SKIN_HAS_LOGO() {
    return brand.hasLogo
  },
  get SKIN_SUPPORT_MARK() {
    return brand.supportMark
  },
}))

import VeloLogo from './VeloLogo.vue'

afterEach(() => {
  brand.hasLogo = true
  brand.supportMark = 'logo'
})

const sources = (props: Record<string, unknown>): string[] =>
  mount(VeloLogo, { props })
    .findAll('img')
    .map((img) => img.attributes('src') ?? '')

describe('VeloLogo', () => {
  it('draws the logo set when the build has one', () => {
    expect(sources({ size: 40 })).toEqual(['/icons/mandala-blue.png', '/icons/velo-word-blue.svg'])
  })

  // FE-261: the support conversation's mark follows the skin's `supportMark`
  // setting. 'logo' (the golden skin) keeps the logo set; 'icon' (Goodo, whose
  // logo set is a recoloured VELO one) draws the brand icon instead.
  it("supportMark keeps the logo set while the skin's setting is 'logo'", () => {
    expect(sources({ size: 40, supportMark: true })).toEqual([
      '/icons/mandala-blue.png',
      '/icons/velo-word-blue.svg',
    ])
  })

  it("supportMark draws the brand icon when the skin's setting is 'icon'", () => {
    brand.supportMark = 'icon'
    expect(sources({ size: 40, supportMark: true })).toEqual(['/icons/favicon.svg'])
  })

  it('the setting never touches a logo that is not the support mark (splash, Welcome, auth)', () => {
    brand.supportMark = 'icon'
    expect(sources({ size: 40 })).toEqual(['/icons/mandala-blue.png', '/icons/velo-word-blue.svg'])
    expect(sources({ size: 440, variant: 'white', spin: true })).toEqual([
      '/icons/mandala-white.png',
      '/icons/velo-word-filled.svg',
    ])
  })

  it('without a logo set shows the brand icon: the whole box, a third of the splash', () => {
    brand.hasLogo = false
    const small = mount(VeloLogo, { props: { size: 40 } }).get('img')
    expect(small.attributes('src')).toBe('/icons/favicon.svg')
    expect(small.attributes('width')).toBe('40')
    const splash = mount(VeloLogo, { props: { size: 440, variant: 'white', spin: true } })
    expect(splash.findAll('img')).toHaveLength(1)
    expect(splash.get('img').attributes('width')).toBe('147')
  })
})
