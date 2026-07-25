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
// =============================================================================

/**
 * Format cents into a currency string using Intl.NumberFormat.
 *
 * By default, 0 cents returns "Бесплатно" (for practice prices).
 * Pass allowZero=true to format 0 as "0,00 €" (for balance display).
 *
 * S-24: Always uses 2 decimal places for consistency in payment context.
 *
 * Examples:
 *   formatMoney(1500, 'EUR')              -> "15,00 €"  (in ru locale)
 *   formatMoney(0, 'EUR')                 -> "Бесплатно"
 *   formatMoney(0, 'EUR', 'ru', true)     -> "0,00 €"
 */
export function formatMoney(
  cents: number,
  currency: string,
  locale = 'ru',
  allowZero = false,
): string {
  if (cents === 0 && !allowZero) return 'Бесплатно'
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
 *   formatDate('2026-02-28T07:00:00Z') -> "28 февраля, 10:00" (in Europe/Moscow)
 *   formatDate('2026-02-28T07:00:00Z', 'UTC') -> "28 февраля, 07:00"
 */
export function formatDate(isoString: string, timezone = 'UTC', locale = 'ru'): string {
  const date = new Date(isoString)
  return new Intl.DateTimeFormat(locale, {
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
 * Returns relative labels for today/tomorrow, otherwise "28 февраля".
 */
export function formatDateShort(isoString: string, timezone = 'UTC', locale = 'ru'): string {
  const date = new Date(isoString)
  const now = new Date()

  // Compare calendar dates in the target timezone
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: timezone,
    }).format(d)

  const dateStr = fmt(date)
  const todayStr = fmt(now)
  // SW9: +24h on the epoch, NOT Date.setDate() -- setDate mutates in the
  // DEVICE's own local timezone (whatever the runner's OS is set to), which
  // is unrelated to the `timezone` param this function renders in. On a day
  // the device's own timezone crosses a DST transition, setDate(getDate()+1)
  // does not land exactly +24h later, which can resolve to the wrong
  // calendar day once reformatted here.
  const tomorrowStr = fmt(new Date(now.getTime() + 24 * 60 * 60 * 1000))

  if (dateStr === todayStr) return 'Сегодня'
  if (dateStr === tomorrowStr) return 'Завтра'

  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    timeZone: timezone,
  }).format(date)
}

/**
 * Format an ISO datetime into a compact card date: "9 июня" / "12 сент.".
 *
 * Months follow the agreed VELO short-date table: a month whose genitive form
 * is <= 4 letters is written in full with NO period (мая / июня / июля); longer
 * ones are abbreviated to <= 4 letters + a period (янв. / февр. / мар. / апр. /
 * авг. / сент. / окт. / нояб. / дек.). Day + month only (no year, no time).
 * Timezone-safe (Intl with timeZone, no Date mutation).
 */
const VELO_SHORT_MONTHS = [
  'янв.',
  'февр.',
  'мар.',
  'апр.',
  'мая',
  'июня',
  'июля',
  'авг.',
  'сент.',
  'окт.',
  'нояб.',
  'дек.',
] as const

export function formatShortDate(isoString: string, timezone = 'UTC'): string {
  const date = new Date(isoString)
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: 'numeric',
    month: 'numeric',
    timeZone: timezone,
  }).formatToParts(date)
  // Parse the day rather than rendering ICU's string: en-CA's format matcher
  // resolves this day+month skeleton to MM-dd and pads both to two digits no
  // matter that we asked for `numeric` (resolvedOptions().day === '2-digit').
  // Number() normalises whatever padding any locale/ICU build hands back, so
  // this cannot silently drift back to "09 июня". The month below was always
  // immune for exactly this reason.
  const dayRaw = parts.find((p) => p.type === 'day')?.value ?? ''
  const day = dayRaw === '' ? '' : String(Number(dayRaw))
  const monthNum = Number(parts.find((p) => p.type === 'month')?.value ?? '1')
  const month = VELO_SHORT_MONTHS[monthNum - 1] ?? ''
  return `${day} ${month}`.trim()
}

/**
 * Whether the given ISO datetime falls on the current calendar day in the
 * target timezone. Used e.g. on the dashboard: a practice today shows its time,
 * any other day shows the date.
 */
