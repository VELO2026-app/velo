// Shared practice form options.
// Used by CreatePracticeView and EditPracticeView to avoid duplication (W-2).

import type { PracticeDirection } from '@/api/types'
import type { TaxonomyListResponse } from '@/api/taxonomy'

export const DURATION_OPTIONS: { label: string; value: string }[] = [
  { label: '30 минут', value: '30' },
  { label: '45 минут', value: '45' },
  { label: '60 минут', value: '60' },
  { label: '75 минут', value: '75' },
  { label: '90 минут', value: '90' },
  { label: '120 минут', value: '120' },
]

// «Для кого практика» (P5, ПРОМТ №594): audience_kind single-select, shared
// between Create and Edit for the same reason as DURATION_OPTIONS above --
// originally lived only in CreatePracticeView; extracted here so Edit's port
// doesn't duplicate the option list a second time.
export const AUDIENCE_OPTIONS: { label: string; value: string }[] = [
  { value: 'public', label: 'Публичная' },
  { value: 'students', label: 'Все ученики' },
  { value: 'groups', label: 'Конкретные группы' },
]

// -- Timezone options (iOS-style world list, 2026-05-29) ----------------------
// One reference city per unique world UTC offset, from UTC-11 to UTC+14,
// including the half-hour and 45-minute offsets (India, Nepal, Iran,
// Afghanistan, Chatham, etc). 37 entries.
//
// Storage stays IANA: `value` is the IANA zone id, exactly as before. Only the
// label changes -- it is rendered as `${City} UTC${offset}` (iOS style), with
// the offset computed dynamically from the IANA zone at module-load time (see
// buildTimezoneLabel / formatUtcOffset below). That means a DST zone shows its
// CURRENT offset (e.g. Berlin UTC+2 in summer, UTC+1 in winter); the label is
// computed once per page load, which is acceptable -- it can only drift by an
// hour across a DST boundary within a single session, never the stored value.
//
// The exported TIMEZONE_OPTIONS keeps the same { label, value }[] shape the
// master create/edit forms already consume, so those forms need no change.

// Reference city per offset. Order here is irrelevant -- TIMEZONE_OPTIONS is
// sorted by the real computed offset below.
const TIMEZONE_CITIES: { iana: string; city: string }[] = [
  { iana: 'Pacific/Pago_Pago', city: 'Pago Pago' }, // -11:00
  { iana: 'Pacific/Honolulu', city: 'Honolulu' }, // -10:00
  { iana: 'Pacific/Marquesas', city: 'Marquesas' }, // -09:30
  { iana: 'America/Anchorage', city: 'Anchorage' }, // -09:00
  { iana: 'America/Los_Angeles', city: 'Los Angeles' }, // -08:00
  { iana: 'America/Denver', city: 'Denver' }, // -07:00
  { iana: 'America/Chicago', city: 'Chicago' }, // -06:00
  { iana: 'America/New_York', city: 'New York' }, // -05:00
  { iana: 'America/Halifax', city: 'Halifax' }, // -04:00
  { iana: 'America/St_Johns', city: "St. John's" }, // -03:30
  { iana: 'America/Sao_Paulo', city: 'Sao Paulo' }, // -03:00
  { iana: 'America/Noronha', city: 'Fernando de Noronha' }, // -02:00
  { iana: 'Atlantic/Azores', city: 'Azores' }, // -01:00
  { iana: 'Europe/London', city: 'London' }, // +00:00
  { iana: 'Europe/Berlin', city: 'Berlin' }, // +01:00
  { iana: 'Europe/Kyiv', city: 'Kyiv' }, // +02:00
  { iana: 'Europe/Moscow', city: 'Moscow' }, // +03:00
  { iana: 'Asia/Tehran', city: 'Tehran' }, // +03:30
  { iana: 'Asia/Dubai', city: 'Dubai' }, // +04:00
  { iana: 'Asia/Kabul', city: 'Kabul' }, // +04:30
  { iana: 'Asia/Karachi', city: 'Karachi' }, // +05:00
  { iana: 'Asia/Kolkata', city: 'Mumbai' }, // +05:30
  { iana: 'Asia/Kathmandu', city: 'Kathmandu' }, // +05:45
  { iana: 'Asia/Almaty', city: 'Almaty' }, // +06:00
  { iana: 'Asia/Yangon', city: 'Yangon' }, // +06:30
  { iana: 'Asia/Bangkok', city: 'Bangkok' }, // +07:00
  { iana: 'Asia/Shanghai', city: 'Shanghai' }, // +08:00
  { iana: 'Australia/Eucla', city: 'Eucla' }, // +08:45
  { iana: 'Asia/Tokyo', city: 'Tokyo' }, // +09:00
  { iana: 'Australia/Darwin', city: 'Darwin' }, // +09:30
  { iana: 'Australia/Sydney', city: 'Sydney' }, // +10:00
  { iana: 'Australia/Lord_Howe', city: 'Lord Howe' }, // +10:30
  { iana: 'Pacific/Guadalcanal', city: 'Honiara' }, // +11:00
  { iana: 'Pacific/Auckland', city: 'Auckland' }, // +12:00
  { iana: 'Pacific/Chatham', city: 'Chatham' }, // +12:45
  { iana: 'Pacific/Tongatapu', city: "Nuku'alofa" }, // +13:00
  { iana: 'Pacific/Kiritimati', city: 'Kiritimati' }, // +14:00
]

