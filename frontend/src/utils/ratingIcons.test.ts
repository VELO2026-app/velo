// =============================================================================
// VELO Frontend -- ratingIcons.ts Unit Tests
// =============================================================================
//
// B6 (Батч 3, ПРОМТ №580): pins the shared MOOD_ICON/RATING_ICON maps this
// module now centralizes, so a future edit at any of the (formerly 9)
// consuming sites can't silently drift the mapping without a test noticing.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { MOOD_ICON, RATING_ICON } from '@/utils/ratingIcons'
import {
  IconMoodLow,
  IconMoodMid,
  IconMoodHigh,
  IconRatingFire,
  IconRatingGood,
  IconRatingConfused,
} from '@/components/icons'

describe('MOOD_ICON', () => {
  it('maps each zone to its own icon component', () => {
    expect(MOOD_ICON.low).toBe(IconMoodLow)
    expect(MOOD_ICON.mid).toBe(IconMoodMid)
    expect(MOOD_ICON.high).toBe(IconMoodHigh)
  })

  it('has exactly the three zones -- no extra, no missing', () => {
    expect(Object.keys(MOOD_ICON).sort()).toEqual(['high', 'low', 'mid'])
  })
})

describe('RATING_ICON', () => {
  it('maps each zone to its own icon component', () => {
    expect(RATING_ICON.fire).toBe(IconRatingFire)
    expect(RATING_ICON.good).toBe(IconRatingGood)
    expect(RATING_ICON.confused).toBe(IconRatingConfused)
  })

  it('has exactly the three zones -- no extra, no missing', () => {
    expect(Object.keys(RATING_ICON).sort()).toEqual(['confused', 'fire', 'good'])
  })
})
