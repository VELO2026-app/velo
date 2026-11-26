// =============================================================================
// VELO Frontend -- passportHtmlDefaults (tz-whitelabel F1 §2.2 + F2 §3)
// =============================================================================
// BUILD-side seam: vite.config.ts plugs this in to resolve the placeholders
// in index.html. (The browser-side seam is platform/instance.ts -- it reads
// import.meta.env, which does not exist in Node, which is why the two cannot
// share one module.)
//
// Two placeholder families:
//   %VELO_DEFAULT_LOCALE%
//                   -- the instance passport (lang), valued by the
//                      VITE_DEFAULT_LOCALE env var.
//                      Resolved HERE only: process.env -> .env files ->
//                      golden. [FE-153] They used to be spelled %VITE_*%,
//                      which Vite's own html env pass also matches -- and
//                      CI builds without a .env, so every build warned
//                      "%VITE_*% is not defined in env variables" before
//                      this plugin resolved them correctly. Vite only
//                      touches (and warns about) placeholders carrying the
//                      VITE_ env prefix, so the VELO_ spelling is ours alone.
//   %VELO_BRAND%, %VELO_THEME_COLOR%, the VELO:FONT block
//                   -- the skin derivatives (tz-whitelabel §1/§3,
//                      platform/skin.ts): the tab title is the skin's
//                      display name -- no env value names the brand (FE-231);
//                      the core values (CORE_SKIN) when no skin ships.
// =============================================================================

import { loadEnv, type Plugin } from 'vite'

import { CORE_SKIN, type SkinFont, type SkinPackage } from './skin'

/** Placeholder (as written in index.html, between the %) mapped to the env var
 *  that values it. */
const PASSPORT_PLACEHOLDERS: Record<string, string> = {
  VELO_DEFAULT_LOCALE: 'VITE_DEFAULT_LOCALE',
}

const PASSPORT_HTML_DEFAULTS: Record<string, string> = {
  VITE_DEFAULT_LOCALE: 'ru',
}

const FONT_BLOCK = /<!--VELO:FONT-->[\s\S]*<!--\/VELO:FONT-->/

/** The numeric `normal` face the browser picks for `weight`: the exact one,
 *  else (CSS font matching, simplified) the nearest heavier face from 500 up,
 *  the nearest lighter one below that, and the other side if there is none. */
function faceFor(fonts: SkinPackage['fonts'], weight: number): SkinFont | undefined {
  const faces = fonts
    .filter((font) => font.style === 'normal' && typeof font.weight === 'number')
    .sort((a, b) => Number(a.weight) - Number(b.weight))
  const exact = faces.find((font) => font.weight === weight)
  if (exact) return exact
  const heavier = faces.find((font) => Number(font.weight) > weight)
  const lighter = [...faces].reverse().find((font) => Number(font.weight) < weight)
  return weight >= 500 ? (heavier ?? lighter) : (lighter ?? heavier)
}

/** The faces the first paint needs (FE-278): Regular (400) and the face of
 *  headings and buttons (`skin.headingWeight`, the one token to move them
 *  between Medium and Bold). The other faces of the family load on demand
 *  through their \@font-face rule, when text of that weight is drawn. A package
 *  without such a face (a single variable font, "200 800") preloads its first
 *  file. */
function preloadedFaces(skin: SkinPackage): SkinPackage['fonts'] {
  const wanted = [400, skin.headingWeight]
  const faces = wanted.flatMap((weight) => {
    const face = weight === null ? undefined : faceFor(skin.fonts, weight)
    return face ? [face] : []
  })
  const unique = faces.filter((face, at) => faces.indexOf(face) === at)
  return unique.length > 0 ? unique : skin.fonts.slice(0, 1)
}

/** A skin with self-hosted fonts (FE-131: assets/fonts/ of the package,
 *  declared by an \@font-face rule in virtual:skin-tokens.css) replaces the Google Fonts block
 *  with preloads of its regular and heading faces -- no external request ships with it. */
function skinFontBlock(skin: SkinPackage): string {
  return [
    '<!--VELO:FONT-->',
    ...preloadedFaces(skin).map(
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
 * @param skin - The package read by platform/skin.ts (null = the core build). */
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
        out = out.replace(/%VELO_THEME_COLOR%/g, skin?.themeColor ?? CORE_SKIN.themeColor)
        // The tab title is the skin's display name (the core word without a
        // package). Escaped and substituted through a function: a display
        // name is package data -- markup must not reach the document, and
        // `$&` must not expand as a replacement pattern.
        const title = escapeHtml((skin ?? CORE_SKIN).displayName)
        out = out.replace(/%VELO_BRAND%/g, () => title)
        if (skin && skin.fonts.length > 0) out = out.replace(FONT_BLOCK, skinFontBlock(skin))
        return out
      },
    },
  }
}
