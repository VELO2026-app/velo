// =============================================================================
// VELO Frontend -- ratingIcons.ts Unit Tests
// =============================================================================
//
// Pins the shared MOOD_SCALE_ICON / RATING_ICON maps by component identity, so
// a future edit at any consuming site cannot silently drift the mapping
// without a test noticing. RATING_ICON stays the PRE-BUCKETED analytics map
// (FeedbackRating) -- it is deliberately not widened to five (tz-mood-scale §5).
// =============================================================================

import { describe, it, expect } from 'vitest'
import { MOOD_SCALE_ICON, RATING_ICON } from '@/utils/ratingIcons'
import {
  IconMoodScaleBad,
  IconMoodScaleLow,
  IconMoodScaleNeutral,
  IconMoodScaleGood,
  IconMoodScaleFire,
  IconRatingFire,
  IconRatingGood,
  IconRatingConfused,
} from '@/components/icons'

describe('MOOD_SCALE_ICON', () => {
  it('binds each of the five approved faces to its scale key, in scale order', () => {
    expect(MOOD_SCALE_ICON.bad).toBe(IconMoodScaleBad)
    expect(MOOD_SCALE_ICON.low).toBe(IconMoodScaleLow)
    expect(MOOD_SCALE_ICON.neutral).toBe(IconMoodScaleNeutral)
    expect(MOOD_SCALE_ICON.good).toBe(IconMoodScaleGood)
    expect(MOOD_SCALE_ICON.fire).toBe(IconMoodScaleFire)
  })

  it('has exactly the five scale keys -- no extra, no missing', () => {
    expect(Object.keys(MOOD_SCALE_ICON).sort()).toEqual(['bad', 'fire', 'good', 'low', 'neutral'])
  })
})

describe('RATING_ICON (pre-bucketed analytics surfaces)', () => {
  it('maps each bucket to its own icon component', () => {
    expect(RATING_ICON.fire).toBe(IconRatingFire)
    expect(RATING_ICON.good).toBe(IconRatingGood)
    expect(RATING_ICON.confused).toBe(IconRatingConfused)
  })

  it('has exactly the three buckets -- no extra, no missing', () => {
    expect(Object.keys(RATING_ICON).sort()).toEqual(['confused', 'fire', 'good'])
  })
})
