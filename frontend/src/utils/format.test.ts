// =============================================================================
// VELO Frontend -- format.ts Unit Tests (updated F5 review)
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import {
  formatMoney,
  formatDuration,
  formatDateShort,
  formatShortDate,
  formatTime,
  formatParticipants,
  isFull,
  localSortKey,
  dayLabelOf,
} from '@/utils/format'

// -----------------------------------------------------------------------
// formatMoney
// -----------------------------------------------------------------------
describe('formatMoney', () => {
  it('returns "Бесплатно" for 0 cents by default', () => {
    expect(formatMoney(0, 'EUR')).toBe('Бесплатно')
  })

  it('formats 0 cents as currency when allowZero is true', () => {
    const result = formatMoney(0, 'EUR', 'ru', true)
    // Should contain "0" and NOT be "Бесплатно"
    expect(result).toContain('0')
    expect(result).not.toBe('Бесплатно')
  })

  it('formats EUR cents into euros with 2 decimal places', () => {
    const result = formatMoney(1500, 'EUR', 'ru')
    // S-24: always 2 decimals -> should contain "15" and ",00" or ".00"
    expect(result).toContain('15')
    expect(result).not.toBe('Бесплатно')
  })

  it('formats small amounts with 2 decimal places', () => {
    const result = formatMoney(50, 'EUR', 'ru')
    // 50 cents = 0.50 EUR -> should show "0,50" not "0,5"
    expect(result).toContain('0')
    expect(result).toMatch(/0[,.]50/)
  })

  it('formats large amounts', () => {
    const result = formatMoney(999900, 'EUR', 'ru')
    // 999900 cents = 9999 EUR
    expect(result).toContain('9')
    expect(result).not.toBe('Бесплатно')
  })

  it('allowZero does not affect non-zero amounts', () => {
    const withFlag = formatMoney(1500, 'EUR', 'ru', true)
    const withoutFlag = formatMoney(1500, 'EUR', 'ru', false)
    expect(withFlag).toBe(withoutFlag)
  })

  it('whole euro amounts still show decimals (S-24)', () => {
    const result = formatMoney(500, 'EUR', 'ru')
    // 500 cents = 5.00 EUR -> must show "5,00" not just "5"
    expect(result).toMatch(/5[,.]00/)
  })
})

// -----------------------------------------------------------------------
// formatDuration
// -----------------------------------------------------------------------
describe('formatDuration', () => {
  it('formats minutes under 60 (full «мин»)', () => {
    expect(formatDuration(45)).toBe('45 мин')
  })

  it('spells out exactly one hour, short «ч» for multi-hour', () => {
    expect(formatDuration(60)).toBe('1 час')
    expect(formatDuration(120)).toBe('2 ч')
  })

  it('formats hours and minutes with short «м»', () => {
    expect(formatDuration(90)).toBe('1 ч 30 м')
    expect(formatDuration(150)).toBe('2 ч 30 м')
  })

  it('handles single minute', () => {
    expect(formatDuration(1)).toBe('1 мин')
  })

  it('handles zero minutes', () => {
    expect(formatDuration(0)).toBe('0 мин')
  })
})