export function isToday(isoString: string, timezone = 'UTC'): boolean {
  const calendarDay = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', {
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
 * truth for the diary day-grouping and the "Сегодня/Вчера" relative label.
 */
export function dayKeyOf(isoString: string, timezone = 'UTC'): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timezone,
  }).format(new Date(isoString))
}

/**
 * Relative day label «Сегодня» / «Вчера» / «24 января» for a datetime, computed
 * in the target timezone. Extracted verbatim from DiaryList/DiaryTimeline
 * (ПРОМТ №267) so the dashboard feedback banner and the diary share one
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
  if (key === todayKey) return 'Сегодня'
  if (key === yesterdayKey) return 'Вчера'
  return new Intl.DateTimeFormat('ru-RU', {
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
 * future-only floor for the in-app date pickers (promocode «Действует до»,
 * practice date). Zero-padded so the 'YYYY-MM-DD' string compare stays correct.
 */
export function todayLocalISO(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Format an ISO datetime string into time only: "07:00".
 */
export function formatTime(isoString: string, timezone = 'UTC', locale = 'ru'): string {
  const date = new Date(isoString)
  return new Intl.DateTimeFormat(locale, {
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
 * can sit below a card showing 12:00. This returns a comparable
 * `YYYYMMDDHHmmss` number built from the timezone-local parts, so an
 * ascending / descending sort matches the visible order (CR-1).
 *
 * ONLY for DISPLAY-ORDER sorts of a per-practice-timezone list. Do NOT use it
 * for `scheduled_at`-vs-`now` comparisons (has-started / countdown / windows)
 * or for lists rendered in a single viewer timezone — those must stay on the
 * absolute epoch.
 */
export function localSortKey(isoString: string, timezone = 'UTC'): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
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
 *   "23 января • Пятница • 14:35"
 * (day + month, weekday, time -- separated by bullets, matching the design).
 * Used by DiaryFeedCard. Defaults to the user's timezone (the diary is a
 * personal timeline -- "when it happened in my time").
 */
export function formatFeedDateTime(isoString: string, timezone = 'UTC', locale = 'ru'): string {
  const date = new Date(isoString)
  const dayMonth = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    timeZone: timezone,
  }).format(date)
  const weekday = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    timeZone: timezone,
  }).format(date)
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(date)
  // Capitalize the weekday (Intl returns lowercase in ru: "пятница").
  const weekdayCap = weekday.charAt(0).toUpperCase() + weekday.slice(1)
  return `${dayMonth} • ${weekdayCap} • ${time}`
}

/**
 * Format duration in minutes into a SHORT readable string. Compact so lines like
 * «12:30 · 1 ч 30 м» stay on one line (booking cards). Note the deliberate
 * asymmetry: minutes-only keeps the full «мин», while the combined form uses the
 * short «м» (operator spec, batch I).
 *
 * Examples:
 *   formatDuration(45)  -> "45 мин"    (minutes only, full «мин»)
 *   formatDuration(60)  -> "1 час"     (exactly one hour, spelled out)
 *   formatDuration(90)  -> "1 ч 30 м"  (hours + minutes, short «м»)
 *   formatDuration(120) -> "2 ч"       (exact multi-hour, no plural declension)
 */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} мин`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (m === 0) return h === 1 ? '1 час' : `${h} ч`
  return `${h} ч ${m} м`
}

/**
 * Format participants count: "5/20" or "N участн." when unlimited.
 */
export function formatParticipants(current: number, max: number | null): string {
  if (max === null) return `${current} участн.`
  // No trailing «мест» — the group icon already conveys it; the design shows a
  // bare «N/M» (operator 2026-06-17).
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
 * Strip a trailing " (эфир)" marker from a practice title.
 *
 * Some seeded / manually created practices append "(эфир)" to the title (see
 * seed.py). Live practices already show a "В эфире" badge, so the suffix is
 * redundant noise in the title itself. Single source of truth for cleaning it
 * (FormShell check-in/feedback header; dashboard nearest-practice card).
 */
export function cleanPracticeTitle(title: string): string {
  return title.replace(/\s*\(эфир\)\s*$/i, '')
}
