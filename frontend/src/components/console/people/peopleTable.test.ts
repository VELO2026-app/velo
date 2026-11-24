import { describe, expect, it } from 'vitest'
import { masterStatusTone, pagerItems, roleTone } from '@/components/console/people/peopleTable'

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

describe('pill tones', () => {
  it.each([
    ['verified', 'success'],
    ['pending', 'warning'],
    ['rejected', 'danger'],
    ['suspended', 'danger'],
    ['cancelled_by_user', 'neutral'],
  ])('master status %s -> %s', (status, tone) => {
    expect(masterStatusTone(status)).toBe(tone)
  })

  it.each([
    ['admin', 'warning'],
    ['master', 'success'],
    ['user', 'neutral'],
  ])('role %s -> %s', (role, tone) => {
    expect(roleTone(role)).toBe(tone)
  })
})