// -----------------------------------------------------------------------
// formatDateShort
// -----------------------------------------------------------------------
describe('formatDateShort', () => {
  // Clock-stable: the «Сегодня»/«Завтра» cases compare against `new Date()`, which
  // is flaky near local midnight (local-tomorrow can resolve to a UTC date +2 days).
  // Pin "now" to a mid-day, mid-month instant so they're deterministic.
  // formatDateShort itself is unchanged. The flake was a test-construction
  // artifact (dates built in the local runtime tz, then formatted as UTC), not
  // a formatDateShort bug.
  beforeAll(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'))
  })
  afterAll(() => {
    vi.useRealTimers()
  })

  it('returns "Сегодня" for today', () => {
    const now = new Date()
    const result = formatDateShort(now.toISOString(), 'UTC')
    expect(result).toBe('Сегодня')
  })

  it('returns "Завтра" for tomorrow', () => {
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    // Set to noon to avoid timezone boundary issues
    tomorrow.setHours(12, 0, 0, 0)
    const result = formatDateShort(tomorrow.toISOString(), 'UTC')
    expect(result).toBe('Завтра')
  })

  it('returns a date string for other dates', () => {
    // A date far in the future
    const result = formatDateShort('2030-06-15T12:00:00Z', 'UTC', 'ru')
    // Should contain "15" and some month representation
    expect(result).toContain('15')
    expect(result).not.toBe('Сегодня')
    expect(result).not.toBe('Завтра')
  })

  // SW9: "tomorrow" must be computed as a fixed +24h instant, not via
  // `Date.setDate()`, which mutates in the DEVICE's OWN local timezone
  // (stubbed via vi.stubEnv('TZ', ...) here, standing in for the runner's OS
  // timezone) -- NOT the `timezone` PARAMETER this function is meant to
  // render in. On a day the device's own timezone crosses a DST transition,
  // `setDate(getDate()+1)` does not land exactly +24h later (it lands +23h
  // or +25h), which can resolve to the WRONG calendar day once reformatted
  // in the target timezone -- independent of whether the target timezone
  // itself observes DST (Cape Verde below never has).
  it('SW9: "tomorrow" is unaffected by the DEVICE\'s own DST transition', () => {
    // US spring-forward 2026: clocks jump 2:00 -> 3:00 EST->EDT on Mar 8.
    vi.stubEnv('TZ', 'America/New_York')
    try {
      // "Now" = Mar 7, 8pm EST (the evening before the device's own DST
      // jump). setDate(getDate()+1) resolves to Mar 8, 8pm -- by then EDT
      // has already started, so that instant is only +23h from "now", not
      // +24h.
      vi.setSystemTime(new Date('2026-03-08T01:00:00.000Z'))

      // Target timezone Cape Verde (UTC-1, no DST, ever) straddles a local
      // midnight between the OLD (buggy, +23h) and the CORRECT (+24h)
      // "tomorrow" instant: 2026-03-09T00:00Z is still Mar 8 there, while
      // 2026-03-09T01:00Z is already Mar 9.
      const result = formatDateShort('2026-03-09T12:00:00Z', 'Atlantic/Cape_Verde')

      expect(result).toBe('Завтра')
    } finally {
      vi.unstubAllEnvs()
      vi.setSystemTime(new Date('2026-06-15T12:00:00Z'))
    }
  })
})

// -----------------------------------------------------------------------
// dayLabelOf
// -----------------------------------------------------------------------
describe('dayLabelOf', () => {
  beforeAll(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'))
  })
  afterAll(() => {
    vi.useRealTimers()
  })

  it('returns "Сегодня" for today', () => {
    const result = dayLabelOf(new Date().toISOString(), 'UTC')
    expect(result).toBe('Сегодня')
  })

  it('returns "Вчера" for yesterday', () => {
    const result = dayLabelOf('2026-06-14T12:00:00Z', 'UTC')
    expect(result).toBe('Вчера')
  })

  it('returns a formatted date for older entries', () => {
    const result = dayLabelOf('2026-06-10T12:00:00Z', 'UTC')
    expect(result).not.toBe('Сегодня')
    expect(result).not.toBe('Вчера')
    expect(result).toContain('10')
  })

  // SW9: mirror of formatDateShort's "tomorrow" fix -- "yesterday" must be a
  // fixed -24h instant, not Date.setDate(), which mutates in the DEVICE's own
  // local timezone (not the `timezone` parameter). On a day the device's own
  // timezone crosses a DST transition, setDate(getDate()-1) does not land
  // exactly -24h earlier, which can resolve to the wrong calendar day once
  // reformatted in the target timezone.
  it('SW9: "yesterday" is unaffected by the DEVICE\'s own DST transition', () => {
    vi.stubEnv('TZ', 'America/New_York')
    try {
      // "Now" = Mar 8, 8pm EDT -- the evening of the device's own DST jump
      // (2am->3am). setDate(getDate()-1) resolves to Mar 7, 8pm EST (the day
      // BEFORE the jump), which is only -23h from "now", not -24h.
      vi.setSystemTime(new Date('2026-03-09T00:00:00.000Z'))

      // Target timezone Cape Verde (UTC-1, no DST, ever) straddles a local
      // midnight between the OLD (buggy, -23h) and the CORRECT (-24h)
      // "yesterday" instant.
      const result = dayLabelOf('2026-03-07T12:00:00Z', 'Atlantic/Cape_Verde')

      expect(result).toBe('Вчера')
    } finally {
      vi.unstubAllEnvs()
      vi.setSystemTime(new Date('2026-06-15T12:00:00Z'))
    }
  })
})

