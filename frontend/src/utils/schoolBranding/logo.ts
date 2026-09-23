/*
  VELO Frontend -- schoolBranding/logo (tz-curator.md §5.3)

  Логотип школы: 200×200, скруглённый квадрат #fffdf8, мягкая тень,
  мандала + опциональная монограмма-буква. Порт прототипа.
*/

import type { SchoolBrandingParams } from './params'
import { mandalaGroup } from './mandala'

export interface LogoOptions {
  /** Монограмма-буква под мандалой (в прототипе -- чекбокс «буква школы»). */
  monogram?: boolean
  /** Буква монограммы; экранируется от <>& (§5.3). */
  letter?: string
  /** Плоский режим: без drop-shadow (owner 2026-09-19: лого -- плоский). */
  flat?: boolean
  /**
   * Масштаб мандалы внутри плашки: 0.8 -- как в прототипе; больше -- мандала
   * крупнее (owner 2026-09-19: «само лого внутри плитки -- больше»).
   */
  mandalaScale?: number
}

export function logoSvg(P: SchoolBrandingParams, opts: LogoOptions = {}): string {
  const uid = 'lg' + P.hash.slice(0, 8)
  const c = P.style.palette
  const scale = opts.mandalaScale ?? 0.8
  const mono = opts.monogram
    ? `<text x="100" y="164" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="28" fill="${c.deep}">${(opts.letter || 'Ш').replace(/[<>&]/g, '')}</text>`
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
