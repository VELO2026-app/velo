// =============================================================================
// VELO Frontend -- ratingIcons.ts Unit Tests
// =============================================================================
//
// Pins the shared MOOD_SCALE_ICON map by component identity, so a future edit
// at any consuming site cannot silently drift the mapping without a test
// noticing.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { parseMoodSvg, type MoodIconSet } from '../../scripts/lib/skin-package.mjs'
import { moodSvg } from '@/platform/skin.test.fixture'
import { MOOD_SCALE_ICON, moodScaleIcons } from '@/utils/ratingIcons'
import {
  IconMoodScaleBad,
  IconMoodScaleLow,
  IconMoodScaleNeutral,
  IconMoodScaleGood,
  IconMoodScaleFire,
} from '@/components/icons'

describe('MOOD_SCALE_ICON', () => {
  it('binds each of the five approved faces to its scale key, in scale order', () => {
    expect(MOOD_SCALE_ICON.bad).toBe(IconMoodScaleBad)
    expect(MOOD_SCALE_ICON.low).toBe(IconMoodScaleLow)
    expect(MOOD_SCALE_ICON.neutral).toBe(IconMoodScaleNeutral)
    expect(MOOD_SCALE_ICON.good).toBe(IconMoodScaleGood)
    expect(MOOD_SCALE_ICON.fire).toBe(IconMoodScaleFire)
  })
})

describe('moodScaleIcons (the skin mood icon set, contract 2.3)', () => {
  /** A set whose icons differ by their path, so a key mixed up with another shows. */
  const set = Object.fromEntries(
    (['bad', 'low', 'neutral', 'good', 'fire'] as const).map((key, i) => {
      const parsed = parseMoodSvg(moodSvg(`<path d="M${i} ${i}h1v1h-1z" fill="currentColor"/>`))
      if (!('tree' in parsed)) throw new Error(parsed.error)
      return [key, parsed.tree]
    }),
  ) as MoodIconSet

  it('without a set the core faces draw -- the map of the core build', () => {
    expect(moodScaleIcons(null)).toBe(MOOD_SCALE_ICON)
  })

  it("with a set every key draws the skin's icon of that key, not a core face", () => {
    const icons = moodScaleIcons(set)
    const drawn = (['bad', 'low', 'neutral', 'good', 'fire'] as const).map((key) =>
      mount(icons[key]).find('path').attributes('d'),
    )
    expect(drawn).toEqual([
      'M0 0h1v1h-1z',
      'M1 1h1v1h-1z',
      'M2 2h1v1h-1z',
      'M3 3h1v1h-1z',
      'M4 4h1v1h-1z',
    ])
    expect(icons.bad).not.toBe(MOOD_SCALE_ICON.bad)
  })
})
