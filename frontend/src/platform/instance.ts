// =============================================================================
// VELO Frontend -- Instance Passport Seams (tz-whitelabel §1; tz-i18n 0.5)
// =============================================================================
//
// The ONE place that reads instance-level VITE_* values off the build.
// Every seam carries today's behavior as its default, so a build without a
// passport is indistinguishable from the app as it ships now (the golden
// build). API base URL and the bot URL join here in tz-whitelabel F1; until
// then their existing import.meta.env read sites stay untouched.
//
// The locale set mirrors what the backend normalizes Telegram's
// language_code to (backend auth/service.py normalize_language: en/de/es/ru);
// User.language is the source of truth the UI follows (locales/index.ts).
// =============================================================================

export const SUPPORTED_LOCALES = ['ru', 'en', 'uk', 'de', 'es'] as const

export type Locale = (typeof SUPPORTED_LOCALES)[number]

export function isSupportedLocale(value: string | null | undefined): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value ?? '')
}

function parseLocale(value: string | undefined, fallback: Locale): Locale {
  return isSupportedLocale(value) ? value : fallback
}

function parseLocales(value: string | undefined): Locale[] {
  const requested = (value ?? 'ru').split(',').map((code) => code.trim())
  const known = requested.filter(isSupportedLocale)
  return known.length > 0 ? known : ['ru']
}

/**
 * Enabled modules of this instance: absent/empty/'full' means everything;
 * otherwise a comma list of module namespaces ('payments', 'ai', ...).
 * Unknown names simply never match a module id (F3 consumes this,
 * tz-whitelabel §4).
 */
export type FeatureSet =
  { readonly all: true } | { readonly all: false; readonly enabled: ReadonlySet<string> }

function parseFeatures(value: string | undefined): FeatureSet {
  const list = (value ?? 'full').trim()
  if (list === '' || list === 'full') return { all: true }
  return { all: false, enabled: new Set(list.split(',').map((name) => name.trim())) }
}

export function hasFeature(features: FeatureSet, name: string): boolean {
  return features.all || features.enabled.has(name)
}

/** Instance passport as seen by this build. Defaults = the golden build. */
export const INSTANCE = {
  brand: import.meta.env.VITE_BRAND ?? 'VELO',
  defaultLocale: parseLocale(import.meta.env.VITE_DEFAULT_LOCALE, 'ru'),
  locales: parseLocales(import.meta.env.VITE_LOCALES),
  features: parseFeatures(import.meta.env.VITE_FEATURES),
} as const
