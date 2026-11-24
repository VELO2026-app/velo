// =============================================================================
// MoodAvatar -- the mood face of a participant (FE-85), skin icons (FE-273)
// =============================================================================
// Every mood place reads its icon from utils/ratingIcons.ts. One consumer is
// enough to pin the wiring end to end: with a skin that ships the mood icon
// set (virtual:skin-mood) the avatar draws the skin's icon of the score's
// emotion, never the core face.
// =============================================================================

import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('virtual:skin-mood', async () => {
  const { parseMoodSvg } = await import('../../../scripts/lib/skin-package.mjs')
  const { moodSvg } = await import('@/platform/skin.test.fixture')
  const icon = (d: string) => {
    const parsed = parseMoodSvg(moodSvg(`<path d="${d}" fill="currentColor"/>`))
    if (!('tree' in parsed)) throw new Error(parsed.error)
    return parsed.tree
  }
  return {
    SKIN_MOOD_ICONS: {
      bad: icon('M1 1h1v1h-1z'),
      low: icon('M2 2h1v1h-1z'),
      neutral: icon('M3 3h1v1h-1z'),
      good: icon('M4 4h1v1h-1z'),
      fire: icon('M5 5h1v1h-1z'),
    },
  }
})

import MoodAvatar from './MoodAvatar.vue'

const pathOf = (mood: number): string | undefined =>
  mount(MoodAvatar, { props: { mood, size: 46 } })
    .find('path')
    .attributes('d')

describe('MoodAvatar with a skin that ships the mood icon set', () => {
  it("draws the skin's icon of the score's emotion (1-2 bad ... 9-10 fire)", () => {
    expect([1, 2, 3, 5, 7, 10].map(pathOf)).toEqual([
      'M1 1h1v1h-1z',
      'M1 1h1v1h-1z',
      'M2 2h1v1h-1z',
      'M3 3h1v1h-1z',
      'M4 4h1v1h-1z',
      'M5 5h1v1h-1z',
    ])
  })

  it('keeps the requested size', () => {
    const svg = mount(MoodAvatar, { props: { mood: 5, size: 46 } }).find('svg')
    expect(svg.attributes('width')).toBe('46')
  })
})
