// =============================================================================
// VELO Frontend -- adminHelpers.ts Unit Tests
// =============================================================================
//
// First unit tests for this file. formatDateTime/formatRelative (SW10) were
// the sole date functions in the codebase that rendered via toLocaleString /
// local Date getters with NO explicit `timeZone` -- every other date function
// in utils/format.ts always threads an explicit IANA zone. That means their
// output (and, for formatRelative's "Вчера" comparison, their CORRECTNESS)
// depended on whichever machine renders the page. Fixed to pin UTC explicitly,
// matching the rest of the codebase.
// =============================================================================

import { describe, it, expect, vi, afterEach } from 'vitest'
import { formatDateTime, formatRelative } from '@/utils/adminHelpers'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('formatDateTime', () => {
  it('renders day/month/year/time', () => {
    const result = formatDateTime('2026-06-15T14:35:00Z')
    expect(result).toContain('2026')
    expect(result).toContain('15')
  })

  // SW10: no explicit timeZone meant this rendered in whichever machine's OS
  // timezone happened to run the code -- two admins (or the same admin on two
  // devices) could see different absolute times for the identical event.
  it('SW10: is unaffected by the DEVICE\'s own timezone', () => {
    const iso = '2026-06-15T23:30:00Z'
    vi.stubEnv('TZ', 'Pacific/Kiritimati') // UTC+14
    const resultA = formatDateTime(iso)
    vi.stubEnv('TZ', 'Etc/GMT+12') // UTC-12 -- a 26h spread from Kiritimati
    const resultB = formatDateTime(iso)

    expect(resultA).toBe(resultB)
  })
})

describe('formatRelative', () => {
  it('"только что" for under a minute', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-16T12:00:30Z'))
    expect(formatRelative('2026-06-16T12:00:00Z')).toBe('только что')
  })

  it('"N мин назад" for under an hour', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-16T12:05:00Z'))
    expect(formatRelative('2026-06-16T12:00:00Z')).toBe('5 мин назад')
  })

  it('"N ч назад" for under a day', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-16T15:00:00Z'))
    expect(formatRelative('2026-06-16T12:00:00Z')).toBe('3 ч назад')
  })

  it('"Вчера" for yesterday (UTC calendar day)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-16T12:00:00Z'))
    expect(formatRelative('2026-06-15T09:00:00Z')).toBe('Вчера')
  })

  it('an absolute date for older items', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-16T12:00:00Z'))
    const result = formatRelative('2026-06-10T09:00:00Z')
    expect(result).not.toBe('Вчера')
    expect(result).toContain('10')
  })

  // SW10: the "Вчера" check compared device-LOCAL calendar fields on both the
  // item and a device-mutated "yesterday" Date -- not the item's actual
  // distance from "now". Fixture: 30h before "now" (two UTC calendar days
  // back, correctly NOT "yesterday"), but a large positive device-tz offset
  // (Kiritimati, UTC+14) pushed both instants' LOCAL calendar days forward
  // enough to collapse the distinction and misreport it as "Вчера".
  it('SW10: "Вчера" is unaffected by the DEVICE\'s own timezone', () => {
    vi.useFakeTimers()
    vi.stubEnv('TZ', 'Pacific/Kiritimati')
    vi.setSystemTime(new Date('2026-06-16T05:00:00Z'))

    const result = formatRelative('2026-06-14T23:00:00.000Z')

    expect(result).not.toBe('Вчера')
  })

  // Companion to the above: the absolute-date fallback itself must also
  // render in a fixed zone, not the device's own. iso is 5+ days before "now"
  // (safely past "yesterday" under any timezone) so both stubbed devices
  // reach the SAME branch (the date fallback) -- the divergence being tested
  // is only in how that date is formatted, not which branch is taken.
  it('SW10: the absolute-date fallback is unaffected by the DEVICE\'s own timezone', () => {
    const iso = '2026-06-10T23:30:00.000Z'
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-16T05:00:00Z'))

    vi.stubEnv('TZ', 'Pacific/Kiritimati') // UTC+14
    const resultA = formatRelative(iso)
    vi.stubEnv('TZ', 'Etc/GMT+12') // UTC-12
    const resultB = formatRelative(iso)

    expect(resultA).toBe(resultB)
  })
})
