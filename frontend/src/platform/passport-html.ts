// =============================================================================
// VELO Frontend -- passportHtmlDefaults (tz-whitelabel F1 §2.2 + F2 §3)
// =============================================================================
// BUILD-side seam: vite.config.ts plugs this in to resolve the placeholders
// in index.html. (The browser-side seam is platform/instance.ts -- it reads
// import.meta.env, which does not exist in Node, which is why the two cannot
// share one module.)
//
// Two placeholder families:
//   %VELO_BRAND%, %VELO_DEFAULT_LOCALE%
//                   -- the instance passport (lang, brand title), valued by
//                      the VITE_BRAND / VITE_DEFAULT_LOCALE env vars.
//                      Resolved HERE only: process.env -> .env files ->
//                      golden. [FE-153] They used to be spelled %VITE_*%,
//                      which Vite's own html env pass also matches -- and
//                      CI builds without a .env, so every build warned
//                      "%VITE_*% is not defined in env variables" before
//                      this plugin resolved them correctly. Vite only
//                      touches (and warns about) placeholders carrying the
//                      VITE_ env prefix, so the VELO_ spelling is ours alone.
//   %VELO_THEME_COLOR%, the VELO:FONT block
//                   -- the skin derivatives (tz-whitelabel §1/§3,
//                      platform/skin.ts), golden defaults when no skin ships.
//                      The defaults DUPLICATE the golden values on purpose
//                      (mirror pattern, pinned by passport-html.test.ts).
// =============================================================================

import { loadEnv, type Plugin } from 'vite'

import { GOLDEN_SKIN, type SkinPackage } from './skin'

/** Placeholder (as written in index.html, between the %) mapped to the env var
 *  that values it. */
const PASSPORT_PLACEHOLDERS: Record<string, string> = {
  VELO_BRAND: 'VITE_BRAND',
  VELO_DEFAULT_LOCALE: 'VITE_DEFAULT_LOCALE',
}

const PASSPORT_HTML_DEFAULTS: Record<string, string> = {
  VITE_BRAND: GOLDEN_SKIN.displayName,
  VITE_DEFAULT_LOCALE: 'ru',
}

const FONT_BLOCK = /<!--VELO:FONT-->[\s\S]*<!--\/VELO:FONT-->/

/** A skin with self-hosted fonts (FE-131: assets/fonts/ of the package,
 *  declared by an \@font-face rule in skin-tokens.css) replaces the Google Fonts block
 *  with preloads of its own files -- no external request ships with it. */
function skinFontBlock(skin: SkinPackage): string {
  return [
    '<!--VELO:FONT-->',
    ...skin.fonts.map(
      (font) =>
        `    <link rel="preload" href="/skin/${font.file}" as="font" type="font/woff2" crossorigin />`,
    ),
    '<!--/VELO:FONT-->',
  ].join('\n')
}

/** HTML text escape for a value that comes from package data. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** The index.html post-transform.
 *
 * @param skin - The package read by platform/skin.ts (null = golden build). */
export function passportHtmlDefaults(skin: SkinPackage | null = null): Plugin {
  let files: Record<string, string> = {}
  return {
    name: 'velo-passport-html-defaults',
    configResolved(config) {
      files = loadEnv(config.mode, config.envDir ?? config.root, 'VITE_')
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        let out = html.replace(/%(VELO_[A-Z0-9_]+)%/g, (placeholder, key: string) => {
          const name = PASSPORT_PLACEHOLDERS[key]
          if (!name) return placeholder
          const value = process.env[name] ?? files[name] ?? PASSPORT_HTML_DEFAULTS[name]
          return value ?? placeholder
        })
        // Skin derivatives (§1: the brand record is the single header-color source).
        out = out.replace(/%VELO_THEME_COLOR%/g, skin?.themeColor ?? GOLDEN_SKIN.themeColor)
        if (skin) {
          if (skin.fonts.length > 0) out = out.replace(FONT_BLOCK, skinFontBlock(skin))
          // The tab title follows the skin's display name: a branded build
          // whose browser tab still said VELO would read as half-skinned.
          // Escaped and substituted through a function: a display name is
          // package data -- markup must not reach the document, and `$&`
          // must not expand as a replacement pattern.
          const title = `<title>${escapeHtml(skin.displayName)}</title>`
          out = out.replace(/<title>[^<]*<\/title>/, () => title)
        }
        return out
      },
    },
  }
}
