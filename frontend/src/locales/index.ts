// =============================================================================
// VELO Frontend -- i18n singleton (tz-i18n §4, phase 0)
// =============================================================================
//
// The ONE vue-i18n instance. Rules that keep the migration mechanical and
// safe (tz-i18n §5.1):
//   - legacy: false + globalInjection: true; components use useI18n() with
//     useScope: 'global' -- the default local scope has empty messages and
//     silently renders keys.
//   - The ru catalog carries the strings that were hardcoded verbatim, so
//     the ~3400 existing tests keep asserting the same rendered text.
//   - Locale chunks beyond ru load lazily (§4.1); until a catalog is merged,
//     setLocale keeps the current locale and fallbackLocale covers.
//   - Brand text renders through the linked message @:brand -- the value
//     comes from INSTANCE.brand (passport), never hardcoded in messages.
//
// utils/ may import this module for getLocale()/the composer: it is a plain
// module, no Vue component context required (tz-i18n 0.3).
// =============================================================================

import { createI18n } from 'vue-i18n'

import { setRootLang } from '@/platform/dom'
import { INSTANCE, isSupportedLocale, SUPPORTED_LOCALES } from '@/platform/instance'
import { SKIN_BRAND } from '@/platform/skin-brand.generated'
// Per-domain catalogs (tz-i18n §4.1): one FOLDER per locale, one FILE per
// domain. Adding a language = adding a folder; adding a domain = adding a
// file. No per-language import chains.
// The DEFAULT locale is eager (it must be in the main bundle); every other
// locale is a set of lazy loaders over the same glob, merged into the
// instance on first setLocale (phase 4 lazy chunks -- the bundle carries
// only ru, non-default locales pay one chunk per locale on switch).
const eagerDefault = import.meta.glob('./ru/*.json', { eager: true })
const lazyLoaders = import.meta.glob('./*/*.json')

const ruCatalog: Record<string, unknown> = {}
for (const mod of Object.values(eagerDefault)) {
  Object.assign(ruCatalog, (mod as { default: Record<string, unknown> }).default)
}

export const ru = ruCatalog

/**
 * vue-i18n's built-in plural choice is English-shaped (1 -> first form,
 * everything else -> last form). Our catalogs write CLDR forms -- ru messages
 * `one|few|many`, en/de/es `one|other` -- so the choice delegates to
 * Intl.PluralRules of the message's locale and maps the category onto the
 * form index (tz-i18n §4.4: the ONE plural mechanism):
 *   2-form messages: one -> 0, every other category -> 1
 *   3+form messages: one -> 0, few -> 1, many/other -> 2
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

const PLURAL_RULES = {
  ru: cldrPluralChoice('ru'),
  en: cldrPluralChoice('en'),
  uk: cldrPluralChoice('uk'),
  de: cldrPluralChoice('de'),
  es: cldrPluralChoice('es'),
}

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
i18n.global.setLocaleMessage('ru', ru)
// A non-ru default locale starts aliased onto the ru catalog so the first
// paint is never message-less; loadLocale replaces the alias with the real
// chunks on first switch. For the golden build (default ru) this is a no-op.
i18n.global.setLocaleMessage(INSTANCE.defaultLocale, ru)

// The brand word never lives in the catalogs (tz-i18n §7.2.3, and this
// file's own header rule): messages reference it as the linked key @:brand. Linked keys do NOT fall back across
// locales, so the merge must reach EVERY locale, not just the default -- an
// en message linking @:brand with brand merged only into ru renders an empty
// word. Every locale that gets messages gets the brand with them.
// The brand word of THIS build: a skin's displayName wins (tz-whitelabel §1
// priority, skin > env); no skin -> the VITE_BRAND passport value.
const BRAND_MESSAGE = { brand: SKIN_BRAND ?? INSTANCE.brand } as const
i18n.global.mergeLocaleMessage('ru', BRAND_MESSAGE)
i18n.global.mergeLocaleMessage(INSTANCE.defaultLocale, BRAND_MESSAGE)

export default i18n

/**
 * The project-wide translator (tz-i18n convention): ONE import, no per-file
 * useI18n composition. useI18n({ useScope: 'global' }) returns THIS same
 * composer, so files needing t write
 *   import { t } from '@/locales'
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
 * terminology without forking the base catalogs. Deploy-side wiring lands
 * with the passport; the seam exists from day one so overlay keys are a
 * runtime merge, never a catalog fork.
 */
