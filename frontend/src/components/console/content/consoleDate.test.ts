import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatCount, formatWhen } from '@/components/console/content/consoleDate'

// Frozen clock: "today" is 24 Nov 2026, 12:00 UTC.
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-24T12:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('formatWhen', () => {
  it('keeps the relative day word for today', () => {
    expect(formatWhen('2026-11-24T15:30:00Z', 'UTC')).toBe('Сегодня, 15:30')
  })

  it('shows day and month, no year, inside the current year', () => {
    expect(formatWhen('2026-03-05T09:00:00Z', 'UTC')).toBe('5 марта, 09:00')
  })

  it('adds the year to a date outside the current year', () => {
    expect(formatWhen('2025-03-05T09:00:00Z', 'UTC')).toBe('5 марта 2025 г., 09:00')
  })

  it('reads the day and the time in the given time zone', () => {
    // 22:30 UTC on 4 Mar is already 5 Mar, 01:30 in Moscow (UTC+3).
    expect(formatWhen('2026-03-04T22:30:00Z', 'Europe/Moscow')).toBe('5 марта, 01:30')
  })
})

describe('formatCount', () => {
  it('groups the digits of a long count the way the locale does', () => {
    // A no-break space between the thousands in ru.
    expect(formatCount(1208)).toBe('1\u00a0208')
    expect(formatCount(64)).toBe('64')
  })
})
