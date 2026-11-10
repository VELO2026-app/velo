// =============================================================================
// VELO Frontend -- Format Utilities (Phase F3.1, updated F4.2, fixed F5 review)
// =============================================================================
//
// Pure formatting functions used across practice cards, detail views,
// and any future components that display money, dates, or durations.
//
// All functions are locale-aware where applicable (defaults to 'ru').
//
// F4.2: formatMoney gains allowZero param for balance display.
// F5 review: S-24 -- minimumFractionDigits: 2 for consistent money format.
// tz-i18n 1.1: labels come from the active locale's catalog; the Intl
// locale parameter defaults to it too (getLocale()). cleanPracticeTitle is
// NOT i18n scope -- the on-air title suffix it strips is a DATA suffix from
// the seed/backend.
// =============================================================================

import i18n, { getLocale } from '@/locales'
// The ru seed catalog carries the VELO short-month table -- RUSSIAN typography
// (see dates.json), not per-locale UI copy; same seed-import pattern as
// methodTaxonomy.ts's display seed.
// ?raw + JSON.parse: VueI18nPlugin precompiles every plain locales/**/*.json
// import into message ASTs; this seed is DATA (ru typography tables), so its
// leaves must stay plain strings.
import datesSeedRaw from '@/locales/ru/dates.json?raw'

const { t } = i18n.global

/**
 * Memoised Intl.DateTimeFormat. Constructing a formatter is the expensive part
 * of date formatting (hot in the diary feed: one per card and per day group),
 * so one instance is kept per (locale, options) -- options carry the timeZone.
 * Option objects here are small flat literals, so JSON is a stable cache key.
 */
