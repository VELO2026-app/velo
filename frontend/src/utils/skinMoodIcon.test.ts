// =============================================================================
// skinMoodIcon -- a skin's mood icon drawn from its tree (FE-273)
// =============================================================================
// The package's icon is drawn inline (not an <img>: an image would not inherit
// currentColor). Pinned here: the icon takes the requested size, its lines
// take the app's ink through currentColor, its art may run out of the box, and
// two icons on one screen never share a gradient.
// =============================================================================

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

import { parseMoodSvg, type MoodSvgNode } from '../../scripts/lib/skin-package.mjs'
import { moodSvg } from '@/platform/skin.test.fixture'
import { createSkinMoodIcon } from '@/utils/skinMoodIcon'

/** The tree of a fixture icon (the engine's own reading of the file). */
function tree(svg = moodSvg()): MoodSvgNode {
  const parsed = parseMoodSvg(svg)
  if (!('tree' in parsed)) throw new Error(parsed.error)
  return parsed.tree
}

describe('createSkinMoodIcon', () => {
  it('draws the tree at the requested size, from the nominal box of the file', () => {
    const svg = mount(createSkinMoodIcon(tree()), { props: { size: 64 } }).find('svg')
    expect(svg.attributes('width')).toBe('64')
    expect(svg.attributes('height')).toBe('64')
    expect(svg.attributes('viewBox')).toBe('4 4 32 32')
    expect(svg.find('path').attributes('d')).toBe('M12 14h4v6h-4z')
  })

  it('takes its lines from the ink token: currentColor in the file, the token on the root', () => {
    const svg = mount(createSkinMoodIcon(tree()), { props: { size: 40 } }).find('svg')
    expect(svg.find('path').attributes('fill')).toBe('currentColor')
    expect(svg.attributes('style')).toContain('color: var(--velo-primary-dark)')
  })

  it('lets the art run out of the box, so a card laid out for `size` keeps its box', () => {
    const svg = mount(createSkinMoodIcon(tree()), { props: { size: 36 } }).find('svg')
    expect(svg.attributes('style')).toContain('overflow: visible')
    expect(svg.attributes('style')).not.toContain('clip-path')
  })

  it.each([14, 16, 22])(
    'holds the art to a disc of its box at %s px: beside text it must not run into the words',
    (size) => {
      const style = mount(createSkinMoodIcon(tree()), { props: { size } })
        .find('svg')
        .attributes('style')
      expect(style).toContain('overflow: hidden')
      expect(style).toContain('clip-path: circle(50%)')
      expect(style).toContain('color: var(--velo-primary-dark)')
      expect(style).not.toContain('overflow: visible')
    },
  )

  it('a size given as text is read as a number: "16" is small, "40" is not', () => {
    const styleAt = (size: string): string | undefined =>
      mount(createSkinMoodIcon(tree()), { props: { size } }).find('svg').attributes('style')
    expect(styleAt('16')).toContain('clip-path')
    expect(styleAt('40')).toContain('overflow: visible')
  })

  it('passes the class of the place on to the svg, as the core faces do', () => {
    const wrapper = mount(createSkinMoodIcon(tree()), { attrs: { class: 'mood-slider__face' } })
    expect(wrapper.find('svg').classes()).toContain('mood-slider__face')
  })

  it('two instances of one icon on a screen never share a gradient id', () => {
    const Icon = createSkinMoodIcon(tree())
    // One app, two instances: the ids come from the app's own counter.
    const Screen = defineComponent({ render: () => h('div', [h(Icon), h(Icon)]) })
    const svgs = mount(Screen).findAll('svg')
    const ids = svgs.map((svg) => {
      const id = svg.find('radialGradient').attributes('id') ?? ''
      // The circle paints with the gradient of ITS OWN instance.
      expect(svg.find('circle').attributes('fill')).toBe(`url(#${id})`)
      return id
    })
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
    expect(ids[0]).toMatch(/^glow-/)
  })
})
