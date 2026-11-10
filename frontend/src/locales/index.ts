// =============================================================================
// VELO Frontend -- i18n singleton (tz-i18n §4, phase 0; lazy zones FE-157)
// =============================================================================
//
// The ONE vue-i18n instance. Rules that keep the migration mechanical and
// safe (tz-i18n §5.1):
//   - legacy: false + globalInjection: true; components use useI18n() with
//     useScope: 'global' -- the default local scope has empty messages and
//     silently renders keys.
//   - The ru catalog carries the strings that were hardcoded verbatim, so
//     the ~3400 existing tests keep asserting the same rendered text.
//   - Brand text renders through the linked message @:brand -- the value
//     comes from INSTANCE.brand (passport), never hardcoded in messages.
//
// What loads when (FE-157):
//   - ru CORE is eager (in the main bundle): every domain file of the folder
//     except the zone catalogs below.
//   - ZONE catalogs (ZONE_CATALOGS: master.json, admin.json) load before a
//     route of their zone resolves -- the route declares them in
//     meta.catalogs, router/catalogs.ts awaits ensureCatalogs. A student
//     never downloads them.
//   - Other locales load on a switch (setLocale) or a warm-up (warmLocale,
//     the language switcher); until then fallbackLocale covers.
//   - timezones.json is DATA, not messages: utils/timezoneCities.ts reads it
//     with ?raw on the timezone screen; no t() key points into it.
//
// utils/ may import this module for getLocale()/the composer: it is a plain
// module, no Vue component context required (tz-i18n 0.3).
// =============================================================================

import { toRaw } from 'vue'
import { createI18n } from 'vue-i18n'

import { setRootLang } from '@/platform/dom'
import { INSTANCE, isSupportedLocale, SUPPORTED_LOCALES, type Locale } from '@/platform/instance'
import { SKIN_BRAND } from '@/platform/skin-brand.generated'

/** Catalog files that load with their zone's routes, not with the locale. */
export const ZONE_CATALOGS = ['master', 'admin'] as const
export type ZoneCatalog = (typeof ZONE_CATALOGS)[number]

type CatalogPart = 'core' | ZoneCatalog
type Messages = Record<string, unknown>
type CatalogModule = { default: Messages }

// Per-domain catalogs (tz-i18n §4.1): one FOLDER per locale, one FILE per
// domain. Adding a language = adding a folder; adding a domain = adding a
// file. The glob patterns are literals (Vite resolves them at build time),
// so their exclusions repeat ZONE_CATALOGS by hand -- catalogs.test.ts pins
// the two together. Keeping the ru zone files out of the eager glob is what
// puts them in chunks of their own.
const eagerDefault = import.meta.glob<CatalogModule>(
  ['./ru/*.json', '!./ru/master.json', '!./ru/admin.json', '!./ru/timezones.json'],
  { eager: true },
)
const lazyLoaders: Record<string, () => Promise<CatalogModule>> = {
  ...import.meta.glob<CatalogModule>(['./*/*.json', '!./ru/*.json', '!./*/timezones.json']),
  ...import.meta.glob<CatalogModule>(['./ru/master.json', './ru/admin.json']),
}

const ruCore: Messages = {}
for (const mod of Object.values(eagerDefault)) Object.assign(ruCore, mod.default)

/**
 * vue-i18n's built-in plural choice is English-shaped (`1 -> first form`,
 * `everything else -> last form`). Our catalogs write CLDR forms -- ru messages
 * and uk `one|few|many`, en `one|other` -- so the choice delegates to
 * Intl.PluralRules of the message's locale and maps the category onto the
 * form index (tz-i18n §4.4: the ONE plural mechanism):
 *   2-form messages: `one -> 0, every other category -> 1`
 *   3+form messages: `one -> 0, few -> 1, many/other -> 2`
 */
