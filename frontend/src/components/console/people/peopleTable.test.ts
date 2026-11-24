import { describe, expect, it } from 'vitest'
import { pagerItems } from '@/components/console/people/peopleTable'

describe('pagerItems', () => {
  it.each([
    [1, 8, [1, 2, 'gap', 8]],
    [4, 8, [1, 2, 3, 4, 5, 'gap', 8]],
    [8, 8, [1, 'gap', 7, 8]],
    [3, 5, [1, 2, 3, 4, 5]],
    [2, 2, [1, 2]],
  ])('page %i of %i -> %j', (page, pages, expected) => {
    expect(pagerItems(page, pages)).toEqual(expected)
  })

  it('has no pager for fewer than two pages', () => {
    expect(pagerItems(1, 1)).toEqual([])
    expect(pagerItems(1, 0)).toEqual([])
  })
})
