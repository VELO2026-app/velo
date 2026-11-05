// =============================================================================
// VELO Frontend -- Instance Passport Seams (tz-whitelabel §1; tz-i18n 0.5)
// =============================================================================
//
// The ONE place that reads instance-level VITE_* values off the build.
// Every seam carries today's behavior as its default, so a build without a
// passport is indistinguishable from the app as it ships now (the golden
// build). tz-whitelabel F1: all seven former import.meta.env read sites
// (5x VITE_API_BASE_URL, 2x VITE_TELEGRAM_BOT_URL) go through INSTANCE now.
//
// The locale set is the product's languages -- the same set as the backend's
// (backend core/i18n.py SUPPORTED_LANGUAGES: en, ru, uk; BE-188), and exactly
// the catalogs in src/locales/. User.language is the source of truth the UI
// follows (locales/index.ts).
// =============================================================================

/** The product's locale codes (the backend's SUPPORTED_LANGUAGES, same set). */
export const SUPPORTED_LOCALES = ['ru', 'en', 'uk'] as const

/** One supported locale code. */
export type Locale = (typeof SUPPORTED_LOCALES)[number]

/** Whether the value is one of the supported locale codes. */
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

/** Whether a parsed feature set enables the named module. */
export function hasFeature(features: FeatureSet, name: string): boolean {
  return features.all || features.enabled.has(name)
}

/** Instance passport as seen by this build. Defaults = the golden build. */
export const INSTANCE = {
  // tz-whitelabel §1 URL seams. Getters, not a snapshot: production replaces
  // import.meta.env statically either way, and the live read keeps the exact
  // per-mount semantics the former inline reads had (views read them in
  // setup; vi.stubEnv in tests keeps working unchanged).
  /** tz-whitelabel §1: empty = same-origin (Nginx proxies /api/* in prod). */
  get apiBaseUrl(): string {
    return import.meta.env.VITE_API_BASE_URL || ''
  },
  get telegramBotUrl(): string {
    return import.meta.env.VITE_TELEGRAM_BOT_URL || 'https://telegram.me/veloappbot'
  },
  brand: import.meta.env.VITE_BRAND ?? 'VELO',
  defaultLocale: parseLocale(import.meta.env.VITE_DEFAULT_LOCALE, 'ru'),
  locales: parseLocales(import.meta.env.VITE_LOCALES),
  features: parseFeatures(import.meta.env.VITE_FEATURES),
} as const