/**
 * Current UTC offset of an IANA zone, in minutes (east of UTC positive).
 * Computed via Intl from `at` (defaults to now), so it reflects DST.
 * Returns null if the zone is not a valid IANA id (Intl throws RangeError).
 */
function getOffsetMinutes(iana: string, at: Date = new Date()): number | null {
  try {
    // 'longOffset' yields e.g. "GMT+05:30" / "GMT" / "GMT-3"; parse it.
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: iana,
      timeZoneName: 'longOffset',
    }).formatToParts(at)
    const tzName = parts.find((p) => p.type === 'timeZoneName')?.value ?? ''
    const m = tzName.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/)
    if (!m) return 0 // "GMT" with no digits == UTC.
    // Regex groups are typed `string | undefined` under noUncheckedIndexedAccess
    // even though a successful match guarantees [1] and [2]. Coalesce to keep
    // the compiler happy; "0" is also a safe runtime default for [3].
    const sign = m[1] === '-' ? -1 : 1
    const hours = parseInt(m[2] ?? '0', 10)
    const minutes = parseInt(m[3] ?? '0', 10)
    return sign * (hours * 60 + minutes)
  } catch {
    return null
  }
}

/**
 * Format a UTC offset (in minutes) iOS-style:
 *   0      -> "UTC±0"
 *   +180   -> "UTC+3"
 *   -300   -> "UTC-5"
 *   +330   -> "UTC+5:30"
 *   +345   -> "UTC+5:45"
 * Minutes are shown only when non-zero. Sign uses a plain hyphen "-".
 */
export function formatUtcOffset(iana: string, at: Date = new Date()): string {
  const total = getOffsetMinutes(iana, at)
  if (total === null) return 'UTC' // unknown zone -> bare UTC, no offset.
  if (total === 0) return 'UTC\u00B10' // "UTC±0"
  const sign = total > 0 ? '+' : '-'
  const abs = Math.abs(total)
  const hours = Math.floor(abs / 60)
  const minutes = abs % 60
  const mm = minutes > 0 ? `:${String(minutes).padStart(2, '0')}` : ''
  return `UTC${sign}${hours}${mm}`
}

/** Build the iOS-style label "City UTC+offset" for a known city entry. */
function buildTimezoneLabel(iana: string, city: string, at: Date = new Date()): string {
  return `${city} ${formatUtcOffset(iana, at)}`
}

/**
 * Derive a display city from a raw IANA id when we have no curated city for
 * it: take the last "/" segment and turn underscores into spaces.
 *   "Asia/Novosibirsk"   -> "Novosibirsk"
 *   "America/Argentina/Buenos_Aires" -> "Buenos Aires"
 *   "UTC"                -> "UTC"
 */
function cityFromIana(iana: string): string {
  const last = iana.split('/').pop() ?? iana
  return last.replace(/_/g, ' ')
}

/**
 * Build a single { label, value } option for an arbitrary IANA zone, with a
 * dynamically generated label. Used by the onboarding picker to inject an
 * exotic auto-detected / profile zone that is not in the curated list, so the
 * user's real zone is shown and selectable instead of being silently dropped.
 */
export function makeTimezoneOption(iana: string): { label: string; value: string } {
  return { label: buildTimezoneLabel(iana, cityFromIana(iana)), value: iana }
}

// Curated options, computed once at module load, sorted by real offset
// (UTC-11 -> UTC+14). Same { label, value }[] shape as before.
export const TIMEZONE_OPTIONS: { label: string; value: string }[] = TIMEZONE_CITIES.map((z) => ({
  label: buildTimezoneLabel(z.iana, z.city),
  value: z.iana,
  _offset: getOffsetMinutes(z.iana) ?? 0,
}))
  .sort((a, b) => a._offset - b._offset)
  .map(({ label, value }) => ({ label, value }))

// -- Calendar taxonomy options (front-first, 10 directions, 2026-05-28) --
// direction / difficulty are required Practice fields (stored in
// data.taxonomy on the backend). Values MUST match the future backend
// allowed list once B-2 lands (handoff §9). See api/types.ts for the
// matching literal union and the migration plan.
// Shared by the master create/edit forms and the Calendar filter UI.

export interface DirectionOption {
  label: string
  value: PracticeDirection
}

export const DIRECTION_OPTIONS: DirectionOption[] = [
  { label: 'Медитация', value: 'meditation' },
  { label: 'Йога', value: 'yoga' },
  { label: 'Дыхательные практики', value: 'breathwork' },
  { label: 'Соматика', value: 'somatic' },
  { label: 'Тантра', value: 'tantra' },
  { label: 'Круги', value: 'circles' },
  { label: 'Саундхиллинг', value: 'sound_healing' },
  { label: 'Арт-практики', value: 'art' },
  { label: 'Нарративные практики', value: 'narrative' },
  { label: 'Движение', value: 'movement' },
]

