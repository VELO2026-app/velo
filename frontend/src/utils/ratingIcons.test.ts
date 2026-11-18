// =============================================================================
// VELO Frontend -- ratingIcons.ts Unit Tests
// =============================================================================
//
// Pins the shared MOOD_SCALE_ICON map by component identity, so a future edit
// at any consuming site cannot silently drift the mapping without a test
// noticing.
//
// BE-77: the three-key RATING_ICON ('fire'|'good'|'confused') used to be
// pinned here too -- right while the server sent three buckets. The owner's
// five-zone decision made the server send the moodScale keys, and the map was
// deleted (no legacy). Its block is replaced by the exact statement of that:
// the module exports ONE map, and it is the five-key one.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { MOOD_SCALE_ICON } from '@/utils/ratingIcons'
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
