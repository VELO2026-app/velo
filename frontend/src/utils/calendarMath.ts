import { DateTime } from 'luxon'

// =============================================================================
// VELO Frontend -- Calendar math (wall-date arithmetic, no timezones)
// =============================================================================
//
// Pure calendar math for month grids: month lengths, month shifts, weekdays.
// Operates on (year, month 1..12, day) and creates no Date, so the timezone
// never participates at all (the no-restricted-syntax rule).
// =============================================================================

/** Number of days in the month (month is 1..12). */
export function daysInMonth(year: number, month: number): number {
  return DateTime.fromObject({ year, month }, { zone: 'utc' }).daysInMonth!
}

/** Weekday of the 1st of the month: 0 = Monday .. 6 = Sunday (Monday-first grid). */
export function firstWeekdayMonFirst(year: number, month: number): number {
  const weekday = DateTime.fromObject({ year, month, day: 1 }, { zone: 'utc' }).weekday // 1=Mon..7=Sun
  return weekday - 1
}

/** The (year, month) shifted by delta months; the year normalizes across the boundary. */
export function shiftMonthParts(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const shifted = DateTime.fromObject({ year, month, day: 1 }, { zone: 'utc' }).plus({
    months: delta,
  })
  return { year: shifted.year, month: shifted.month }
}

/** The calendar day as YYYY-MM-DD (grid key; wall date, zone-free). */
export function dayKeyOf(year: number, month: number, day: number): string {
  return DateTime.fromObject({ year, month, day }, { zone: 'utc' }).toFormat('yyyy-MM-dd')
}

/** YYYY-MM-DD for a Date in the local zone (equivalent to en-CA formatting). */
export function dayKeyOfDate(d: Date): string {
  return DateTime.fromJSDate(d).toFormat('yyyy-MM-dd')
}

/** The 1st of the month containing `d` (local midnight of that day). */
export function firstOfMonth(d: Date): Date {
  return DateTime.fromJSDate(d).startOf('month').toJSDate()
}

/** `d` shifted by delta months and normalized to the 1st of the month. */
export function shiftMonthDate(d: Date, delta: number): Date {
  return DateTime.fromJSDate(d).plus({ months: delta }).startOf('month').toJSDate()
}
