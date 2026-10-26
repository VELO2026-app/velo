// =============================================================================
// VELO Frontend -- Skin package reader (tz-whitelabel §3, F2 "skin, layer 1")
// =============================================================================
// BUILD-side seam: vite.config.ts calls readSkin() at config time to
// materialize the derivatives tz-whitelabel §1 lists -- skin-tokens.css,
// index.html theme-color/font link, and the manifest identity. It is NEVER
// imported by the client bundle (node:fs does not exist in the browser).
//
// The package itself arrives from the deploy side as public/skin/ (contract
// of fixed file names, tz-whitelabel §3): brand.json + tokens.css + assets.
// NO package = the golden VELO build; a MALFORMED brand.json throws here so
// a broken deploy fails the build instead of shipping a half-skinned app
// (the full validator lives in scripts/validate-skin.mjs and runs before
// this in the deploy pipeline).
// =============================================================================

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SkinPackage {
  /** Manifest name + short_name + the {brand} text source of record. */
  displayName: string
  /** PWA convention: ≤ 12 chars (validated strictly in validate-skin.mjs). */
  shortName: string
  /** The ONE header-color source (tz-whitelabel §1): index.html meta,
   *  manifest theme_color AND --velo-tg-header must all agree; the first
   *  two are materialized from here, the third is checked by the validator
   *  against skin/tokens.css. */
  themeColor: string
  backgroundColor: string
  /** Optional webfont stylesheet (brand.json "fontUrl"); absent = Marmelad. */
  fontUrl?: string
}

/** The no-skin build. Values mirror index.html/manifest.ts/variables.css —
 *  the same mirror-and-pin discipline as telegram.ts ↔ variables.css. */
export const GOLDEN_SKIN: SkinPackage = {
  displayName: 'VELO',
  shortName: 'VELO',
  themeColor: '#334D6E',
  backgroundColor: '#ffffff',
}

const HEX = /^#[0-9a-fA-F]{6}$/

function readBrandJson(publicDir: string): SkinPackage {
  const raw = readFileSync(join(publicDir, 'skin', 'brand.json'), 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(
      '[skin] public/skin/brand.json is not valid JSON — run scripts/validate-skin.mjs',
    )
  }
  const brand = parsed as Record<string, unknown>
  const str = (key: string): string => {
    const value = brand[key]
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`[skin] brand.json: "${key}" must be a non-empty string`)
    }
    return value.trim()
  }
  const hex = (key: string): string => {
    const value = str(key)
    if (!HEX.test(value)) {
      throw new Error(`[skin] brand.json: "${key}" must be a 6-digit hex color, got ${value}`)
    }
    return value
  }
  // Field checks in a fixed order, so a broken package reports its FIRST
  // problem deterministically (identity -> colours -> font).
  const displayName = str('displayName')
  const shortName = str('shortName')
  const themeColor = hex('themeColor')
  const backgroundColor = hex('backgroundColor')
  const fontUrl = brand['fontUrl']
  if (fontUrl !== undefined && (typeof fontUrl !== 'string' || !/^https:\/\//.test(fontUrl))) {
    throw new Error('[skin] brand.json: "fontUrl" must be an https:// URL when present')
  }
  return {
    displayName,
    shortName,
    themeColor,
    backgroundColor,
    ...(fontUrl !== undefined ? { fontUrl: fontUrl.trim() } : {}),
  }
}

/** The skin package for this build, or null when the golden one ships.
 *  `publicDir` is the frontend/public directory. */
export function readSkin(publicDir: string): SkinPackage | null {
  if (!existsSync(join(publicDir, 'skin', 'brand.json'))) return null
  return readBrandJson(publicDir)
}

/** Content of the generated src/styles/skin-tokens.css: the skin's token
 *  overrides verbatim under a banner, or the golden stub. Written by
 *  vite.config.ts at config time so the CSS import order in app.ts
 *  (variables -> global -> skin) is mechanical, never hopeful (tz-whitelabel
 *  §3, the cascade paragraph). */
export function materializedSkinTokens(publicDir: string, skin: SkinPackage | null): string {
  if (skin === null) {
    return `/* GENERATED -- tz-whitelabel §3 cascade stub.
 * No skin package ships with this build (public/skin/brand.json absent):
 * this file is intentionally empty and MUST stay imported AFTER global.css
 * in app.ts. A build with a skin overwrites it with public/skin/tokens.css.
 */
`
  }
  const tokens = readFileSync(join(publicDir, 'skin', 'tokens.css'), 'utf8')
  return `/* GENERATED from public/skin/tokens.css (tz-whitelabel §3 cascade) —
 * do not edit; regenerate by rebuilding. Imported AFTER global.css in app.ts.
 */
${tokens}
`
}
