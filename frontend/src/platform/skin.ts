// =============================================================================
// VELO Frontend -- Skin package reader (tz-whitelabel §3, F2; FE-131)
// =============================================================================
// BUILD-side seam: vite.config.ts calls readSkin() at config time to
// materialize the derivatives tz-whitelabel §1 lists -- the skin-tokens.css
// module, index.html theme-color/font, and the manifest identity. It is NEVER
// imported by the client bundle (node:fs does not exist in the browser).
//
// The package arrives from the deploy machine as public/skin/ (apply: build
// -- the machine puts it into the build context): the machine's DTCG format,
// primer-package.yaml + tokens/*.tokens.json + assets/ (tz-whitelabel §3.2).
// Reading and converting it is scripts/lib/skin-package.mjs -- the same
// engine validate-skin.mjs checks with. NO package = the neutral core build (FE-230);
// a MALFORMED one throws here so a broken deploy fails the build instead of
// shipping a half-skinned app (`pnpm build` runs validate-skin --build first;
// this throw is the backstop for a bare `vite build`).
// =============================================================================

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  CORE_DISPLAY_NAME,
  isSkinPackage,
  loadSkinPackage,
  readGoldenTokens,
  shipsLogo,
  skinCss,
  type LoadedSkinPackage,
  type SkinFont,
} from '../../scripts/lib/skin-package.mjs'

export type { SkinFont }

/** A skin package's brand identity, materialized into the build's derivatives. */
export interface SkinPackage {
  /** Manifest name + short_name + `<title>` + the `@:brand` text: the ONE
   *  source of the brand name (owner 09.11; FE-231). */
  displayName: string
  /** PWA convention: ≤ 12 chars (validated strictly in the engine). */
  shortName: string
  /** The ONE header-color source (tz-whitelabel §1): index.html meta,
   *  manifest theme_color AND --velo-tg-header must all agree; the first
   *  two are materialized from here, the third is checked by the validator
   *  against the package's velo.tg.header. */
  themeColor: string
  backgroundColor: string
  /** Self-hosted webfonts of the package (assets/fonts/); empty = the system stack. */
  fonts: SkinFont[]
  /** Does the package ship the logo set (assets/mandala-*, velo-word-*,
   *  logo-white)? No = VeloLogo shows the brand's favicon.svg (FE-230). */
  hasLogo: boolean
}

/** The no-skin build: the neutral core (FE-230). Colors mirror
 *  variables.css (--velo-tg-header) — the same mirror-and-pin discipline as
 *  telegram.ts ↔ variables.css. The name is the neutral core word (FE-231):
 *  a brand name ships only in the brand's skin package. */
export const CORE_SKIN: SkinPackage = {
  displayName: CORE_DISPLAY_NAME,
  shortName: CORE_DISPLAY_NAME,
  themeColor: '#4c4c4c',
  backgroundColor: '#f2f2f2',
  fonts: [],
  hasLogo: true,
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
 * @returns Null when no package ships (the neutral core build).
 *
 * @param publicDir - The frontend/public directory.
 */
export function readSkin(publicDir: string): SkinPackage | null {
  const dir = join(publicDir, 'skin')
  if (!existsSync(dir) || !isSkinPackage(dir)) return null
  const pkg = loadPackage(publicDir)
  const brand = pkg.brand
  if (brand === null) throw new Error('[skin] public/skin: no brand record')
  // The build's identity only: contrastExceptions are the validator's.
  const { displayName, shortName, themeColor, backgroundColor, fonts } = brand
  return {
    displayName,
    shortName,
    themeColor,
    backgroundColor,
    fonts,
    hasLogo: shipsLogo(pkg.files),
  }
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

/** Content of the virtual module virtual:skin-tokens.css: the package's DTCG
 *  tokens converted to CSS custom properties (plus an \@font-face rule per
 *  self-hosted font), or the empty stub of the core build. Served by platform/skin-virtual.ts
 *  at build time so the CSS import order in app.ts (variables, then global,
 *  then skin) is mechanical, never hopeful (tz-whitelabel §3, the cascade
 *  paragraph). */
export function materializedSkinTokens(publicDir: string, skin: SkinPackage | null): string {
  if (skin === null) {
    return `/* GENERATED -- tz-whitelabel §3 cascade stub.
 * No skin package ships with this build (public/skin/primer-package.yaml
 * absent): this module is intentionally empty and MUST stay imported AFTER
 * global.css in app.ts. A build with a skin serves the package's tokens
 * converted to CSS instead.
 */
`
  }
  // The photo URL token follows the file that really lies in assets/bg/
  // (the build spills it over the canonical /bg/ path). No bg/ = the core's
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
