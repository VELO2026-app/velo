// =============================================================================
// VELO Frontend -- skin virtual modules (FE-157 s5/B, tz-whitelabel §3)
// =============================================================================
// BUILD-side seam: the two skin derivatives the client bundle imports used to
// be written into tracked files at config time (skin-tokens.css,
// skin-brand.generated.ts), so every build dirtied the working tree. They are
// virtual modules now: the plugin serves them from memory, nothing touches
// the disk. NEVER imported by the client bundle (node:fs, via skin.ts).
// =============================================================================

import type { Plugin } from 'vite'

import { CORE_SKIN, materializedSkinTokens, type SkinPackage } from './skin'

/** Import id of the skin's token cascade (a stylesheet; app.ts imports it LAST). */
export const SKIN_TOKENS_ID = 'virtual:skin-tokens.css'
/** Import id of the skin's brand facts: `SKIN_BRAND` (the text, see
 *  locales/index.ts), `SKIN_HAS_LOGO` (components/ui/VeloLogo.vue) and
 *  `SKIN_SUPPORT_EMAIL` (components/shared/SupportEmailLink.vue). */
export const SKIN_BRAND_ID = 'virtual:skin-brand'

/** Rollup convention: a `\0` prefix marks a resolved virtual id. */
const RESOLVED_PREFIX = '\0'

/**
 * Source of the brand module: the skin's display name, or the core's neutral
 * word when no package ships (FE-231: no brand name in the core), and
 * whether the build shows a logo set -- the core's neutral one, or the
 * package's; false = the package left it out (FE-230) -- and the brand's
 * support address, null for the core or a package without one (FE-251).
 *
 * @param skin - The skin package, or null for the core build.
 */
export function skinBrandSource(skin: SkinPackage | null): string {
  return (
    `export const SKIN_BRAND = ${JSON.stringify((skin ?? CORE_SKIN).displayName)}\n` +
    `export const SKIN_HAS_LOGO = ${JSON.stringify(skin?.hasLogo ?? true)}\n` +
    `export const SKIN_SUPPORT_EMAIL = ${JSON.stringify(skin?.supportEmail ?? null)}\n`
  )
}

/**
 * Serves `virtual:skin-tokens.css` and `virtual:skin-brand` for the given
 * skin. The `.css` suffix of the tokens id keeps Vite's CSS pipeline on it.
 *
 * @param publicDir - The frontend/public directory (holds `skin/tokens.css`).
 * @param skin - The skin package, or null for the core build.
 */
export function skinVirtualModules(publicDir: string, skin: SkinPackage | null): Plugin {
  const sources: Record<string, () => string> = {
    [SKIN_TOKENS_ID]: () => materializedSkinTokens(publicDir, skin),
    [SKIN_BRAND_ID]: () => skinBrandSource(skin),
  }
  return {
    name: 'velo-skin-virtual',
    enforce: 'pre',
    resolveId(id) {
      return id in sources ? RESOLVED_PREFIX + id : null
    },
    load(id) {
      if (!id.startsWith(RESOLVED_PREFIX)) return null
      return sources[id.slice(RESOLVED_PREFIX.length)]?.() ?? null
    },
  }
}
