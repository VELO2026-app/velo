/*
  VELO Frontend -- schoolBranding/geometry (tz-curator.md §5.3)

  Pure geometry of petals/ribbons: points and SVG paths. Port of the
  prototype -- do not touch the .toFixed(2) rounding (golden tests compare
  against the reference).
*/

/** Full turn in radians. */
export const TAU = Math.PI * 2

/** A point of a variable-width path: position plus half-width. */
export interface PathPoint {
  x: number
  y: number
  w: number
}

/** A spiral for tendrils/strands: points with tapering width. */
export function spiralPts(
  cx: number,
  cy: number,
  a0: number,
  dir: number,
  turns: number,
  r0: number,
  r1: number,
  w0: number,
  steps = 64,
): PathPoint[] {
  const thMax = turns * Math.PI
  const b = Math.log(r1 / r0) / thMax
  const pts: PathPoint[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const th = a0 + dir * t * thMax
    const r = r0 * Math.exp(b * t * thMax)
    pts.push({
      x: cx + Math.cos(th) * r,
      y: cy + Math.sin(th) * r,
      w: Math.max(w0 * (1 - t), 0.5),
    })
  }
  return pts
}

/** A variable-width ribbon outline: two edges joined into a closed path. */
export function taperedPath(pts: PathPoint[]): string {
  const L: string[] = []
  const R: string[] = []
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!
    // Clamped neighbours can never be undefined under the loop bounds; the
    // `?? p` keeps TS's noUncheckedIndexedAccess happy without assertions
    // (the type-aware eslint rule calls `!` here unnecessary).
    const q = pts[Math.min(i + 1, pts.length - 1)] ?? p
    const r = pts[Math.max(i - 1, 0)] ?? p
    let dx = q.x - r.x
    let dy = q.y - r.y
    const len = Math.hypot(dx, dy) || 1
    dx /= len
    dy /= len
    L.push((p.x - (dy * p.w) / 2).toFixed(2) + ' ' + (p.y + (dx * p.w) / 2).toFixed(2))
    R.push((p.x + (dy * p.w) / 2).toFixed(2) + ' ' + (p.y - (dx * p.w) / 2).toFixed(2))
  }
  return 'M ' + L.join(' L ') + ' L ' + Rr(R).join(' L ') + ' Z'
}

// The reversed edge (Rr.reverse() in the prototype); extracted to avoid mutation.
function Rr(points: string[]): string[] {
  return [...points].reverse()
}

/** Closed straight-edge SVG path through the given points. */
export function poly(pts: Array<[number, number]>): string {
  return 'M ' + pts.map((p) => p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join(' L ') + ' Z'
}

/** A petal: bulge 0.5 -- rounded, 0.66 -- a teardrop. */
export function petal(angle: number, r0: number, r1: number, w: number, bulge = 0.5): string {
  const ux = Math.cos(angle)
  const uy = Math.sin(angle)
  const px = -uy
  const py = ux
  const bx = ux * r0
  const by = uy * r0
  const tx = ux * r1
  const ty = uy * r1
  const mx = ux * r0 + (ux * r1 - ux * r0) * bulge
  const my = uy * r0 + (uy * r1 - uy * r0) * bulge
  return `M ${bx.toFixed(2)} ${by.toFixed(2)} Q ${(mx + px * w).toFixed(2)} ${(my + py * w).toFixed(2)} ${tx.toFixed(2)} ${ty.toFixed(2)} Q ${(mx - px * w).toFixed(2)} ${(my - py * w).toFixed(2)} ${bx.toFixed(2)} ${by.toFixed(2)} Z`
}

/** A diamond shape (four straight edges) at an angle and radius. */
export function diamond(angle: number, r: number, halfW: number, halfH: number): string {
  const ux = Math.cos(angle)
  const uy = Math.sin(angle)
  const px = -uy
  const py = ux
  const cx = ux * r
  const cy = uy * r
  return poly([
    [cx + ux * halfH, cy + uy * halfH],
    [cx + px * halfW, cy + py * halfW],
    [cx - ux * halfH, cy - uy * halfH],
    [cx - px * halfW, cy - py * halfW],
  ])
}

/** A lace arc: n convex scallops around the circle (a stroked path). */
export function scallop(r0: number, r1: number, n: number, rot: number): string {
  let d = ''
  for (let i = 0; i < n; i++) {
    const a0 = rot + (i * TAU) / n
    const a1 = rot + ((i + 1) * TAU) / n
    const am = (a0 + a1) / 2
    d +=
      (i ? '' : `M ${(Math.cos(a0) * r0).toFixed(2)} ${(Math.sin(a0) * r0).toFixed(2)}`) +
      ` Q ${(Math.cos(am) * r1).toFixed(2)} ${(Math.sin(am) * r1).toFixed(2)} ${(Math.cos(a1) * r0).toFixed(2)} ${(Math.sin(a1) * r0).toFixed(2)}`
  }
  return d
}

/** Offset points along the normal -- for watercolor passes with an uneven
 *  edge. */
export function offsetPts(pts: PathPoint[], k: number): PathPoint[] {
  return pts.map((p, i) => {
    const q = pts[Math.min(i + 1, pts.length - 1)]!
    const r0 = pts[Math.max(i - 1, 0)]!
    const dx = q.x - r0.x
    const dy = q.y - r0.y
    const l = Math.hypot(dx, dy) || 1
    return { x: p.x - (dy / l) * p.w * k, y: p.y + (dx / l) * p.w * k, w: p.w }
  })
}