export function cldrPluralChoice(
  locale: string,
): (choice: number, choicesLength: number) => number {
  const rules = new Intl.PluralRules(locale)
  return (choice: number, choicesLength: number): number => {
    const category = rules.select(choice)
    if (choicesLength <= 2) return category === 'one' ? 0 : 1
    if (category === 'one') return 0
    if (category === 'few') return 1
    return 2
  }
}

// One entry per product locale, no more and no less: `satisfies` makes
// vue-tsc refuse both a missing locale and one outside SUPPORTED_LOCALES.
const PLURAL_RULES = {
  ru: cldrPluralChoice('ru'),
  en: cldrPluralChoice('en'),
  uk: cldrPluralChoice('uk'),
} satisfies Record<Locale, ReturnType<typeof cldrPluralChoice>>

// No `messages` in the options: the composed catalog goes in through
// setLocaleMessage right after -- with a dynamic (non-literal) schema this
// keeps createI18n's options and the composer types clean.
const i18n = createI18n({
  legacy: false,
  locale: INSTANCE.defaultLocale,
  fallbackLocale: INSTANCE.defaultLocale,
  pluralRules: PLURAL_RULES,
  globalInjection: true,
  missingWarn: import.meta.env.DEV,
  fallbackWarn: false,
})

// The brand word never lives in the catalogs (tz-i18n §7.2.3): messages
// reference it as the linked key @:brand, so every locale that gets messages
// gets the brand with them (mergeRuntimeMessages). The brand word of THIS
// build: a skin's displayName wins (tz-whitelabel §1 priority, skin > env);
// no skin -> the VITE_BRAND passport value.
const BRAND_MESSAGE = { brand: SKIN_BRAND ?? INSTANCE.brand } as const

// Instance overlays (applyInstanceOverrides), per locale, in the order they
// came. Kept so they can be merged again on top of every catalog load: a
// later core or zone load replaces whole root objects and would drop an
// overlay merged before it.
const instanceOverlays = new Map<string, Messages[]>()

/** Which parts of a locale's catalogs the composer holds. */
const appliedParts = new Map<string, Set<CatalogPart>>()
/** In-flight or finished fetches, keyed `${locale}/${part}`. */
const pendingParts = new Map<string, Promise<Messages>>()
/** Zones a route asked for so far; every later locale load brings them too. */
const requestedZones = new Set<ZoneCatalog>()

/** Brand, then the instance overlays, on top of a locale's catalogs. */
function mergeRuntimeMessages(locale: string): void {
  i18n.global.mergeLocaleMessage(locale, BRAND_MESSAGE)
  for (const overlay of instanceOverlays.get(locale) ?? []) {
    i18n.global.mergeLocaleMessage(locale, overlay)
  }
}

i18n.global.setLocaleMessage('ru', ruCore)
appliedParts.set('ru', new Set<CatalogPart>(['core']))
mergeRuntimeMessages('ru')
// A non-ru default locale starts aliased onto the ru catalog (brand
// included) so the first paint is never message-less; its own core catalog
// replaces the alias on the first load (appliedParts has no entry for it
// until then). For the golden build (default ru) this is a no-op.
if (INSTANCE.defaultLocale !== 'ru') i18n.global.setLocaleMessage(INSTANCE.defaultLocale, ruCore)

export default i18n

/**
 * The project-wide translator (tz-i18n convention): ONE import, no per-file
 * useI18n composition. `useI18n({ useScope: 'global' })` returns THIS same
 * composer, so files needing t write
 *   `import { t } from '@/locales'`
 * and templates call t() directly (script-setup bindings are exposed to the
 * template; globalInjection also provides $t for template-only cases).
 * Reactivity is the composer's own: every call reads the live locale ref,
 * so a locale switch re-renders.
 */
export const t = i18n.global.t

/** Active locale for non-component callers (Intl formatters, etc.). */
export function getLocale(): string {
  return i18n.global.locale.value
}

