/*
  VELO Frontend -- schoolBranding (tz-curator.md §5.3)

  Барел генератора фирменного стиля школы (утверждённый прототип
  2026-09-19, перенесён как есть): тот же хэш обязан давать тот же SVG.
*/

import { generateParams, type SchoolBrandingParams } from './params'
import { mixHex } from './noise'

export { fnv1a, mulberry32, schoolHashFromName } from './hash'
export { PALETTES, type Palette } from './palettes'
export { generateParams, type SchoolBrandingParams }
export { mandalaGroup, mandalaSvg } from './mandala'
export { logoSvg, type LogoOptions } from './logo'
export { bannerSvg, type BannerSvgOptions } from './banner'

/** Кэш params по хэшу -- генерация не повторяется в списках/лентах. */
const paramsCache = new Map<string, SchoolBrandingParams>()

export function brandingParams(hash: string): SchoolBrandingParams {
  const cached = paramsCache.get(hash)
  if (cached) return cached
  const fresh = generateParams(hash)
  paramsCache.set(hash, fresh)
  return fresh
}

/** Первая буква названия для монограммы (как в прототипе: без кавычек). */
export function schoolLetter(name: string): string {
  return (name.replace(/^["«'«]*/, '')[0] || 'Ш').toUpperCase()
}

/**
 * Светлый полутон фона школы -- подложка под лого на шве hero (owner
 * 2026-09-19: «фон под лого -- что-то среднее от фона, но светлое»):
 * палитровый bg, осветлённый наполовину к белому.
 */
export function brandingBodyTint(hash: string): string {
  const bg = brandingParams(hash).style.palette.bg
  return mixHex(bg, '#ffffff', 0.5)
}
