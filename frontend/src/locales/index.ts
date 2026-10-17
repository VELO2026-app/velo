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
import { INSTANCE, isSupportedLocale } from '@/platform/instance'
import ru from './ru.json'

/**
 * vue-i18n's built-in plural choice is English-shaped (1 -> first form,
 * everything else -> last form). Our catalogs write CLDR forms -- ru messages
 * `one|few|many`, en/de/es `one|other` -- so the choice delegates to
 * Intl.PluralRules of the message's locale and maps the category onto the
 * form index (tz-i18n §4.4: the ONE plural mechanism):
 *   2-form messages: one -> 0, every other category -> 1
 *   3+form messages: one -> 0, few -> 1, many/other -> 2
 * (zero/two are unused by our catalogs.)
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
  de: cldrPluralChoice('de'),
  es: cldrPluralChoice('es'),
}

const i18n = createI18n({
  legacy: false,
  locale: INSTANCE.defaultLocale,
  fallbackLocale: INSTANCE.defaultLocale,
  messages: { ru },
  pluralRules: PLURAL_RULES,
  globalInjection: true,
  // A hardcoded→key miss announces itself in dev; in prod it silently falls
  // back to the default locale instead of littering the console.
  missingWarn: import.meta.env.DEV,
  fallbackWarn: false,
})

// The brand as a message: every catalog can inline it with the linked form
// `@:brand` -- no per-call params, one source of truth (the passport).
i18n.global.mergeLocaleMessage(INSTANCE.defaultLocale, { brand: INSTANCE.brand })

export default i18n

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

/**
 * Locale chunks beyond the default load lazily (tz-i18n §4.1). Fill as the
 * phase-4 catalogs land: { en: () => import('./en.json'), ... }
 */
const LOCALE_LOADERS: Partial<Record<string, () => Promise<Record<string, unknown>>>> = {}

const loadedLocales = new Set<string>(['ru'])

/**
 * Switch the UI language. Without a merged catalog for the requested locale
 * this is a no-op (fallback keeps rendering); the language switcher UI
 * (tz-i18n phase 5) only ever offers locales that have catalogs.
 */
export async function setLocale(locale: string): Promise<void> {
  if (!isSupportedLocale(locale) || locale === i18n.global.locale.value) return
  if (!loadedLocales.has(locale)) {
    const loader = LOCALE_LOADERS[locale]
    if (!loader) return
    // createI18n narrows its schema to the seed catalog's literal shape; a
    // lazily loaded catalog is the same bag of namespaces by contract.
    i18n.global.setLocaleMessage(locale, (await loader()) as typeof ru)
    loadedLocales.add(locale)
  }
  i18n.global.locale.value = locale as 'ru'
  setRootLang(locale)
}

/**
 * Follow the user record: the server owns the language (User.language,
 * backend-normalized). Unknown/null values keep the current locale.
 * Called from App.vue whenever authStore.user changes.
 */
export function applyUserLanguage(language: string | null | undefined): void {
  if (isSupportedLocale(language)) void setLocale(language)
}