/**
 * Passport message overlays (tz-whitelabel §7.1): an instance may re-word
 * terminology without forking the base catalogs.
 *
 * @remarks
 * An overlay wins over the base catalogs for good: it is
 * merged again after every later catalog load of its locale (a locale
 * switch, a zone entry). A locale whose catalogs are not loaded yet gets
 * its overlay with them.
 */
export function applyInstanceOverrides(overrides: Partial<Record<string, Messages>>): void {
  for (const [locale, messages] of Object.entries(overrides)) {
    if (!messages) continue
    const overlay = messages
    instanceOverlays.set(locale, [...(instanceOverlays.get(locale) ?? []), overlay])
    if (appliedParts.get(locale)?.has('core')) i18n.global.mergeLocaleMessage(locale, overlay)
  }
}

// Boot hint (tz-i18n phase 5): the last locale the user CHOSE, persisted so
// a reopen renders in it immediately instead of flashing the default while
// the auth round-trip + catalog chunk load. Cleared on logout (a signed-out
// device shows the default locale). Guarded -- storage may be unavailable.
const LOCALE_HINT_KEY = 'velo.locale'
export function readLocaleHint(): string | null {
  try {
    return localStorage.getItem(LOCALE_HINT_KEY)
  } catch {
    return null
  }
}
export function clearLocaleHint(): void {
  try {
    localStorage.removeItem(LOCALE_HINT_KEY)
  } catch {
    /* storage unavailable -- the hint simply won't persist */
  }
}

function partOf(path: string): CatalogPart {
  const domain = path.slice(path.lastIndexOf('/') + 1, -'.json'.length)
  return (ZONE_CATALOGS as readonly string[]).includes(domain) ? (domain as ZoneCatalog) : 'core'
}

/** True when the locale has a core catalog to load (ru is always held). */
function hasCatalogs(locale: string): boolean {
  if (locale === 'ru') return true
  return Object.keys(lazyLoaders).some(
    (path) => path.startsWith(`./${locale}/`) && partOf(path) === 'core',
  )
}

/**
 * Fetch one part of a locale's catalogs, once: every file of the part loads
 * in PARALLEL (a sequential await waterfall here was the 1-2s dead switch
 * and the 5-10s late flip on reopen: tiny JSON chunks, one round-trip each,
 * serialized). A failed fetch is forgotten, so the next call retries.
 */
function fetchPart(locale: string, part: CatalogPart): Promise<Messages> {
  const id = `${locale}/${part}`
  const known = pendingParts.get(id)
  if (known) return known
  const loads = Object.entries(lazyLoaders)
    .filter(([path]) => path.startsWith(`./${locale}/`) && partOf(path) === part)
    .map(([, load]) => load())
  const pending = Promise.all(loads).then((modules) => {
    const messages: Messages = {}
    for (const mod of modules) Object.assign(messages, mod.default)
    return messages
  })
  pendingParts.set(id, pending)
  pending.catch(() => pendingParts.delete(id))
  return pending
}

/**
 * Put fetched parts into the composer: the core first -- it REPLACES the
 * locale's messages (and with them the ru alias a non-ru default starts
 * on) -- then each zone ROOT-wise, the same shallow spread over files the
 * eager catalog is composed with (no deep copy of the precompiled message
 * trees; key-audit guarantees the roots never collide). Brand and overlays
 * go on top again.
 */
function applyParts(locale: string, fetched: ReadonlyMap<CatalogPart, Messages>): void {
  const applied = appliedParts.get(locale) ?? new Set<CatalogPart>()
  const order = [...fetched.keys()].sort((a, b) => Number(b === 'core') - Number(a === 'core'))
  let changed = false
  for (const part of order) {
    // A concurrent load of the same locale may have applied it meanwhile.
    if (applied.has(part)) continue
    const base = part === 'core' ? {} : toRaw(i18n.global.getLocaleMessage(locale))
    i18n.global.setLocaleMessage(locale, { ...base, ...fetched.get(part) })
    applied.add(part)
    changed = true
  }
  appliedParts.set(locale, applied)
  if (changed) mergeRuntimeMessages(locale)
}

