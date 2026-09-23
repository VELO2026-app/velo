/*
  VELO Frontend -- schoolBranding/banner (tz-curator.md §5.3)

  Фон «роза-вихрь»: вложенные широкие ленты + тонкие струи + горы + листья.
  Порт прототипа; формулы, фильтры и округления не трогать (golden-тесты).
  bannerSvg(..., {lightweight}) -- упрощённый вариант для строки списка (§1.4):
  без feTurbulence/feDisplacementMap/grain и blur-фильтров хребтов.
*/

import type { SchoolBrandingParams } from './params'
import { petal, poly, offsetPts, taperedPath, type PathPoint } from './geometry'
import { makeNoise, mixHex, rampW } from './noise'

/** Лента-кольцо «розы»: дуга вокруг центра с лёгким дрейфом радиуса и
 *  подворотом хвоста внутрь. Ширина почти равна шагу спирали -- ленты
 *  упаковывают диск вплотную. */
function bandPts(
  S: SchoolBrandingParams['bg']['swirl'],
  sp: SchoolBrandingParams['bg']['swirl']['bands'][number],
  noise: (x: number, y: number) => number,
): PathPoint[] {
  const steps = Math.max(28, Math.round(sp.arc / 0.05))
  const pts: PathPoint[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const th = sp.alpha + S.dir * sp.arc * t
    let r = sp.r0 + (t - 0.5) * sp.drift - Math.pow(t, 3) * sp.tuck
    r += (noise(Math.cos(th) * 1.6 + sp.ox + S.nSeed, Math.sin(th) * 1.6 + sp.oy) - 0.5) * S.wobble
    const w = sp.W * rampW(t) * (0.92 + noise(th * 1.9 + sp.ox, sp.oy) * 0.16)
    pts.push({
      x: S.cx + sp.ox + Math.cos(th) * r,
      y: S.cy + sp.oy + Math.sin(th) * r,
      w: Math.max(w, 1.5),
    })
  }
  return pts
}

/** Тонкая струя, вылетающая из ролла за край (как пряди в верхней части). */
function tailPts(
  S: SchoolBrandingParams['bg']['swirl'],
  sp: SchoolBrandingParams['bg']['swirl']['tails'][number],
  noise: (x: number, y: number) => number,
): PathPoint[] {
  const steps = 48
  const pts: PathPoint[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const th = sp.alpha + S.dir * sp.arc * t
    let r = sp.r0 * (1 + t * sp.grow)
    r += (noise(Math.cos(th) * 1.6 + S.nSeed, Math.sin(th) * 1.6) - 0.5) * S.wobble
    pts.push({
      x: S.cx + Math.cos(th) * r,
      y: S.cy + Math.sin(th) * r,
      w: Math.max(sp.W * Math.pow(1 - t, 1.3), 0.8),
    })
  }
  return pts
}

/** Лента из трех полупрозрачных проходов -- наслоение пигмента (акварель). */
function ribbonSvg(pts: PathPoint[], color: string, opacity: number): string {
  const offs = [0, 0.18, -0.18]
  const alphas = [0.55, 0.32, 0.32]
  return offs
    .map(
      (o, i) =>
        `<path d="${taperedPath(offsetPts(pts, o))}" fill="${color}" opacity="${(opacity * alphas[i]!).toFixed(3)}"/>`,
    )
    .join('')
}

export interface BannerSvgOptions {
  /**
   * true -- вариант для строки списка (§1.4/§5.3): без тяжёлых фильтров
   * (feTurbulence/feDisplacementMap/grain/blur), та же сцена.
   */
  lightweight?: boolean
  /**
   * Плоский режим (owner 2026-09-19: фон выглядел «растянутым» -- это
   * смазывали feDisplacementMap и grain): без водянистого дрожания краёв
   * и зерна; мягкий blur хребтов остаётся.
   */
  flat?: boolean
}

