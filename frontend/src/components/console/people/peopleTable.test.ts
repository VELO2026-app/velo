import { describe, expect, it } from 'vitest'
import {
  DASH,
  countText,
  masterStatusLabel,
  pagerItems,
  payoutText,
  tabOptions,
} from '@/components/console/people/peopleTable'

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

describe('countText and payoutText', () => {
  it('show the number, and a dash when the server has none', () => {
    expect(countText(0)).toBe('0')
    expect(countText(12)).toBe('12')
    expect(countText(null)).toBe(DASH)
    expect(countText(undefined)).toBe(DASH)
    expect(payoutText(2500)).toContain('25')
    expect(payoutText(null)).toBe(DASH)
  })
})

describe('tabOptions', () => {
  it('puts the total after the name of the tab once it is known', () => {
    const options = tabOptions(
      ['all', 'pending'] as const,
      (tab) => tab.toUpperCase(),
      (tab) => (tab === 'all' ? 38 : undefined),
    )

    expect(options).toEqual([
      { value: 'all', label: 'ALL · 38' },
      { value: 'pending', label: 'PENDING' },
    ])
  })
})

describe('masterStatusLabel', () => {
  it.each([
    ['pending', 'Ожидает верификации'],
    ['verified', 'Верифицирован'],
    ['rejected', 'Отклонён'],
    ['suspended', 'Отозван'],
    ['cancelled_by_user', 'Аккаунт удалён'],
  ])('words %s as %s, the same on every screen', (status, label) => {
    expect(masterStatusLabel(status)).toBe(label)
  })

  it('shows a status the console does not know as the server sent it', () => {
    expect(masterStatusLabel('on_hold')).toBe('on_hold')
  })
})