const dtfCache = new Map<string, Intl.DateTimeFormat>()
function dateTimeFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`
  let fmt = dtfCache.get(key)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, options)
    dtfCache.set(key, fmt)
  }
  return fmt
}

const datesSeed = JSON.parse(datesSeedRaw) as { dates?: { shortMonths?: string[] } }
const VELO_SHORT_MONTHS: readonly string[] = datesSeed.dates?.shortMonths ?? []

/**
 * Format cents into a currency string using Intl.NumberFormat.
 *
 * By default, 0 cents returns the free label (i18n:common.free; for practice
 * prices).
 *
 * @param allowZero - Pass `true` to format 0 as "0,00 €" (for balance display).
 *
 * S-24: Always uses 2 decimal places for consistency in payment context.
 *
 * Examples:
 *   `formatMoney(1500, 'EUR')              -> "15,00 €"`  (in ru locale)
 *   `formatMoney(0, 'EUR')                 -> i18n:common.free`
 *   `formatMoney(0, 'EUR', getLocale(), true)     -> "0,00 €"`
 */
export function formatMoney(
  cents: number,
  currency: string,
  locale: string = getLocale(),
  allowZero = false,
): string {
  if (cents === 0 && !allowZero) return t('common.free')
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100)
}

/**
 * Format an ISO datetime string into a human-readable date + time.
 *
 * Examples:
 *   `formatDate('2026-02-28T07:00:00Z') -> "28 <month>, 10:00"` (in Europe/Moscow)
 *   `formatDate('2026-02-28T07:00:00Z', 'UTC') -> "28 <month>, 07:00"`
 */
export function formatDate(
  isoString: string,
  timezone = 'UTC',
  locale: string = getLocale(),
): string {
  const date = new Date(isoString)
  return dateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(date)
}

/**
 * Format an ISO datetime string into a short date for section headers.
 *
 * @returns Relative labels for today/tomorrow, otherwise "28 <month>".
 */
export function formatDateShort(
  isoString: string,
  timezone = 'UTC',
  locale: string = getLocale(),
): string {
  const code = relativeDayCode(isoString, timezone)
  if (code === 'today') return t('common.today')
  if (code === 'tomorrow') return t('common.tomorrow')

  const date = new Date(isoString)
  return dateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    timeZone: timezone,
  }).format(date)
}

/**
 * Calendar-day code for an ISO datetime against now, in the target timezone:
 * 'today' | 'tomorrow' | null. tz-i18n §3.1 item 2 — callers branch on this
 * CODE, never by comparing rendered labels (formatDateShort's today label,
 * i18n:common.today, is locale output, not an operand).
 *
 * SW9: +24h on the epoch, NOT Date.setDate() -- setDate mutates in the
 * DEVICE's own local timezone (whatever the runner's OS is set to), which
 * is unrelated to the `timezone` param this function renders in. On a day
 * the device's own timezone crosses a DST transition, setDate(getDate()+1)
 * does not land exactly +24h later, which can resolve to the wrong
 * calendar day once reformatted.
 */
export function relativeDayCode(isoString: string, timezone = 'UTC'): 'today' | 'tomorrow' | null {
  const date = new Date(isoString)
  const now = new Date()

  // Compare calendar dates in the target timezone
  const fmt = (d: Date) =>
    dateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: timezone,
    }).format(d)

  const dateStr = fmt(date)
  const todayStr = fmt(now)
  const tomorrowStr = fmt(new Date(now.getTime() + 24 * 60 * 60 * 1000))

  if (dateStr === todayStr) return 'today'
  if (dateStr === tomorrowStr) return 'tomorrow'
  return null
}

/**
 * Format an ISO datetime into a compact card date: "9 June" / "12 Sept." style.
 *
 * Months follow the agreed VELO short-date table (ru genitive months, seeded
 * in locales/ru/dates.json): a month whose genitive form is `<= 4` letters is
 * written in full with NO period (May / June / July); longer ones are
 * abbreviated to `<= 4` letters + a period (Jan. / Feb. / Mar. / Apr. / Aug. /
 * Sept. / Oct. / Nov. / Dec.). Day + month only (no year, no time).
 * Timezone-safe (Intl with timeZone, no Date mutation).
 */

export function formatShortDate(isoString: string, timezone = 'UTC'): string {
  const date = new Date(isoString)
  const locale = getLocale()
  const parts = dateTimeFormat('en-CA', {
    day: 'numeric',
    month: 'numeric',
    timeZone: timezone,
  }).formatToParts(date)
  // Parse the day rather than rendering ICU's string: en-CA's format matcher
  // resolves this day+month skeleton to MM-dd and pads both to two digits no
  // matter that we asked for `numeric` (resolvedOptions().day === '2-digit').
  // Number() normalises whatever padding any locale/ICU build hands back, so
  // this cannot silently drift back to a zero-padded "09 <month>" day. The
  // month below was always immune for exactly this reason.
  const dayRaw = parts.find((p) => p.type === 'day')?.value ?? ''
  const day = dayRaw === '' ? '' : String(Number(dayRaw))
  const monthNum = Number(parts.find((p) => p.type === 'month')?.value ?? '1')
  // The agreed VELO short-month table is a RUSSIAN typographic rule (a
  // genitive <= 4 letters in full, otherwise abbreviated + dot); other
  // locales render ICU's own short month.
  const month =
    locale === 'ru'
      ? (VELO_SHORT_MONTHS[monthNum - 1] ?? '')
      : dateTimeFormat(locale, { month: 'short', timeZone: timezone }).format(date)
  return `${day} ${month}`.trim()
}

/**
 * Whether the given ISO datetime falls on the current calendar day in the
 * target timezone. Used e.g. on the dashboard: a practice today shows its time,
 * any other day shows the date.
 */
export function isToday(isoString: string, timezone = 'UTC'): boolean {
  const calendarDay = (d: Date) =>
    dateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: timezone,
    }).format(d)
  return calendarDay(new Date(isoString)) === calendarDay(new Date())
}

/**
 * Calendar-day key 'YYYY-MM-DD' in the target timezone — the day boundary used
 * to tell whether two datetimes fall on the same calendar day. Single source of
 * truth for the diary day-grouping and the today/yesterday relative labels.
 */
export function dayKeyOf(isoString: string, timezone = 'UTC'): string {
  return dateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timezone,
  }).format(new Date(isoString))
}

/**
 * Relative day label -- today (i18n:common.today), yesterday
 * (i18n:common.yesterday), or a "24 <month>" date -- for a datetime, computed
 * in the target timezone. Extracted verbatim from DiaryList/DiaryTimeline
 * (PROMPT №267) so the dashboard feedback banner and the diary share one
 * implementation instead of hardcoding the day.
 */
export function dayLabelOf(isoString: string, timezone = 'UTC'): string {
  const key = dayKeyOf(isoString, timezone)
  const now = new Date()
  const todayKey = dayKeyOf(now.toISOString(), timezone)
  // SW9: -24h on the epoch, NOT Date.setDate() -- see formatDateShort's
  // "tomorrow" for the same reasoning (device-local DST skew).
  const yesterdayKey = dayKeyOf(
    new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    timezone,
  )
  if (key === todayKey) return t('common.today')
  if (key === yesterdayKey) return t('common.yesterday')
  return dateTimeFormat(getLocale(), {
    day: 'numeric',
    month: 'long',
    timeZone: timezone,
  }).format(new Date(isoString))
}

/**
 * Today's calendar date as a LOCAL-time ISO string 'YYYY-MM-DD' (zero-padded).
 *
 * Unlike `new Date().toISOString().slice(0, 10)` (which is UTC), this reads the
 * browser's LOCAL date parts, so a date-floor `:min` computed from it doesn't
 * drift by a day for users east/west of UTC near midnight. Used as the
 * future-only floor for the in-app date pickers (the promocode valid-until
 * field, i18n:masterScreens.masterNewPromocode.fields.validUntil; practice
 * date). Zero-padded so the 'YYYY-MM-DD' string compare stays correct.
 */
export function todayLocalISO(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Format an ISO datetime string into time only: "07:00".
 */
export function formatTime(
  isoString: string,
  timezone = 'UTC',
  locale: string = getLocale(),
): string {
  const date = new Date(isoString)
  return dateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(date)
}

/**
 * Sortable key for a practice's LOCAL wall-clock datetime in its OWN timezone.
 *
 * List order must match the times shown on screen. Cards that render each
 * practice in its own timezone (`formatTime(scheduled_at, timezone)`) can NOT
 * be ordered by the absolute UTC epoch (`new Date(scheduled_at).getTime()`):
 * that orders by the underlying instant, which disagrees with the displayed
 * local times once practices span different timezones — a card showing 10:00
 * can sit below a card showing 12:00.
 *
 * @returns A comparable `YYYYMMDDHHmmss` number built from the
 *  timezone-local parts, so an ascending / descending sort matches the
 *  visible order (CR-1).
 *
 * ONLY for DISPLAY-ORDER sorts of a per-practice-timezone list. Do NOT use it
 * for `scheduled_at`-vs-`now` comparisons (has-started / countdown / windows)
 * or for lists rendered in a single viewer timezone — those must stay on the
 * absolute epoch.
 */
export function localSortKey(isoString: string, timezone = 'UTC'): number {
  const parts = dateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).formatToParts(new Date(isoString))
  const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0')
  // hour12:false emits '24' at midnight in some engines — normalize to 0.
  const hour = part('hour') % 24
  return (
    part('year') * 1e10 +
    part('month') * 1e8 +
    part('day') * 1e6 +
    hour * 1e4 +
    part('minute') * 1e2 +
    part('second')
  )
}

/**
 * Format an ISO datetime into the diary feed card date line:
 *   "23 <month> • <Weekday> • 14:35"
 * (day + month, weekday, time -- separated by bullets, matching the design).
 * Used by DiaryFeedCard. Defaults to the user's timezone (the diary is a
 * personal timeline -- "when it happened in my time").
 */
export function formatFeedDateTime(
  isoString: string,
  timezone = 'UTC',
  locale: string = getLocale(),
): string {
  const date = new Date(isoString)
  const dayMonth = dateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    timeZone: timezone,
  }).format(date)
  const weekday = dateTimeFormat(locale, {
    weekday: 'long',
    timeZone: timezone,
  }).format(date)
  const time = dateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(date)
  // Capitalize the weekday (Intl returns it lowercase in the ru locale).
  const weekdayCap = weekday.charAt(0).toUpperCase() + weekday.slice(1)
  return `${dayMonth} • ${weekdayCap} • ${time}`
}

/**
 * Format duration in minutes into a SHORT readable string. Compact so booking
 * card lines like "12:30 · 1 h 30 m" stay on one line. Note the deliberate
 * asymmetry: minutes-only keeps the full minutes word
 * (i18n:common.duration.min), while the combined form uses the short unit
 * (i18n:common.duration.m) (operator spec, batch I).
 *
 * Examples (ru catalog units):
 *   `formatDuration(45)  -> "45 <min>"`      (minutes only, full word)
 *   `formatDuration(60)  -> "1 <hour>"`      (exactly one hour, spelled out)
 *   `formatDuration(90)  -> "1 <h> 30 <m>"`  (hours + minutes, short unit)
 *   `formatDuration(120) -> "2 <h>"`         (exact multi-hour, no plural declension)
 */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} ${t('common.duration.min')}`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (m === 0) return h === 1 ? `1 ${t('common.duration.hour')}` : `${h} ${t('common.duration.h')}`
  return `${h} ${t('common.duration.h')} ${m} ${t('common.duration.m')}`
}

