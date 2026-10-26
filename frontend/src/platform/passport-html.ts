// =============================================================================
// VELO Frontend -- passportHtmlDefaults (tz-whitelabel F1 §2.2 + F2 §3)
// =============================================================================
// BUILD-side seam: vite.config.ts plugs this in to resolve the placeholders
// in index.html. (The browser-side seam is platform/instance.ts -- it reads
// import.meta.env, which does not exist in Node, which is why the two cannot
// share one module.)
//
// Two placeholder families:
//   %VITE_*%        -- the instance passport (lang, brand title). Vite
//                      replaces natively -- but ONLY env vars that are
//                      DEFINED at build time, and CI builds without a .env:
//                      an undefined var would ship the literal placeholder.
//                      Resolved from process.env -> .env files -> golden.
//   %VELO_THEME_COLOR%, the VELO:FONT block
//                   -- the skin derivatives (tz-whitelabel §1/§3,
//                      platform/skin.ts), golden defaults when no skin ships.
//                      The defaults DUPLICATE the golden values on purpose
//                      (mirror pattern, pinned by passport-html.test.ts).
// =============================================================================

import { loadEnv, type Plugin } from 'vite'

import { GOLDEN_SKIN, type SkinPackage } from './skin'

const PASSPORT_HTML_DEFAULTS: Record<string, string> = {
  VITE_BRAND: GOLDEN_SKIN.displayName,
  VITE_DEFAULT_LOCALE: 'ru',
}

const FONT_BLOCK = /<!--VELO:FONT-->[\s\S]*<!--\/VELO:FONT-->/

function skinFontBlock(skin: SkinPackage): string {
  return [
    '<!--VELO:FONT-->',
    `    <link rel="preconnect" href="https://fonts.googleapis.com" />`,
    `    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />`,
    `    <link href="${skin.fontUrl}" rel="stylesheet" />`,
    '<!--/VELO:FONT-->',
  ].join('\n')
}

/** The index.html post-transform. `skin` is the package read by
 * platform/skin.ts (null = golden build). */
export function passportHtmlDefaults(skin: SkinPackage | null = null): Plugin {
  let files: Record<string, string> = {}
  return {
    name: 'velo-passport-html-defaults',
    configResolved(config) {
      files = loadEnv(config.mode, config.envDir ?? config.root, 'VITE_')
    },
    transformIndexHtml: {
      // 'post': run after Vite's own html env replacement, so only
      // unresolved placeholders are handled here.
      order: 'post',
      handler(html) {
        let out = html.replace(/%VITE_[A-Z0-9_]+%/g, (placeholder) => {
          const name = placeholder.slice(1, -1)
          const value = process.env[name] ?? files[name] ?? PASSPORT_HTML_DEFAULTS[name]
          return value ?? placeholder
        })
        // Skin derivatives (§1: brand.json is the single header-color source).
        out = out.replace(/%VELO_THEME_COLOR%/g, skin?.themeColor ?? GOLDEN_SKIN.themeColor)
        if (skin) {
          if (skin.fontUrl) out = out.replace(FONT_BLOCK, skinFontBlock(skin))
          // The tab title follows the skin's display name: a branded build
          // whose browser tab still said VELO would read as half-skinned.
          out = out.replace(/<title>[^<]*<\/title>/, `<title>${skin.displayName}</title>`)
        }
        return out
      },
    },
  }
}
