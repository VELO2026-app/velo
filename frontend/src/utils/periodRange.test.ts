// =============================================================================
// VELO Frontend -- periodRange.ts Unit Tests
// =============================================================================
//
// SW17 (Батч 3, ПРОМТ №580): formatPeriodRange did all its week/month math via
// device-LOCAL Date getters/setters (getDay/setDate/getFullYear/getMonth) and
// formatted via toLocaleDateString with NO explicit timeZone -- the same class
// of bug already fixed for adminHelpers.ts (SW10). Two admins (or the same
// admin on two devices) navigating the SAME week/month stepper offset could
// see DIFFERENT period labels, and could even land on a different absolute
// week/month than each other near a day/month boundary. Fixed to pin UTC
// explicitly, matching the rest of the codebase's date functions.
// =============================================================================

import { describe, it, expect, vi, afterEach } from 'vitest'
import { formatPeriodRange } from '@/utils/periodRange'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('formatPeriodRange', () => {
  it('week: renders a "D MMM - D MMM" range for offset 0', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-16T12:00:00Z')) // Tuesday
    const result = formatPeriodRange('week', 0)
    expect(result).toBe('15 июн - 21 июн')
  })

  it('week: offset -1 shifts back a full week', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-16T12:00:00Z'))
    const result = formatPeriodRange('week', -1)
    expect(result).toBe('8 июн - 14 июн')
  })

  it('month: renders "month YYYY г." (ru-RU long format) for offset 0', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-16T12:00:00Z'))
    expect(formatPeriodRange('month', 0)).toBe('июнь 2026 г.')
  })

  it('month: offset -1 shifts back a full month, across a year boundary too', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'))
    expect(formatPeriodRange('month', -1)).toBe('декабрь 2025 г.')
  })

  // SW17: system time is 23:30 UTC on a Tuesday -- Kiritimati (UTC+14) is
  // already Wednesday local, Etc/GMT+12 (UTC-12) is still Tuesday local, a
  // 26h spread guaranteeing different LOCAL weekdays/calendar days for the
  // same instant (same technique as adminHelpers.test.ts's SW10 tests).
  it('SW17: week label is unaffected by the DEVICE\'s own timezone', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-16T23:30:00Z'))

    vi.stubEnv('TZ', 'Pacific/Kiritimati') // UTC+14
    const resultA = formatPeriodRange('week', 0)
    vi.stubEnv('TZ', 'Etc/GMT+12') // UTC-12
    const resultB = formatPeriodRange('week', 0)

    expect(resultA).toBe(resultB)
  })

  // SW17: system time is 23:30 UTC on the last day of June -- Kiritimati
  // (UTC+14) is already July 1 local; Etc/GMT+12 (UTC-12) is still June 30
  // local. Before the fix these landed in DIFFERENT months entirely.
  it('SW17: month label is unaffected by the DEVICE\'s own timezone, even across a month boundary', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-30T23:30:00Z'))

    vi.stubEnv('TZ', 'Pacific/Kiritimati') // UTC+14
    const resultA = formatPeriodRange('month', 0)
    vi.stubEnv('TZ', 'Etc/GMT+12') // UTC-12
    const resultB = formatPeriodRange('month', 0)

    expect(resultA).toBe(resultB)
    expect(resultA).toBe('июнь 2026 г.')
  })
})
