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
// Per-domain catalogs (tz-i18n §4.1): one FOLDER per locale, one FILE per
// domain, composed generically below. Adding a language = adding a folder;
// adding a domain = adding a file. No per-language import chains.
// Non-default locales reuse the same folders via dynamic import in
// setLocale (phase 4 lazy chunks).
// Eager today (the default locale must be in the main bundle anyway);
// phase 4 flips this to lazy per-locale dynamic imports over the SAME glob.
const catalogs = import.meta.glob('./*/*.json', { eager: true })

const LOCALE_MESSAGES: Record<string, Record<string, unknown>> = {}
for (const [path, mod] of Object.entries(catalogs)) {
  // './ru/common.json' -> locale 'ru'
  const locale = path.split('/')[1]
  if (!locale) continue
  LOCALE_MESSAGES[locale] = {
    ...(LOCALE_MESSAGES[locale] ?? {}),
    ...(mod as { default: Record<string, unknown> }).default,
  }
}

export const ru = LOCALE_MESSAGES[INSTANCE.defaultLocale] ?? LOCALE_MESSAGES.ru ?? {}

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
i18n.global.setLocaleMessage(INSTANCE.defaultLocale, ru)

i18n.global.mergeLocaleMessage(INSTANCE.defaultLocale, { brand: INSTANCE.brand })

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

const loadedLocales = new Set<string>(['ru'])

/**
 * Switch the UI language. Without a merged catalog for the requested locale
 * this is a no-op (fallback keeps rendering); the language switcher UI
 * (tz-i18n phase 5) only ever offers locales that have catalogs.
 */
export function setLocale(locale: string): void {
  if (!isSupportedLocale(locale) || locale === i18n.global.locale.value) return
  if (!loadedLocales.has(locale)) {
    const messages = LOCALE_MESSAGES[locale]
    if (!messages) return
    i18n.global.setLocaleMessage(locale, messages)
    loadedLocales.add(locale)
  }
  i18n.global.locale.value = locale
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
