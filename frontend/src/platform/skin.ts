// =============================================================================
// VELO Frontend -- Skin package reader (tz-whitelabel §3, F2; FE-131)
// =============================================================================
// BUILD-side seam: vite.config.ts calls readSkin() at config time to
// materialize the derivatives tz-whitelabel §1 lists -- skin-tokens.css,
// index.html theme-color/font, and the manifest identity. It is NEVER
// imported by the client bundle (node:fs does not exist in the browser).
//
// The package arrives from the deploy machine as public/skin/ (apply: build
// -- the machine puts it into the build context): the machine's DTCG format,
// primer-package.yaml + tokens/*.tokens.json + assets/ (tz-whitelabel §3.2).
// Reading and converting it is scripts/lib/skin-package.mjs -- the same
// engine validate-skin.mjs checks with. NO package = the golden VELO build;
// a MALFORMED one throws here so a broken deploy fails the build instead of
// shipping a half-skinned app (`pnpm build` runs validate-skin --build first;
// this throw is the backstop for a bare `vite build`).
// =============================================================================

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  isSkinPackage,
  loadSkinPackage,
  readGoldenTokens,
  skinCss,
  type LoadedSkinPackage,
  type SkinFont,
} from '../../scripts/lib/skin-package.mjs'

export type { SkinFont }

/** A skin package's brand identity, materialized into the build's derivatives. */
export interface SkinPackage {
  /** Manifest name + short_name + the `{brand}` text source of record. */
  displayName: string
  /** PWA convention: ≤ 12 chars (validated strictly in the engine). */
  shortName: string
  /** The ONE header-color source (tz-whitelabel §1): index.html meta,
   *  manifest theme_color AND --velo-tg-header must all agree; the first
   *  two are materialized from here, the third is checked by the validator
   *  against the package's velo.tg.header. */
  themeColor: string
  backgroundColor: string
  /** Self-hosted webfonts of the package (assets/fonts/); empty = Marmelad. */
  fonts: SkinFont[]
}

/** The no-skin build. Values mirror index.html/manifest.ts/variables.css —
 *  the same mirror-and-pin discipline as telegram.ts ↔ variables.css. */
export const GOLDEN_SKIN: SkinPackage = {
  displayName: 'VELO',
  shortName: 'VELO',
  themeColor: '#334D6E',
  backgroundColor: '#ffffff',
  fonts: [],
}

/** Loads public/skin/ with the engine; throws on the first problems. */
function loadPackage(publicDir: string): LoadedSkinPackage {
  const frontendDir = join(publicDir, '..')
  const pkg = loadSkinPackage(join(publicDir, 'skin'), readGoldenTokens(frontendDir))
  if (pkg.problems.length > 0) {
    throw new Error(
      `[skin] public/skin is not a valid skin package — run scripts/validate-skin.mjs:\n  ${pkg.problems.join('\n  ')}`,
    )
  }
  return pkg
}

/**
 * The skin package for this build.
 *
 * @returns Null when the golden one ships.
 *
 * @param publicDir - The frontend/public directory.
 */
export function readSkin(publicDir: string): SkinPackage | null {
  const dir = join(publicDir, 'skin')
  if (!existsSync(dir) || !isSkinPackage(dir)) return null
  const brand = loadPackage(publicDir).brand
  if (brand === null) throw new Error('[skin] public/skin: no brand record')
  return { ...brand }
}

/**
 * The background photo a skin package really ships, by what lies in
 * `skin/assets/bg/`: WebP is preferred (the golden format), PNG is the legacy
 * one already-released skins carry (the file set is a product contract, not
 * a format mandate; FE-157).
 *
 * @returns The file extension, or null when the package has no photo.
 *
 * @param publicDir - The frontend/public directory.
 */
export function skinBackgroundFormat(publicDir: string): 'webp' | 'png' | null {
  const bg = join(publicDir, 'skin', 'assets', 'bg')
  if (existsSync(join(bg, 'background.webp'))) return 'webp'
  if (existsSync(join(bg, 'background.png'))) return 'png'
  return null
}

/** Content of the generated src/styles/skin-tokens.css: the package's DTCG
 *  tokens converted to CSS custom properties (plus an \@font-face rule per
 *  self-hosted font), or the golden stub. Written by vite.config.ts at
 *  config time so the CSS import order in app.ts (variables, then global,
 *  then skin) is mechanical, never hopeful (tz-whitelabel §3, the cascade
 *  paragraph). */
export function materializedSkinTokens(publicDir: string, skin: SkinPackage | null): string {
  if (skin === null) {
    return `/* GENERATED -- tz-whitelabel §3 cascade stub.
 * No skin package ships with this build (public/skin/primer-package.yaml
 * absent): this file is intentionally empty and MUST stay imported AFTER
 * global.css in app.ts. A build with a skin overwrites it with the package's
 * tokens converted to CSS.
 */
`
  }
  // The photo URL token follows the file that really lies in assets/bg/
  // (the build spills it over the canonical /bg/ path). No bg/ = the golden
  // default from global.css stays. A SEPARATE :root block after the
  // package's: the file on disk wins over any token the package sets.
  const bgFormat = skinBackgroundFormat(publicDir)
  const bgOverride =
    bgFormat === null
      ? ''
      : `:root {\n  --velo-app-bg-image: url('/bg/background.${bgFormat}');\n}\n`
  return `/* GENERATED from public/skin/tokens/*.tokens.json (tz-whitelabel §3 cascade,
 * FE-131 DTCG engine) — do not edit; regenerate by rebuilding. Imported
 * AFTER global.css in app.ts.
 */
${skinCss(loadPackage(publicDir))}${bgOverride}`
}