// -----------------------------------------------------------------------
// formatShortDate
//
// NOT the same function as formatDateShort above -- the names are one
// word-swap apart, both are exported, and each has ~12 view consumers. That
// near-collision is the likeliest reason this function shipped with ZERO tests
// while its lookalike had a block: a reader scanning this file sees
// "formatDateShort" covered and moves on.
//
// The gap cost a real bug (ПРОМТ №440/441): days 1-9 rendered zero-padded
// ("09 июня") against a docstring promising "9 июня", across 13 view/card
// surfaces, for nine days of every month. Days 10-31 were correct, which is why
// no one noticed. The leading-zero cases below are the regression guard --
// deleting them re-opens the hole.
// -----------------------------------------------------------------------
describe('formatShortDate', () => {
  // Day boundaries. 1 and 9 are the bug's territory; 10 and 31 always worked,
  // and are here so a fix that over-corrects (stripping a digit from 10-31)
  // fails loudly instead of trading one bug for another.
  it('renders a single-digit day with NO leading zero (day 1)', () => {
    expect(formatShortDate('2026-05-01T12:00:00Z')).toBe('1 мая')
  })

  it('renders a single-digit day with NO leading zero (day 9)', () => {
    expect(formatShortDate('2026-06-09T12:00:00Z')).toBe('9 июня')
  })

  it('renders a two-digit day unchanged (day 10)', () => {
    expect(formatShortDate('2026-06-10T12:00:00Z')).toBe('10 июня')
  })

  it('renders the last day of a month unchanged (day 31)', () => {
    expect(formatShortDate('2026-07-31T12:00:00Z')).toBe('31 июля')
  })

  it('never emits a leading zero for ANY single-digit day', () => {
    // The whole 1..9 range in one sweep: this is the assertion that would have
    // caught the original defect on day one.
    const days = Array.from({ length: 9 }, (_, i) => i + 1)
    const rendered = days.map((d) => formatShortDate(`2026-06-0${d}T12:00:00Z`))
    expect(rendered).toEqual([
      '1 июня',
      '2 июня',
      '3 июня',
      '4 июня',
      '5 июня',
      '6 июня',
      '7 июня',
      '8 июня',
      '9 июня',
    ])
  })

  // The VELO short-month table: <= 4 letters written in full with NO period
  // (мая / июня / июля), longer ones abbreviated to <= 4 + a period.
  it('renders every month per the VELO short-date table', () => {
    const rendered = Array.from({ length: 12 }, (_, i) =>
      formatShortDate(`2026-${String(i + 1).padStart(2, '0')}-15T12:00:00Z`),
    )
    expect(rendered).toEqual([
      '15 янв.',
      '15 февр.',
      '15 мар.',
      '15 апр.',
      '15 мая',
      '15 июня',
      '15 июля',
      '15 авг.',
      '15 сент.',
      '15 окт.',
      '15 нояб.',
      '15 дек.',
    ])
  })

  // Timezone parameter. The fixture sits late enough in UTC that a positive
  // offset rolls it onto the next calendar day -- so this fails if the timezone
  // is ignored, rather than passing by coincidence.
  it('defaults to UTC', () => {
    expect(formatShortDate('2026-06-09T23:00:00Z')).toBe('9 июня')
  })

  it('honours the timezone parameter, rolling the day forward', () => {
    expect(formatShortDate('2026-06-09T23:00:00Z', 'Europe/Moscow')).toBe('10 июня')
  })

  it('honours the timezone parameter, rolling the day back', () => {
    expect(formatShortDate('2026-06-09T02:00:00Z', 'America/New_York')).toBe('8 июня')
  })

  it('applies the timezone across a month boundary', () => {
    expect(formatShortDate('2026-06-30T23:00:00Z', 'Asia/Tokyo')).toBe('1 июля')
  })
})

