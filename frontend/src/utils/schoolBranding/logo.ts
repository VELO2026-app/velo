/*
  VELO Frontend -- schoolBranding/logo (tz-curator.md §5.3)

  School logo: 200×200, a rounded square #fffdf8, a soft shadow, the
  mandala + an optional monogram letter. Port of the prototype.
*/

import type { SchoolBrandingParams } from './params'
import { mandalaGroup } from './mandala'

export interface LogoOptions {
  /** A monogram letter under the mandala (a "school letter" checkbox in
   *  the prototype). */
  monogram?: boolean
  /** The monogram letter; sanitized against `<>&` (§5.3). */
  letter?: string
  /** Flat mode: no drop-shadow (owner 2026-09-19: the logo is flat). */
  flat?: boolean
  /**
   * The mandala's scale inside the plate: 0.8 -- as in the prototype;
   * higher -- a larger mandala (owner 2026-09-19: the logo itself should
   * be bigger inside the tile).
   */
  mandalaScale?: number
}

export function logoSvg(P: SchoolBrandingParams, opts: LogoOptions = {}): string {
  const uid = 'lg' + P.hash.slice(0, 8)
  const c = P.style.palette
  const scale = opts.mandalaScale ?? 0.8
  const mono = opts.monogram
    ? `<text x="100" y="164" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="28" fill="${c.deep}">${
        // U+0428 (Cyrillic Sha) -- the prototype's stand-in for the Russian
        // word for "school" (golden port 2026-09-19, tz-curator §5.3: ported
        // as-is). Unreachable today: no live component turns the monogram on;
        // the fallback exists for the golden contract only.
        (opts.letter || 'Ш').replace(/[<>&]/g, '')
      }</text>`
    : ''
  const shadow = opts.flat
    ? ''
    : `<defs><filter id="${uid}-sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#2e3d38" flood-opacity=".22"/></filter></defs>`
  const plate = opts.flat
    ? `<rect x="6" y="6" width="188" height="188" rx="44" fill="#fffdf8"/>`
    : `<rect x="6" y="6" width="188" height="188" rx="44" fill="#fffdf8" filter="url(#${uid}-sh)"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${shadow}${plate}
  <g transform="translate(100 ${opts.monogram ? 92 : 100}) scale(${scale})">${mandalaGroup(P)}</g>
  ${mono}
</svg>`
}
