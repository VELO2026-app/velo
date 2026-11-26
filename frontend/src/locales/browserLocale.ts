// =============================================================================
// VELO Frontend -- the language of a device that has not signed in (FE-261)
// =============================================================================
//
// Before sign-in the server has no User.language to follow, and no boot hint
// exists (the hint is the last language the person CHOSE). The first screen
// speaks the browser's language when the instance offers it, and the
// instance's default language when it does not -- never a language fixed in
// code.
//
// A pure function over its inputs: locales/index.ts reads navigator.languages
// and INSTANCE, so each rule here is testable without a browser.
// =============================================================================

import type { Locale } from '@/platform/instance'

/**
 * Pick the instance language a browser asks for.
 *
 * @remarks
 * The browser lists its languages in order of preference (`uk-UA`, `en-US`,
 * `en`). The first entry whose primary subtag (`uk-UA` gives `uk`; case and
 * `-`/`_` are ignored) is one of the instance's languages wins; a language the
 * instance does not offer is skipped, not mapped to a near one. No entry
 * matches: the instance default.
 *
 * @param browserLanguages - navigator.languages, most preferred first
 * @param offered - the instance's languages (INSTANCE.locales)
 * @param fallback - the instance default (INSTANCE.defaultLocale)
 * @returns the language the signed-out screens start in
 */
export function pickBrowserLocale(
  browserLanguages: readonly string[],
  offered: readonly Locale[],
  fallback: Locale,
): Locale {
  for (const tag of browserLanguages) {
    const primary = tag.trim().toLowerCase().split(/[-_]/, 1)[0]
    const match = offered.find((locale) => locale === primary)
    if (match) return match
  }
  return fallback
}
