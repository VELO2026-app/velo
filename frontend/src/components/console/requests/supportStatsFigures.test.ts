import { describe, expect, it } from 'vitest'
import {
  categoryShare,
  ratingTotals,
  signedDelta,
} from '@/components/console/requests/supportStatsFigures'

describe('ratingTotals', () => {
  it('weights the average and the 4-5 share by the tickets each category rated', () => {
    const totals = ratingTotals([
      { rated: 3, average: 5, share_4_5: 1 },
      { rated: 1, average: 1, share_4_5: 0 },
      { rated: 0, average: null, share_4_5: null },
    ])

    expect(totals.rated).toBe(4)
    expect(totals.average).toBeCloseTo(4, 5)
    expect(totals.share).toBeCloseTo(0.75, 5)
  })

  it('has no average and no share (not zero) when nothing was rated', () => {
    expect(ratingTotals([{ rated: 0, average: null, share_4_5: null }])).toEqual({
      rated: 0,
      average: null,
      share: null,
    })
  })
})

describe('categoryShare', () => {
  it('rounds a category to whole percent of all tickets', () => {
    expect(categoryShare({ tickets: 1 }, 3)).toBe(33)
  })

  it('is null, not 0, for a period without tickets', () => {
    expect(categoryShare({ tickets: 0 }, 0)).toBeNull()
  })
})

describe('signedDelta', () => {
  it.each([
    [96, 84, '+12'],
    [84, 84, '0'],
    [70, 84, '-14'],
  ])('%i against %i reads %s', (current, previous, expected) => {
    expect(signedDelta(current, previous)).toBe(expected)
  })
})
