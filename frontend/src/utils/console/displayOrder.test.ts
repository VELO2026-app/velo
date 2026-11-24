import { describe, expect, it } from 'vitest'
import { isWholeNumber, nextDisplayOrder } from '@/utils/console/displayOrder'

describe('isWholeNumber', () => {
  it('takes whole numbers, negative and padded ones too', () => {
    expect(isWholeNumber('7')).toBe(true)
    expect(isWholeNumber(' -2 ')).toBe(true)
  })

  it('refuses blank text, fractions and words', () => {
    expect(isWholeNumber('')).toBe(false)
    expect(isWholeNumber('   ')).toBe(false)
    expect(isWholeNumber('1.5')).toBe(false)
    expect(isWholeNumber('abc')).toBe(false)
  })
})

describe('nextDisplayOrder', () => {
  it('is one past the largest order, whatever the list order', () => {
    expect(nextDisplayOrder([3, 9, 1])).toBe(10)
  })

  it('starts at 1 for an empty list and keeps a list of negatives above zero', () => {
    expect(nextDisplayOrder([])).toBe(1)
    expect(nextDisplayOrder([-4, -2])).toBe(1)
  })
})
