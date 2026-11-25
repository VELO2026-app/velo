// =============================================================================
// VELO Frontend -- dates of the finance tables
// =============================================================================
//
// Short, numeric, in the admin's own time zone (the profile's, useViewerTimezone
// -- the profile decides, not the browser): a payout request "24.11, 09:12", a
// promo's last day "31.12.2026". The order of day and month follows the
// interface locale.
// =============================================================================

import { DateTime } from 'luxon'
import { getLocale } from '@/locales'
import { formatCount } from '@/utils/format'

/**
 * A moment as day, month and time ("24.11, 09:12").
 *
 * @param timeZone - an IANA zone (the viewer's); the runtime's own when omitted
 */
export function formatStamp(isoString: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(getLocale(), {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(new Date(isoString))
}

/**
 * A moment as a full date ("31.12.2026").
 *
 * @param timeZone - an IANA zone (the viewer's); the runtime's own when omitted
 */
export function formatDay(isoString: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(getLocale(), {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(new Date(isoString))
}

/**
 * The last moment of a calendar day in a time zone, as an ISO instant: the end
 * of a promo that is valid "until" that day.
 *
 * @param day - a date as `YYYY-MM-DD`
 * @param timeZone - an IANA zone (the viewer's); the runtime's own when omitted
 */
export function endOfDayIso(day: string, timeZone?: string): string {
  return DateTime.fromISO(day, timeZone === undefined ? {} : { zone: timeZone })
    .endOf('day')
    .toJSDate()
    .toISOString()
}

/**
 * Today's date in a time zone as `YYYY-MM-DD`.
 *
 * @param timeZone - an IANA zone (the viewer's); the runtime's own when omitted
 */
export function todayIn(timeZone?: string): string {
  return DateTime.now().setZone(timeZone).toFormat('yyyy-MM-dd')
}

/**
 * A tab label with a count after it ("Awaiting · 4"); the bare label while the
 * count is zero, so a quiet queue shows no number.
 */
export function countedLabel(label: string, count: number): string {
  return count > 0 ? `${label} · ${formatCount(count)}` : label
}
