// =============================================================================
// VELO Frontend -- date and time as the console tables show them (FE-262)
// =============================================================================
//
// The console lists practices of every year, so a date outside the current
// year carries its year; today and tomorrow keep their relative words.
// =============================================================================

import { getLocale } from '@/locales'
import { formatDateShort, formatTime, relativeDayCode } from '@/utils/format'

/** The year of a moment in a time zone, as digits. */
function yearOf(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat(getLocale(), { year: 'numeric', timeZone: timezone }).format(date)
}

/**
 * A moment as "Today, 10:00", "24 November, 10:00" or "24 November 2025, 10:00":
 * the day in the given time zone, then the wall-clock time in it.
 *
 * @param isoString - an ISO date-time
 * @param timezone - the IANA time zone the day and the time are read in
 */
export function formatWhen(isoString: string, timezone: string): string {
  const time = formatTime(isoString, timezone)
  if (relativeDayCode(isoString, timezone) !== null)
    return `${formatDateShort(isoString, timezone)}, ${time}`
  const date = new Date(isoString)
  const day = new Intl.DateTimeFormat(getLocale(), {
    day: 'numeric',
    month: 'long',
    ...(yearOf(date, timezone) === yearOf(new Date(), timezone) ? {} : { year: 'numeric' }),
    timeZone: timezone,
  }).format(date)
  return `${day}, ${time}`
}
