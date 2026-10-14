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

export interface TimezoneCity {
  city: string
  iana: string
  q: string
}

// Curated, RU-named popular cities (Europe-weighted, nice names + search aliases).
// These sit at the TOP of the list and take precedence over the generated zones.
const CURATED: TimezoneCity[] = [
  // ── Россия (только Москва + Санкт-Петербург) ──
  { city: 'Москва', iana: 'Europe/Moscow', q: 'moscow moskva' },
  { city: 'Санкт-Петербург', iana: 'Europe/Moscow', q: 'spb piter saint petersburg sankt' },

  // ── Великобритания / Ирландия ──
  { city: 'Лондон', iana: 'Europe/London', q: 'london' },
  { city: 'Манчестер', iana: 'Europe/London', q: 'manchester' },
  { city: 'Эдинбург', iana: 'Europe/London', q: 'edinburgh' },
  { city: 'Дублин', iana: 'Europe/Dublin', q: 'dublin' },

  // ── Франция ──
  { city: 'Париж', iana: 'Europe/Paris', q: 'paris' },
  { city: 'Лион', iana: 'Europe/Paris', q: 'lyon' },
  { city: 'Марсель', iana: 'Europe/Paris', q: 'marseille' },
  { city: 'Ницца', iana: 'Europe/Paris', q: 'nice nizza' },

  // ── Германия ──
  { city: 'Берлин', iana: 'Europe/Berlin', q: 'berlin' },
  { city: 'Мюнхен', iana: 'Europe/Berlin', q: 'munich munchen muenchen' },
  { city: 'Франкфурт', iana: 'Europe/Berlin', q: 'frankfurt' },
  { city: 'Гамбург', iana: 'Europe/Berlin', q: 'hamburg' },
  { city: 'Кёльн', iana: 'Europe/Berlin', q: 'cologne koln koeln' },

  // ── Бенилюкс ──
  { city: 'Амстердам', iana: 'Europe/Amsterdam', q: 'amsterdam' },
  { city: 'Роттердам', iana: 'Europe/Amsterdam', q: 'rotterdam' },
  { city: 'Брюссель', iana: 'Europe/Brussels', q: 'brussels bruxelles' },
  { city: 'Люксембург', iana: 'Europe/Luxembourg', q: 'luxembourg' },

  // ── Швейцария / Австрия ──
  { city: 'Цюрих', iana: 'Europe/Zurich', q: 'zurich' },
  { city: 'Женева', iana: 'Europe/Zurich', q: 'geneva geneve' },
  { city: 'Берн', iana: 'Europe/Zurich', q: 'bern' },
  { city: 'Вена', iana: 'Europe/Vienna', q: 'vienna wien' },

  // ── Испания / Португалия ──
  { city: 'Мадрид', iana: 'Europe/Madrid', q: 'madrid' },
  { city: 'Барселона', iana: 'Europe/Madrid', q: 'barcelona' },
  { city: 'Валенсия', iana: 'Europe/Madrid', q: 'valencia' },
  { city: 'Севилья', iana: 'Europe/Madrid', q: 'seville sevilla' },
  { city: 'Лиссабон', iana: 'Europe/Lisbon', q: 'lisbon lisboa' },
  { city: 'Порту', iana: 'Europe/Lisbon', q: 'porto oporto' },

  // ── Италия ──
  { city: 'Рим', iana: 'Europe/Rome', q: 'rome roma' },
  { city: 'Милан', iana: 'Europe/Rome', q: 'milan milano' },
  { city: 'Неаполь', iana: 'Europe/Rome', q: 'naples napoli' },
  { city: 'Флоренция', iana: 'Europe/Rome', q: 'florence firenze' },
  { city: 'Венеция', iana: 'Europe/Rome', q: 'venice venezia' },

  // ── Северная Европа ──
  { city: 'Стокгольм', iana: 'Europe/Stockholm', q: 'stockholm' },
  { city: 'Гётеборг', iana: 'Europe/Stockholm', q: 'gothenburg goteborg' },
  { city: 'Осло', iana: 'Europe/Oslo', q: 'oslo' },
  { city: 'Копенгаген', iana: 'Europe/Copenhagen', q: 'copenhagen kobenhavn' },
  { city: 'Хельсинки', iana: 'Europe/Helsinki', q: 'helsinki' },
  { city: 'Рейкьявик', iana: 'Atlantic/Reykjavik', q: 'reykjavik' },
  { city: 'Таллин', iana: 'Europe/Tallinn', q: 'tallinn' },
  { city: 'Рига', iana: 'Europe/Riga', q: 'riga' },
  { city: 'Вильнюс', iana: 'Europe/Vilnius', q: 'vilnius' },

  // ── Центральная / Восточная Европа ──
  { city: 'Варшава', iana: 'Europe/Warsaw', q: 'warsaw warszawa' },
  { city: 'Краков', iana: 'Europe/Warsaw', q: 'krakow cracow' },
  { city: 'Прага', iana: 'Europe/Prague', q: 'prague praha' },
  { city: 'Братислава', iana: 'Europe/Bratislava', q: 'bratislava' },
  { city: 'Будапешт', iana: 'Europe/Budapest', q: 'budapest' },
  { city: 'Бухарест', iana: 'Europe/Bucharest', q: 'bucharest bucuresti' },
  { city: 'София', iana: 'Europe/Sofia', q: 'sofia' },
  { city: 'Афины', iana: 'Europe/Athens', q: 'athens athina' },
  { city: 'Загреб', iana: 'Europe/Zagreb', q: 'zagreb' },
  { city: 'Любляна', iana: 'Europe/Ljubljana', q: 'ljubljana' },
  { city: 'Белград', iana: 'Europe/Belgrade', q: 'belgrade beograd' },
  { city: 'Сараево', iana: 'Europe/Sarajevo', q: 'sarajevo' },
  { city: 'Кишинёв', iana: 'Europe/Chisinau', q: 'chisinau kishinev' },
  { city: 'Киев', iana: 'Europe/Kyiv', q: 'kyiv kiev' },
  { city: 'Минск', iana: 'Europe/Minsk', q: 'minsk' },

  // ── Турция / Кавказ / Ближний Восток ──
  { city: 'Стамбул', iana: 'Europe/Istanbul', q: 'istanbul' },
  { city: 'Анкара', iana: 'Europe/Istanbul', q: 'ankara' },
  { city: 'Тбилиси', iana: 'Asia/Tbilisi', q: 'tbilisi' },
  { city: 'Ереван', iana: 'Asia/Yerevan', q: 'yerevan' },
  { city: 'Баку', iana: 'Asia/Baku', q: 'baku' },
  { city: 'Дубай', iana: 'Asia/Dubai', q: 'dubai' },
  { city: 'Абу-Даби', iana: 'Asia/Dubai', q: 'abu dhabi' },
  { city: 'Доха', iana: 'Asia/Qatar', q: 'doha' },
  { city: 'Эр-Рияд', iana: 'Asia/Riyadh', q: 'riyadh' },
  { city: 'Тель-Авив', iana: 'Asia/Jerusalem', q: 'tel aviv' },
  { city: 'Иерусалим', iana: 'Asia/Jerusalem', q: 'jerusalem' },

  // ── Центральная / Южная / Восточная Азия ──
  { city: 'Алматы', iana: 'Asia/Almaty', q: 'almaty' },
  { city: 'Астана', iana: 'Asia/Almaty', q: 'astana nur sultan' },
  { city: 'Ташкент', iana: 'Asia/Tashkent', q: 'tashkent' },
  { city: 'Нью-Дели', iana: 'Asia/Kolkata', q: 'delhi new delhi' },
  { city: 'Мумбаи', iana: 'Asia/Kolkata', q: 'mumbai bombay' },
  { city: 'Бангкок', iana: 'Asia/Bangkok', q: 'bangkok' },
  { city: 'Сингапур', iana: 'Asia/Singapore', q: 'singapore' },
  { city: 'Гонконг', iana: 'Asia/Hong_Kong', q: 'hong kong hongkong' },
  { city: 'Пекин', iana: 'Asia/Shanghai', q: 'beijing peking' },
  { city: 'Шанхай', iana: 'Asia/Shanghai', q: 'shanghai' },
  { city: 'Сеул', iana: 'Asia/Seoul', q: 'seoul' },
  { city: 'Токио', iana: 'Asia/Tokyo', q: 'tokyo' },
  { city: 'Джакарта', iana: 'Asia/Jakarta', q: 'jakarta' },

  // ── Африка ──
  { city: 'Каир', iana: 'Africa/Cairo', q: 'cairo' },
  { city: 'Йоханнесбург', iana: 'Africa/Johannesburg', q: 'johannesburg' },
  { city: 'Найроби', iana: 'Africa/Nairobi', q: 'nairobi' },
  { city: 'Лагос', iana: 'Africa/Lagos', q: 'lagos' },

  // ── Северная Америка ──
  { city: 'Нью-Йорк', iana: 'America/New_York', q: 'new york nyc' },
  { city: 'Вашингтон', iana: 'America/New_York', q: 'washington dc' },
  { city: 'Торонто', iana: 'America/Toronto', q: 'toronto' },
  { city: 'Чикаго', iana: 'America/Chicago', q: 'chicago' },
  { city: 'Денвер', iana: 'America/Denver', q: 'denver' },
  { city: 'Лос-Анджелес', iana: 'America/Los_Angeles', q: 'los angeles la' },
  { city: 'Сан-Франциско', iana: 'America/Los_Angeles', q: 'san francisco sf' },
  { city: 'Мехико', iana: 'America/Mexico_City', q: 'mexico city' },

  // ── Южная Америка ──
  { city: 'Богота', iana: 'America/Bogota', q: 'bogota' },
  { city: 'Лима', iana: 'America/Lima', q: 'lima' },
  { city: 'Сан-Паулу', iana: 'America/Sao_Paulo', q: 'sao paulo' },
  { city: 'Буэнос-Айрес', iana: 'America/Argentina/Buenos_Aires', q: 'buenos aires' },
  { city: 'Сантьяго', iana: 'America/Santiago', q: 'santiago' },

  // ── Океания ──
  { city: 'Сидней', iana: 'Australia/Sydney', q: 'sydney' },
  { city: 'Мельбурн', iana: 'Australia/Melbourne', q: 'melbourne' },
  { city: 'Перт', iana: 'Australia/Perth', q: 'perth' },
  { city: 'Окленд', iana: 'Pacific/Auckland', q: 'auckland' },
  { city: 'Веллингтон', iana: 'Pacific/Auckland', q: 'wellington' },
]

// Famous cities that SHARE a zone with another city, so a search by their own
// name still resolves (e.g. Рио-де-Жанейро → America/Sao_Paulo). Extend as needed.
const ALIASES: TimezoneCity[] = [
  { city: 'Рио-де-Жанейро', iana: 'America/Sao_Paulo', q: 'rio de janeiro rio-de-janeiro rio' },
]

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