/**
 * Load and merge a locale's catalogs WITHOUT switching to it: its core plus
 * every zone a route has asked for so far.
 *
 * @remarks
 * Never assigns locale.value or touches the boot hint: a warm-up built on
 * setLocale switched through every available locale and left the app on
 * the LAST one (en) -- the "UI reverts to English by itself" report. A
 * locale with no folder is a no-op.
 */
export async function loadLocale(locale: string): Promise<void> {
  if (!isSupportedLocale(locale) || !hasCatalogs(locale)) return
  // Looped: a zone asked for while this fetch was in flight (a route entered
  // mid-switch) is loaded before returning, so setLocale never flips into a
  // locale that lacks it.
  for (;;) {
    const applied = appliedParts.get(locale)
    const missing = (['core', ...requestedZones] as CatalogPart[]).filter((p) => !applied?.has(p))
    if (missing.length === 0) return
    const messages = await Promise.all(missing.map((part) => fetchPart(locale, part)))
    applyParts(locale, new Map(missing.map((part, i) => [part, messages[i] as Messages])))
  }
}

/**
 * Merge the zone catalogs a route reads before it resolves
 * (router/catalogs.ts), for the active locale and the fallback locale.
 *
 * @remarks
 * The fallback locale loads the zone too: a translation may trail ru (the
 * key-audit parity report), and a fallback without the zone would show the
 * raw key path instead. Once asked for, a zone rides along with every later
 * locale load, so a switch inside the zone brings the zone's catalog of
 * the new locale with it.
 */
export async function ensureCatalogs(zones: readonly ZoneCatalog[]): Promise<void> {
  for (const zone of zones) requestedZones.add(zone)
  const locales = new Set([getLocale(), INSTANCE.defaultLocale])
  await Promise.all([...locales].map((locale) => loadLocale(locale)))
}

/**
 * Start loading a locale's catalogs in the background, without switching
 * (the language switcher: on its screen and on a row's finger-down). A
 * failure is dropped -- the real switch retries the fetch.
 */
export function warmLocale(locale: string): void {
  loadLocale(locale).catch(() => undefined)
}

/**
 * Switch the UI language: load the catalogs via loadLocale, then flip the
 * composer, the root lang, and the boot hint. A locale with no folder is a
 * no-op (fallback keeps rendering). The language switcher UI (tz-i18n
 * phase 5) only ever offers locales that have catalogs.
 */
export async function setLocale(locale: string): Promise<void> {
  if (!isSupportedLocale(locale)) return
  // Load BEFORE the same-locale exit: the current locale is not necessarily
  // a loaded one (a non-ru default starts aliased onto ru), so even a
  // no-flip call may still have chunks to fetch before it can render its
  // own text.
  await loadLocale(locale)
  // No catalog folder -> the core never applied: keep the current locale
  // rendering on fallback rather than switching into void.
  if (!appliedParts.get(locale)?.has('core')) return
  if (i18n.global.locale.value === locale) return
  i18n.global.locale.value = locale
  setRootLang(locale)
  try {
    localStorage.setItem(LOCALE_HINT_KEY, locale)
  } catch {
    /* storage unavailable -- the hint simply won't persist */
  }
}

/**
 * Locales that actually have catalog folders (default included), in
 * SUPPORTED_LOCALES order. The language switcher offers exactly these -- a
 * locale without a catalog would render fallback forever, and setLocale
 * no-ops on it. Today every product locale has a catalog (BE-188).
 */
export function availableLocales(): string[] {
  return SUPPORTED_LOCALES.filter((l) => l === INSTANCE.defaultLocale || hasCatalogs(l))
}

/**
 * Follow the user record: the server owns the language (User.language,
 * backend-normalized). Unknown/null values keep the current locale.
 * Called from App.vue whenever authStore.user changes.
 */
export function applyUserLanguage(language: string | null | undefined): void {
  if (isSupportedLocale(language)) void setLocale(language)
}
