import { describe, expect, it } from 'vitest'
import { nearestFirstWindow } from '@/utils/console/nearestFirst'

describe('nearestFirstWindow', () => {
  // 45 rows, 20 per page: the newest-first list holds the last page of the
  // nearest-first view at its start.
  it.each([
    { page: 1, expected: { offset: 25, limit: 20 } },
    { page: 2, expected: { offset: 5, limit: 20 } },
    { page: 3, expected: { offset: 0, limit: 5 } },
  ])('page $page of 45 rows -> $expected', ({ page, expected }) => {
    expect(nearestFirstWindow(45, page, 20)).toEqual(expected)
  })

  it('a list that fits one page is one slice', () => {
    expect(nearestFirstWindow(7, 1, 20)).toEqual({ offset: 0, limit: 7 })
  })

  it('a page past the end, or an empty list, has no slice', () => {
    expect(nearestFirstWindow(45, 4, 20)).toBeNull()
    expect(nearestFirstWindow(0, 1, 20)).toBeNull()
  })
})