export function bannerSvg(
  P: SchoolBrandingParams,
  w: number,
  h: number,
  opts: BannerSvgOptions = {},
): string {
  const uid = 'bg' + P.hash.slice(0, 8)
  const c = P.style.palette
  const b = P.bg
  const S = b.swirl
  const noise = makeNoise(P.hash)
  let body = `<rect width="${w}" height="${h}" fill="${c.bg}"/>`
  let defs = ''

  // мягкое свечение слева от центра вихря
  body += `<radialGradient id="${uid}-glow"><stop offset="0%" stop-color="${c.faint}" stop-opacity=".8"/><stop offset="100%" stop-color="${c.faint}" stop-opacity="0"/></radialGradient>`
  body += `<circle cx="${b.glow.cx.toFixed(0)}" cy="${b.glow.cy.toFixed(0)}" r="${b.glow.r.toFixed(0)}" fill="url(#${uid}-glow)"/>`

  // горы разного масштаба + туман у подножия
  if (b.mountains) {
    b.mountains.ridges.forEach((rg, i) => {
      const filter = opts.lightweight ? '' : ` filter="url(#${uid}-m${i})"`
      body += `<path d="${poly(rg.pts)}" fill="${c[rg.color]}" opacity="${rg.opacity}"${filter}/>`
    })
    defs += `<linearGradient id="${uid}-fog" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.bg}" stop-opacity="0"/><stop offset=".55" stop-color="${c.bg}" stop-opacity="1"/><stop offset="1" stop-color="${c.bg}" stop-opacity="0"/></linearGradient>`
    body += `<rect x="-20" y="${b.mountains.fog.y.toFixed(0)}" width="${b.mountains.fog.w.toFixed(0)}" height="${b.mountains.fog.h.toFixed(0)}" fill="url(#${uid}-fog)" opacity="${b.mountains.fog.opacity.toFixed(2)}"/>`
  }

  // струи под роллом
  let streams = S.tails
    .map(
      (t) =>
        `<path d="${taperedPath(tailPts(S, t, noise))}" fill="${c[t.color]}" opacity="${t.opacity}"/>`,
    )
    .join('')

  // ленты-кольца: от внутренней к внешней, каждая со своим градиентом вдоль дуги
  S.bands.forEach((sp, i) => {
    const pts = bandPts(S, sp, noise)
    const g = `${uid}-b${i}`
    defs +=
      `<linearGradient id="${g}" gradientUnits="userSpaceOnUse" x1="${pts[0]!.x.toFixed(1)}" y1="${pts[0]!.y.toFixed(1)}" x2="${pts[pts.length - 1]!.x.toFixed(1)}" y2="${pts[pts.length - 1]!.y.toFixed(1)}">` +
      `<stop offset="0" stop-color="${mixHex(c[sp.color], c.bg, sp.Wg)}"/><stop offset="1" stop-color="${c[sp.color]}"/></linearGradient>`
    streams += `<g opacity="${sp.opacity}">${ribbonSvg(pts, `url(#${g})`, 1)}</g>`
  })

  // листья у нижнего края
  if (b.leaves) {
    streams += b.leaves.items
      .map(
        (l) =>
          `<path d="${petal(l.a, 0, l.len, l.w, 0.5)}" transform="translate(${b.leaves!.x.toFixed(0)} ${b.leaves!.y.toFixed(0)})" fill="${c[l.color]}" opacity="${l.opacity}"/>`,
      )
      .join('')
  }

  // водянистое дрожание краёв всех фигур (акварельная неровность) -- только
  // в полном hero-варианте; в лёгком (строки) и плоском (owner) фильтр не
  // рендерим.
  body +=
    opts.lightweight || opts.flat
      ? `<g>${streams}</g>`
      : `<g filter="url(#${uid}-wc)">${streams}</g>`

  // Effect defs are mode-specific: full = ridge blur + watercolor + grain;
  // flat = ridge blur only; lightweight = none (plain edges, §5.3).
  if (b.mountains && !opts.lightweight) {
    defs += b.mountains.ridges
      .map(
        (rg, i) =>
          `<filter id="${uid}-m${i}" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${rg.blur}"/></filter>`,
      )
      .join('')
  }
  if (!opts.lightweight && !opts.flat) {
    defs +=
      `<filter id="${uid}-wc" x="-15%" y="-15%" width="130%" height="130%"><feTurbulence type="fractalNoise" baseFrequency=".012 .02" numOctaves="2" seed="${b.grainSeed}" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="20" xChannelSelector="R" yChannelSelector="G"/></filter>` +
      `<filter id="${uid}-grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".8" numOctaves="2" seed="${b.grainSeed}"/><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .5 0"/></filter>`
  }

  // The gradient/filter defs MUST ship in every mode: bands and the fog are
  // painted with url(#...) references, and a missing def makes browsers skip
  // the element entirely (the «empty background» bug).
  if (defs) body += `<defs>${defs}</defs>`
  if (!opts.lightweight && !opts.flat) {
    body += `<rect width="${w}" height="${h}" filter="url(#${uid}-grain)" opacity=".05"/>`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${body}</svg>`
}