export const DIFFICULTY_OPTIONS: { label: string; value: string }[] = [
  { label: 'Начальная', value: 'beginner' },
  { label: 'Средняя', value: 'medium' },
  { label: 'Высокая', value: 'high' },
]

export interface StyleOption {
  label: string
  value: string
}

// Style -> direction map. ONLY directions that have styles are keyed.
// Other directions (breathwork / somatic / tantra / sound_healing / art /
// narrative / movement) have NO styles — code branches must hide the style
// selector when STYLE_OPTIONS_BY_DIRECTION[direction] is undefined.
// Mirrors the future backend practice_allowed_styles with direction scoping
// (handoff §9 B-2).
export const STYLE_OPTIONS_BY_DIRECTION: Partial<Record<PracticeDirection, StyleOption[]>> = {
  meditation: [
    { label: 'Медитация молчания', value: 'silence' },
    { label: 'Медитация присутствия', value: 'presence' },
    { label: 'Звуковая медитация', value: 'sound' },
    { label: 'Даосская медитация', value: 'taoist' },
  ],
  yoga: [
    { label: 'Йога-нидра', value: 'nidra' },
    { label: 'Инь-йога', value: 'yin' },
    { label: 'Хатха-йога', value: 'hatha' },
    { label: 'Виньяса', value: 'vinyasa' },
    { label: 'Кундалини-йога', value: 'kundalini' },
    { label: 'Аштанга-йога', value: 'ashtanga' },
  ],
  circles: [
    { label: 'Женский круг', value: 'womens' },
    { label: 'Мужской круг', value: 'mens' },
    { label: 'Круг шеринга', value: 'sharing' },
  ],
}

/** Returns the style options for a given direction, or [] when the
 *  direction has no styles. */
export function stylesForDirection(direction: PracticeDirection | undefined | null): StyleOption[] {
  if (!direction) return []
  return STYLE_OPTIONS_BY_DIRECTION[direction] ?? []
}

/** True when the direction has at least one style — used by filter / forms
 *  to decide whether to render the "Вид практики" selector. */
export function directionHasStyles(direction: PracticeDirection | undefined | null): boolean {
  return stylesForDirection(direction).length > 0
}

/** Flat style value -> Russian label, derived from STYLE_OPTIONS_BY_DIRECTION
 *  (single source of truth). Use anywhere a style is held only as its raw
 *  value (e.g. a backend filter value) so it never renders untranslated.
 *  Falls back to the raw value for unknown keys at the call site. */
export const STYLE_LABEL: Record<string, string> = Object.fromEntries(
  Object.values(STYLE_OPTIONS_BY_DIRECTION)
    .flat()
    .map((opt) => [opt.value, opt.label]),
)

// -- Catalog-first options (T2 stage 2, 2026-07-15) -------------------------
//
// The backend now accepts a direction/style from the DB catalog OR this
// module's hardcoded lists (union, batch T2 stage 1). These two functions are
// the frontend's other half: build the OPTIONS a picker actually offers,
// catalog-first, falling back to the hardcoded consts above when the catalog
// is cold (not yet fetched) or unreachable (offline/error) -- same
// offline/error contract api/taxonomy.ts documents for its own consumers, so
// a failed fetch degrades to today's list, never to an empty picker.
// Callers fetch/cache the catalog themselves (methodTaxonomy.ts's
// ensureTaxonomyCatalog(), which "rides" the same shared cache
// MethodTaxonomyPicker/EditProfileView/admin screens already warm) and pass
// the result in -- these two functions are pure, no fetching of their own.
//
// A catalog row's `value` is NOT a member of the closed PracticeDirection
// union -- the cast mirrors the SAME tolerance MethodTaxonomyPicker.vue's own
// catalog-first options list already applies (`allDirectionOptions()`,
// `d.value as PracticeDirection`). Contained here and in that one other spot;
// PracticeDirection itself is NOT widened.

/** Direction options, catalog-first with a fallback to the hardcoded
 *  DIRECTION_OPTIONS when the catalog is cold or unreachable. */
export function catalogDirectionOptions(catalog: TaxonomyListResponse | null): DirectionOption[] {
  if (!catalog) return DIRECTION_OPTIONS
  return catalog.directions.map((d) => ({ value: d.value as PracticeDirection, label: d.label }))
}

/** Styles for one direction, catalog-first with a fallback to the hardcoded
 *  stylesForDirection() when the catalog is cold or unreachable. When the
 *  catalog IS warm but the direction isn't found in it (should not happen --
 *  the catalog is a superset of the hardcoded directions), returns [] rather
 *  than falling back, mirroring MethodTaxonomyPicker.vue's own
 *  catalogStylesForDirection(). */
export function catalogStylesForDirection(
  catalog: TaxonomyListResponse | null,
  direction: string | undefined | null,
): StyleOption[] {
  if (!direction) return []
  if (!catalog) return stylesForDirection(direction as PracticeDirection)
  const entry = catalog.directions.find((d) => d.value === direction)
  return entry ? (entry.styles ?? []).map((s) => ({ value: s.value, label: s.label })) : []
}
