import { describe, expect, it } from 'vitest'
import { pagerItems } from '@/utils/console/pagerItems'

describe('pagerItems', () => {
  it.each([
    { page: 1, count: 1, expected: [1] },
    { page: 3, count: 7, expected: [1, 2, 3, 4, 5, 6, 7] },
    // Long run: first and last page, the current one with its neighbours, a gap between.
    { page: 1, count: 8, expected: [1, 2, null, 8] },
    { page: 5, count: 12, expected: [1, null, 4, 5, 6, null, 12] },
    { page: 12, count: 12, expected: [1, null, 11, 12] },
    // A gap that would hide one page shows the page instead.
    { page: 4, count: 9, expected: [1, 2, 3, 4, 5, null, 9] },
  ])('page $page of $count -> $expected', ({ page, count, expected }) => {
    expect(pagerItems(page, count)).toEqual(expected)
  })
})
