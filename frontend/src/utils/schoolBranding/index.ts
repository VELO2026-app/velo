/*
  VELO Frontend -- schoolBranding (tz-curator.md §5.3)

  Barrel of the school branding generator (owner-approved prototype
  2026-09-19, ported as-is): the same hash MUST yield the same SVG.
*/

import { generateParams, type SchoolBrandingParams } from './params'
import { mixHex } from './noise'

export { fnv1a, mulberry32, schoolHashFromName } from './hash'
export { PALETTES, type Palette } from './palettes'
export { generateParams, type SchoolBrandingParams }
export { mandalaGroup } from './mandala'
export { logoSvg, type LogoOptions } from './logo'
export { bannerSvg, type BannerSvgOptions } from './banner'

/** params cache keyed by hash -- generation never repeats in lists/feeds. */
const paramsCache = new Map<string, SchoolBrandingParams>()

export function brandingParams(hash: string): SchoolBrandingParams {
  const cached = paramsCache.get(hash)
  if (cached) return cached
  const fresh = generateParams(hash)
  paramsCache.set(hash, fresh)
  return fresh
}

/**
 * The school background's light halftone -- the plate under the logo on the
 * hero seam (owner 2026-09-19: the tint under the logo should read as
 * midway from the background, but light): the palette bg lightened halfway
 * toward white.
 */
export function brandingBodyTint(hash: string): string {
  const bg = brandingParams(hash).style.palette.bg
  return mixHex(bg, '#ffffff', 0.5)
}
