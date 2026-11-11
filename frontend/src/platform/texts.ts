// =============================================================================
// VELO Frontend -- instance text overlays at start (FE-133, protocol §4.5)
// =============================================================================
// The `texts` slot of primer.yaml (apply: runtime) mounts the package's ui/
// folder into the frontend container at /srv/texts/ui; the container's nginx
// serves it as /texts/ui/<locale>.json (nginx.conf). Before the first render
// the app fetches one file per instance locale and hands the overrides to
// applyInstanceOverrides() -- a runtime merge over the base catalogs, never a
// fork of them.
//
// Same stance as loadInstanceConfig (launch.ts): every non-JSON outcome is
// the golden path, not an error. No package mounted = 404; local dev = the
// dev server answers unknown paths with index.html (text/html). Both leave
// the built-in strings alone. A broken file is the machine's finding
// (validate-texts), never a reason to crash a screen.
// =============================================================================

import { applyInstanceOverrides } from '@/locales'
import { reportError } from '@/platform/error-reporter'
import { INSTANCE } from '@/platform/instance'

/**
 * How long one overlay file may take before the app starts without it. The
 * files sit on the same container as the app: a request that takes longer is
 * a stalled network, and a stalled start (a white screen in a Telegram
 * WebView) costs more than the wording of one school.
 */
export const INSTANCE_TEXTS_TIMEOUT_MS = 2000

/** Where the container's nginx serves the mounted package's ui/ folder. */
export const INSTANCE_TEXTS_URL = '/texts/ui/'

function isMessages(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function fetchOverrides(
  locale: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetchImpl(`${INSTANCE_TEXTS_URL}${locale}.json`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(INSTANCE_TEXTS_TIMEOUT_MS),
    })
    if (!response.ok) return null
    if (!(response.headers.get('content-type') ?? '').includes('application/json')) return null
    const body: unknown = await response.json()
    return isMessages(body) ? body : null
  } catch {
    return null
  }
}

/**
 * Fetch the instance's ui text overrides for every locale of the instance
 * and apply them. Files load in parallel; a locale without a file keeps the
 * product's own strings.
 */
export async function loadInstanceTexts(
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<void> {
  const locales = INSTANCE.locales
  const loaded = await Promise.all(locales.map((locale) => fetchOverrides(locale, fetchImpl)))
  const overrides: Record<string, Record<string, unknown>> = {}
  locales.forEach((locale, i) => {
    const messages = loaded[i]
    if (messages) overrides[locale] = messages
  })
  if (Object.keys(overrides).length === 0) return
  try {
    applyInstanceOverrides(overrides)
  } catch (err) {
    // An overlay is data from outside: whatever it does, the app starts.
    reportError(err, { source: 'window', info: 'instance texts' })
  }
}
