// =============================================================================
// VELO Frontend -- Timezone cities (searchable picker source)
// =============================================================================
//
// City -> IANA zone list for the searchable timezone picker (profile settings).
// Europe-weighted on purpose: the app launches in Europe. From Russia only Moscow
// and Saint Petersburg (operator 2026-06-09); everything else is country capitals
// / major cities. The offset/time shown next to each city is computed live via
// Intl (DST-aware) in the picker -- NOT stored here, so this list never goes stale.
//
//   city -> RU display name
//   iana -> IANA zone id, exactly as the backend stores it
//   q    -> lowercase search haystack (RU + EN/translit synonyms); the picker
//           matches the typed query against `city` (lowercased) OR `q`.
//
// The full list comes from the BACKEND, not from the browser engine (BE-157):
// timezoneRows() adds every name of the backend's catalog to the curated rows
// below (composables/useTimezoneCatalog.ts). Engines disagree on how a zone is
// spelled -- V8 lists and resolves "Asia/Katmandu", JavaScriptCore returns a
// name as given -- while the backend stores one canonical spelling
// ("Asia/Kathmandu"). With the backend's names as rows, the row of the saved
// zone is found with ===, on every engine. Every curated `iana` must be such a
// canonical name: a curated row in an old spelling ("Europe/Kiev") would never
// match the saved value, which the backend stores as "Europe/Kyiv".
//
// The master create/edit forms keep their own compact TIMEZONE_OPTIONS (one per
// offset) -- see utils/practiceOptions.ts. This bigger list is for the city search.
// =============================================================================

// ?raw + JSON.parse: VueI18nPlugin precompiles every plain locales/**/*.json
// import into message ASTs; this seed is DATA, so its leaves must stay plain
// strings (a plain import renders picker rows as JSON dumps).
import citySeedRaw from '@/locales/ru/timezones.json?raw'

export interface TimezoneCity {
  city: string
  iana: string
  q: string
}

// The curated rows themselves live in the ru seed catalog
// (locales/ru/timezones.json -- same pattern as taxonomy.json's display seed):
// display names are DATA, not UI copy (tz-i18n §3.1 item 6 -- a non-ru UI
// needs a localized city catalog, backend param or seed per locale, not
// translation keys). The import keeps types + logic here, data there.
const citySeed = JSON.parse(citySeedRaw) as {
  curated?: TimezoneCity[]
  aliases?: TimezoneCity[]
}

// Famous cities that SHARE a zone with another city, so a search by their
// own name still resolves (e.g. Рио-де-Жанейро → America/Sao_Paulo).
const CURATED: TimezoneCity[] = citySeed.curated ?? []
const ALIASES: TimezoneCity[] = citySeed.aliases ?? []

/** The curated rows: shown first, and win over the catalog for their zones. */
export const CURATED_CITIES: readonly TimezoneCity[] = [...CURATED, ...ALIASES]

/** What timezoneRows() needs of the backend catalog (useTimezoneCatalog). */
export interface TimezoneRowSource {
  readonly names: readonly string[]
  readonly aliases: Readonly<Record<string, string>>
  readonly labels: Readonly<
    Record<string, { readonly city_ru: string | null; readonly country_ru: string | null }>
  >
}

function englishCity(iana: string): string {
  return (iana.split('/').pop() ?? iana).replace(/_/g, ' ')
}

/** Extra search words per stored name: every other spelling the backend
 * accepts for it ("katmandu", "kiev") and its Russian CLDR city and country
 * ("катманду", "непал"). */
function searchWords(catalog: TimezoneRowSource | null): Map<string, string[]> {
  const words = new Map<string, string[]>()
  const add = (name: string, ...more: (string | null)[]) => {
    const list = words.get(name) ?? []
    for (const w of more) if (w) list.push(w.toLowerCase())
    words.set(name, list)
  }
  if (!catalog) return words
  for (const [spelling, stored] of Object.entries(catalog.aliases)) {
    add(stored, spelling, englishCity(spelling))
  }
  for (const [name, label] of Object.entries(catalog.labels)) {
    add(name, label.city_ru, label.country_ru)
  }
  return words
}

function withWords(q: string, words: string[] | undefined): string {
  return words?.length ? `${q} ${words.join(' ')}` : q
}

/**
 * The picker's rows: the curated ones, then every catalog name they do not
 * cover (Russian CLDR caption where there is one, else the English city of the
 * id; `Etc/*` and `UTC` are not places and get no row). The SAVED zone is
 * always a row -- also while the catalog loads or after it failed to load: the
 * value is in the profile, so the backend stored it, so it is canonical.
 */
export function timezoneRows(catalog: TimezoneRowSource | null, saved: string): TimezoneCity[] {
  const words = searchWords(catalog)
  const rows: TimezoneCity[] = CURATED_CITIES.map((c) => ({
    ...c,
    q: withWords(c.q, words.get(c.iana)),
  }))
  const covered = new Set(rows.map((c) => c.iana))
  const row = (iana: string): TimezoneCity => {
    const city = englishCity(iana)
    return {
      city: catalog?.labels[iana]?.city_ru ?? city,
      iana,
      q: withWords(`${city} ${iana}`.toLowerCase(), words.get(iana)),
    }
  }
  for (const iana of catalog?.names ?? []) {
    if (covered.has(iana) || iana.startsWith('Etc/') || iana === 'UTC') continue
    covered.add(iana)
    rows.push(row(iana))
  }
  if (saved && !covered.has(saved)) rows.unshift(row(saved))
  return rows
}
