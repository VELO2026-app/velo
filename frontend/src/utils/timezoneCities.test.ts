import { describe, expect, it, vi } from 'vitest'

// Locale is switched per test via the mocked getLocale.
let locale = 'uk'
vi.mock('@/locales', () => ({ getLocale: () => locale }))

import { timezoneRows } from './timezoneCities'

const cityOf = (rows: ReturnType<typeof timezoneRows>, iana: string) =>
  rows.find((r) => r.iana === iana)?.city

describe('timezoneRows -- city names follow the interface locale', () => {
  it('uk shows Ukrainian city names', () => {
    locale = 'uk'
    const rows = timezoneRows(null, '')
    expect(cityOf(rows, 'Europe/Kyiv')).toBe('Київ')
    expect(cityOf(rows, 'Asia/Tokyo')).toBe('Токіо')
  })

  it('ru and en keep their own names', () => {
    locale = 'ru'
    expect(cityOf(timezoneRows(null, ''), 'Asia/Tokyo')).toBe('Токио')
    locale = 'en'
    expect(cityOf(timezoneRows(null, ''), 'Asia/Tokyo')).toBe('Tokyo')
  })

  it('a locale without a seed falls back to en, not ru', () => {
    locale = 'de'
    expect(cityOf(timezoneRows(null, ''), 'Asia/Tokyo')).toBe('Tokyo')
  })
})
