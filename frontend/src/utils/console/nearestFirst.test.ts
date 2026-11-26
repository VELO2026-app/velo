import { describe, expect, it } from 'vitest'
import { nearestFirst, nearestFirstWindow, runsAscending } from '@/utils/console/nearestFirst'

describe('nearestFirstWindow', () => {
  // 45 rows, 20 per page: a newest-first list holds the last page of the
  // nearest-first view at its start.
  it.each([
    { page: 1, expected: { offset: 25, limit: 20 } },
    { page: 2, expected: { offset: 5, limit: 20 } },
    { page: 3, expected: { offset: 0, limit: 5 } },
  ])('newest first: page $page of 45 rows -> $expected', ({ page, expected }) => {
    expect(nearestFirstWindow(45, page, 20)).toEqual(expected)
  })

  // An ascending list (BE-257) is already nearest first: pages from the start.
  it.each([
    { page: 1, expected: { offset: 0, limit: 20 } },
    { page: 2, expected: { offset: 20, limit: 20 } },
    { page: 3, expected: { offset: 40, limit: 5 } },
  ])('ascending: page $page of 45 rows -> $expected', ({ page, expected }) => {
    expect(nearestFirstWindow(45, page, 20, true)).toEqual(expected)
  })

  it('a list that fits one page is one slice, either way', () => {
    expect(nearestFirstWindow(7, 1, 20)).toEqual({ offset: 0, limit: 7 })
    expect(nearestFirstWindow(7, 1, 20, true)).toEqual({ offset: 0, limit: 7 })
  })

  it('a page past the end, or an empty list, has no slice', () => {
    expect(nearestFirstWindow(45, 4, 20)).toBeNull()
    expect(nearestFirstWindow(0, 1, 20)).toBeNull()
    expect(nearestFirstWindow(45, 4, 20, true)).toBeNull()
  })
})

describe('runsAscending', () => {
  it('reads the order from the first and the last row', () => {
    expect(runsAscending('2026-12-20T07:00:00Z', '2026-12-28T07:00:00Z')).toBe(true)
    expect(runsAscending('2026-12-28T07:00:00Z', '2026-12-20T07:00:00Z')).toBe(false)
  })

  it('one moment, one row or none count as ascending: both ways give the same page', () => {
    expect(runsAscending('2026-12-20T07:00:00Z', '2026-12-20T07:00:00Z')).toBe(true)
    expect(runsAscending(undefined, undefined)).toBe(true)
  })
})

describe('nearestFirst', () => {
  it('sorts by date, nearest first, keeping rows at one moment in their order', () => {
    const rows = [
      { id: 'c', scheduled_at: '2026-12-22T07:00:00Z' },
      { id: 'a1', scheduled_at: '2026-12-20T07:00:00Z' },
      { id: 'b', scheduled_at: '2026-12-21T07:00:00Z' },
      { id: 'a2', scheduled_at: '2026-12-20T07:00:00Z' },
    ]

    expect(nearestFirst(rows).map((r) => r.id)).toEqual(['a1', 'a2', 'b', 'c'])
    expect(rows[0]?.id).toBe('c')
  })
})
