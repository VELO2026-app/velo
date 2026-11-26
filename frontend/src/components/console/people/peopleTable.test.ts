import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '@/locales'
import {
  DASH,
  countText,
  methodChips,
  masterStatusLabel,
  masterStatusTone,
  payoutText,
  roleTone,
  tabOptions,
} from '@/components/console/people/peopleTable'

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

describe('masterStatusTone and roleTone', () => {
  it.each([
    ['verified', 'success'],
    ['pending', 'warning'],
    ['rejected', 'error'],
    ['suspended', 'error'],
    ['something-new', 'muted'],
  ])('master status %s reads as %s', (status, tone) => {
    expect(masterStatusTone(status)).toBe(tone)
  })

  it.each([
    ['admin', 'warning'],
    ['master', 'success'],
    ['user', 'muted'],
  ])('role %s reads as %s', (role, tone) => {
    expect(roleTone(role)).toBe(tone)
  })
})

describe('methodChips', () => {
  afterEach(async () => {
    await setLocale('ru')
  })

  it('reads a bare direction the seed names in the live locale, with no catalog', async () => {
    await setLocale('uk')

    expect(methodChips({ methods: ['Терапия'] })).toEqual([{ label: 'Терапія', muted: false }])
    expect(methodChips({ methods: ['Йога — Хатха-йога', 'Терапия'] })).toEqual([
      { label: 'Йога', muted: false },
      { label: 'Хатха-йога', muted: true },
      { label: 'Терапія', muted: false },
    ])
    // The master's own text is not touched.
    expect(methodChips({ methods: ['Мой уникальный метод'] })).toEqual([
      { label: 'Мой уникальный метод', muted: false },
    ])
  })
})