/**
 * Format participants count: "5/20", or the abbreviated participants count
 * (i18n:common.participantsAbbr) when unlimited.
 */
export function formatParticipants(current: number, max: number | null): string {
  if (max === null) return t('common.participantsAbbr', { n: current })
  // No trailing spots word -- the group icon already conveys it; the design
  // shows a bare "N/M" (operator 2026-06-17).
  return `${current}/${max}`
}

/**
 * Check if a practice is full (has max_participants and no spots left).
 */
export function isFull(current: number, max: number | null): boolean {
  if (max === null) return false
  return current >= max
}

/**
 * Strip the trailing on-air marker suffix from a practice title (the literal
 * lives in the regex below).
 *
 * Some seeded / manually created practices append the Russian on-air suffix
 * to the title (see seed.py). Live practices already show the live badge
 * (e.g. i18n:user.screens.practiceLive.liveBadge), so the suffix is redundant
 * noise in the title itself. Single source of truth for cleaning it
 * (FormShell check-in/feedback header; dashboard nearest-practice card).
 */
export function cleanPracticeTitle(title: string): string {
  return title.replace(/\s*\(эфир\)\s*$/i, '')
}

/**
 * Format a percentage share for the analytics distribution strips
 * (practice mood / school feedback). The TZ rule (tz-practice-analytics.md):
 * a share strictly between 0 and 1 reads «`<1%`», between 99 and 100 reads
 * «`>99%`», everything else rounds to a whole percent — so a real minority
 * share never renders as a flat 0% and an incomplete distribution never
 * reads as a full 100%.
 */
export function formatPercent(percent: number): string {
  if (percent > 0 && percent < 1) return '<1%'
  if (percent > 99 && percent < 100) return '>99%'
  return `${Math.round(percent)}%`
}