export function applyInstanceOverrides(
  overrides: Partial<Record<string, Record<string, unknown>>>,
): void {
  for (const [locale, messages] of Object.entries(overrides)) {
    i18n.global.mergeLocaleMessage(locale, messages)
  }
}

// Seeded with 'ru' -- the only catalog the main bundle actually carries
// (eager). INSTANCE.defaultLocale is NOT implicitly loaded: for a non-ru
// default, line 84 above is just a fallback alias onto ru, and seeding it
// here would make loadLocale(defaultLocale) early-return forever -- that
// locale would render Russian text with no way to load its real catalog.
const loadedLocales = new Set<string>(['ru'])

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

/**
 * Load and merge a locale's catalog chunks WITHOUT switching to it -- the
 * idle prefetch (App.vue) warms the chunk cache this way so a later switch
 * is a same-frame flip. loadLocale must never assign locale.value or touch
 * the boot hint: a prefetch built on setLocale switched through every
 * available locale and left the app on the LAST one (en) two seconds after
 * every mount -- the "UI reverts to English by itself" report. Chunks load
 * PARALLEL (a sequential await waterfall here was the 1-2s dead switch and
 * the 5-10s late flip on reopen: ~20 tiny JSON chunks, one round-trip each,
 * serialized). A locale with no folder is a no-op.
 */
export async function loadLocale(locale: string): Promise<void> {
  if (!isSupportedLocale(locale) || loadedLocales.has(locale)) return
  const prefix = `./${locale}/`
  const loaders = Object.entries(lazyLoaders)
    .filter(([p]) => p.startsWith(prefix))
    .map(([, loader]) => loader)
  if (loaders.length === 0) return
  const modules = (await Promise.all(loaders.map((load) => load()))) as unknown as {
    default: Record<string, unknown>
  }[]
  const messages: Record<string, unknown> = {}
  for (const mod of modules) Object.assign(messages, mod.default)

  i18n.global.setLocaleMessage(locale, messages)
  i18n.global.mergeLocaleMessage(locale, BRAND_MESSAGE)
  loadedLocales.add(locale)
}

/**
 * Switch the UI language: warm the catalog via loadLocale, then flip the
 * composer, the root lang, and the boot hint. A locale with no folder is a
 * no-op (fallback keeps rendering). The language switcher UI (tz-i18n
 * phase 5) only ever offers locales that have catalogs.
 */
export async function setLocale(locale: string): Promise<void> {
  if (!isSupportedLocale(locale)) return
  // Load BEFORE the same-locale exit: the current locale is not necessarily
  // a loaded one (a non-ru default starts aliased onto ru -- see the
  // loadedLocales seeding), so even a no-flip call may still have chunks to
  // fetch before it can render its own text.
  await loadLocale(locale)
  // No catalog folder -> loadedLocales never gained the locale: keep the
  // current locale rendering on fallback rather than switching into void.
  if (!loadedLocales.has(locale)) return
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
 * no-ops on it. The list grows automatically when de/es catalogs land.
 */
export function availableLocales(): string[] {
  const withCatalogs = new Set(
    Object.keys(lazyLoaders)
      .map((p) => p.split('/')[1])
      .filter((l): l is string => Boolean(l)),
  )
  withCatalogs.add(INSTANCE.defaultLocale)
  return SUPPORTED_LOCALES.filter((l) => withCatalogs.has(l))
}

/**
 * Follow the user record: the server owns the language (User.language,
 * backend-normalized). Unknown/null values keep the current locale.
 * Called from App.vue whenever authStore.user changes.
 */
export function applyUserLanguage(language: string | null | undefined): void {
  if (isSupportedLocale(language)) void setLocale(language)
}
