// =============================================================================
// VELO Frontend -- Instance Passport Seams (tz-whitelabel §1; tz-i18n 0.5)
// =============================================================================
//
// The ONE place that reads instance-level values. Under the deploy machine
// (FE-129) the container's nginx renders /config.json from its environment
// at start, and launch.ts applies it here BEFORE the app module graph is
// imported; every seam reads the runtime value first, then the build-time
// VITE_* variables (local dev builds), then the golden defaults. A build
// with neither input is indistinguishable from the app as it ships now (the
// golden build). tz-whitelabel F1: all former direct import.meta.env read
// sites go through INSTANCE now.
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

// =============================================================================
// Runtime instance config (FE-129). The deploy machine renders /config.json
// from the container environment at start (nginx/config.json.template); the
// env names are primer.yaml's -- API_BASE_URL, TELEGRAM_BOT_URL,
// DEFAULT_LANGUAGE, LANGUAGES. The brand is NOT a start value: it is a skin
// property (brand.json displayName, materialized at build -- owner 09.11).
// launch.ts applies it before `import('./app')`,
// because i18n and the manifest read the snapshot fields below at module
// evaluation. An empty/absent value falls through to the build-time VITE_*
// variable and then to the golden default.
// =============================================================================

/** The /config.json the container's nginx renders at start (FE-129). */
export interface InstanceConfig {
  apiBaseUrl?: string
  telegramBotUrl?: string
  defaultLocale?: string
  /** Comma-separated locale codes, as the machine ships them (guide §2.5). */
  locales?: string
}

/**
 * The API base as the app uses it. Two domains (owner 09.11, primer.yaml
 * `domains: [frontend, api]`): the passport ships `domains.api` as a bare
 * HOST, so a value without a scheme gets `https://`; a trailing slash is
 * dropped (paths are joined as `${base}/api/...`). Empty stays empty -- the
 * same-origin path that local dev and the interim stand still use.
 *
 * @param value - the raw API_BASE_URL / VITE_API_BASE_URL value
 * @returns the absolute origin, or '' for same-origin
 */
export function normalizeApiBase(value: string | undefined): string {
  const raw = (value ?? '').trim()
  if (raw === '') return ''
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  return withScheme.replace(/\/+$/, '')
}

let runtimeConfig: InstanceConfig = {}

/** envsubst substitutes only variables that EXIST in the environment: an
 * unset one leaves its `${NAME}` placeholder in /config.json verbatim. A
 * placeholder is not a value -- treat it as empty (golden fallback). */
const UNRENDERED = /^\$\{[A-Z0-9_]+\}$/

/** Apply the runtime /config.json. Called from launch.ts, pre-app-import. */
export function applyInstanceConfig(config: InstanceConfig | null | undefined): void {
  const clean: InstanceConfig = {}
  for (const [key, value] of Object.entries(config ?? {})) {
    if (typeof value === 'string' && !UNRENDERED.test(value.trim())) {
      clean[key as keyof InstanceConfig] = value
    }
  }
  runtimeConfig = clean
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

/** Instance values as seen by this build. Defaults = the golden build. */
export const INSTANCE = {
  // tz-whitelabel §1 URL seams. Getters, not a snapshot: the live read keeps
  // the exact per-mount semantics the former inline reads had (views read
  // them in setup; vi.stubEnv in tests keeps working unchanged) -- and the
  // runtime config wins at access time for free.
  /** The API origin. Under the machine the API lives on its own domain
   * (`domains.api`, a bare host that gets `https://`); empty = same-origin, the
   * local-dev / interim path through this container's /api proxy. */
  get apiBaseUrl(): string {
    return normalizeApiBase(runtimeConfig.apiBaseUrl || import.meta.env.VITE_API_BASE_URL)
  },
  get telegramBotUrl(): string {
    return (
      runtimeConfig.telegramBotUrl ||
      import.meta.env.VITE_TELEGRAM_BOT_URL ||
      'https://telegram.me/veloappbot'
    )
  },
  // Identity fields are getters TOO -- not snapshots. launch.ts statically
  // imports this module, so a snapshot taken at evaluation would be computed
  // BEFORE prepareHost() applies the runtime config and would never see it.
  // Live reads are correct: the consumers (i18n's catalog setup, the manifest
  // is build-time) evaluate later, inside the dynamically imported app
  // graph -- after the config is in.
  // The brand is a skin property (owner 09.11): never read from the runtime
  // config -- only the build env the skin materializes, then the golden name.
  get brand(): string {
    return import.meta.env.VITE_BRAND || 'VELO'
  },
  get defaultLocale(): Locale {
    return parseLocale(runtimeConfig.defaultLocale || import.meta.env.VITE_DEFAULT_LOCALE, 'ru')
  },
  get locales(): Locale[] {
    return parseLocales(runtimeConfig.locales || import.meta.env.VITE_LOCALES)
  },
  // Feature composition is a PROJECT property (the edition), not an instance
  // value: it stays build-time -- PRIMER_EDITION is the machine's channel,
  // VITE_FEATURES the local-dev one (FE-130, FE-149 §3).
  features: parseFeatures(import.meta.env.VITE_FEATURES),
} as const