// -----------------------------------------------------------------------
// formatTime
// -----------------------------------------------------------------------
describe('formatTime', () => {
  it('formats UTC time', () => {
    const result = formatTime('2026-02-28T07:30:00Z', 'UTC')
    expect(result).toBe('07:30')
  })

  it('respects timezone offset', () => {
    // UTC 07:00 -> Europe/Moscow is UTC+3 -> 10:00
    const result = formatTime('2026-02-28T07:00:00Z', 'Europe/Moscow')
    expect(result).toBe('10:00')
  })
})

// -----------------------------------------------------------------------
// localSortKey (CR-1: list order must match the displayed local time)
// -----------------------------------------------------------------------
describe('localSortKey', () => {
  it('encodes the timezone-local wall-clock as YYYYMMDDHHmmss', () => {
    // 07:00 UTC in Europe/Moscow (UTC+3) reads 10:00 local.
    expect(localSortKey('2026-07-01T07:00:00Z', 'Europe/Moscow')).toBe(20260701100000)
  })

  it('orders by LOCAL time even when the absolute UTC order is reversed', () => {
    // A: 10:00 local in a UTC+0 zone  -> instant 10:00 UTC
    // B: 12:00 local in a UTC+5 zone  -> instant 07:00 UTC
    // Absolute epoch would put B (07:00 UTC) before A (10:00 UTC) — i.e. a 12:00
    // card above a 10:00 card. localSortKey must keep A (10:00) before B (12:00).
    const a = { at: '2026-07-01T10:00:00Z', tz: 'Atlantic/Reykjavik' } // UTC+0, no DST
    const b = { at: '2026-07-01T07:00:00Z', tz: 'Asia/Yekaterinburg' } // UTC+5, no DST

    // Sanity: the naive absolute-epoch order really is reversed vs the local order.
    expect(new Date(b.at).getTime()).toBeLessThan(new Date(a.at).getTime())

    // localSortKey restores the visible order: 10:00 (A) sorts before 12:00 (B).
    expect(localSortKey(a.at, a.tz)).toBeLessThan(localSortKey(b.at, b.tz))
    expect(localSortKey(a.at, a.tz)).toBe(20260701100000)
    expect(localSortKey(b.at, b.tz)).toBe(20260701120000)
  })
})

// -----------------------------------------------------------------------
// formatParticipants
// -----------------------------------------------------------------------
describe('formatParticipants', () => {
  it('shows current/max when max is set', () => {
    expect(formatParticipants(5, 20)).toBe('5/20')
  })

  it('shows count + label when max is null (unlimited)', () => {
    expect(formatParticipants(3, null)).toBe('3 участн.')
  })

  it('shows 0/max', () => {
    expect(formatParticipants(0, 10)).toBe('0/10')
  })
})

// -----------------------------------------------------------------------
// isFull
// -----------------------------------------------------------------------
describe('isFull', () => {
  it('returns false when unlimited (null max)', () => {
    expect(isFull(100, null)).toBe(false)
  })

  it('returns false when spots available', () => {
    expect(isFull(5, 20)).toBe(false)
  })

  it('returns true when current equals max', () => {
    expect(isFull(20, 20)).toBe(true)
  })

  it('returns true when current exceeds max', () => {
    expect(isFull(21, 20)).toBe(true)
  })
})
