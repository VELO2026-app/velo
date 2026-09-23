/*
  VELO Frontend -- schoolBranding/mandala (tz-curator.md §5.3)

  Рендер мандалы -- чистая функция от params. Центр в (0,0), максимальный
  радиус ~79. Три крупные зоны: ядро, венец, корона. Порт прототипа; в
  прототипе mandalaGroup мутировала m.mainRing -- здесь этого нет.
*/

import type { SchoolBrandingParams } from './params'
import { diamond, petal, scallop } from './geometry'

export function mandalaGroup(P: SchoolBrandingParams): string {
  const c = P.style.palette
  const m = P.mandala
  const k = P.style.k
  const rot = m.rot
  const mainColor = P.style.colorway === 'mid' ? 'mid' : 'deep'
  const crownColor =
    P.style.colorway === 'duo' ? 'accent' : P.style.colorway === 'mid' ? 'deep' : 'mid'
  let s = ''

  // ядро: точка + кольцо
  s += `<circle r="${m.core.dot.toFixed(2)}" fill="${c[mainColor]}"/>`
  s += `<circle r="${m.core.ringR.toFixed(2)}" fill="none" stroke="${c[crownColor]}" stroke-width="2.6"/>`
  if (m.core.dots) {
    for (let i = 0; i < m.core.dots.n; i++) {
      const a = (((i * 360) / m.core.dots.n + rot) * Math.PI) / 180
      s += `<circle cx="${(Math.cos(a) * m.core.dots.r).toFixed(2)}" cy="${(Math.sin(a) * m.core.dots.r).toFixed(2)}" r="${m.core.dots.size.toFixed(2)}" fill="${c.accent}"/>`
    }
  }

  // главный венец: подложка (в полшага, светлее) + крупные лепестки
  const M = m.main
  const shape = P.style.main
  for (let i = 0; i < k; i++) {
    const a = (((i * 360) / k + rot + 180 / k) * Math.PI) / 180
    if (shape === 'diamond')
      s += `<path d="${diamond(a, (M.r0 + M.r1) / 2, M.w, ((M.r1 - M.r0) / 2) * 0.92)}" fill="${c.soft}"/>`
    else s += `<path d="${petal(a, M.r0, M.r1 * 0.97, M.w * 1.05, 0.5)}" fill="${c.soft}"/>`
  }
  for (let i = 0; i < k; i++) {
    const a = (((i * 360) / k + rot) * Math.PI) / 180
    if (shape === 'diamond')
      s += `<path d="${diamond(a, (M.r0 + M.r1) / 2, M.w * 0.9, (M.r1 - M.r0) / 2)}" fill="${c[mainColor]}"/>`
    else
      s += `<path d="${petal(a, M.r0, M.r1, M.w, shape === 'teardrop' ? 0.66 : 0.5)}" fill="${c[mainColor]}"/>`
  }

  // один разделитель
  s += `<circle r="${m.divider.toFixed(2)}" fill="none" stroke="${c.mid}" stroke-width="2"/>`

  // корона: одна крупная зона
  const C = m.crown
  if (P.style.crown === 'petals') {
    for (let i = 0; i < k; i++) {
      const a = (((i * 360) / k + rot + 180 / k) * Math.PI) / 180
      s += `<path d="${petal(a, C.r0, C.r1, C.w, 0.5)}" fill="${c[crownColor]}"/>`
    }
  } else if (P.style.crown === 'scallops') {
    s += `<path d="${scallop(C.r0 - 2, C.r1, k, (rot * Math.PI) / 180)}" fill="none" stroke="${c[crownColor]}" stroke-width="3.6" stroke-linecap="round"/>`
    for (let i = 0; i < k; i++) {
      const a = (((i * 360) / k + rot + 180 / k) * Math.PI) / 180
      s += `<circle cx="${(Math.cos(a) * (C.r0 + 1)).toFixed(2)}" cy="${(Math.sin(a) * (C.r0 + 1)).toFixed(2)}" r="2.6" fill="${c.accent}"/>`
    }
  } else {
    for (let i = 0; i < k; i++) {
      const a = (((i * 360) / k + rot) * Math.PI) / 180
      s += `<path d="${diamond(a, (C.r0 + C.r1) / 2, C.w, (C.r1 - C.r0) / 2)}" fill="${c[crownColor]}"/>`
    }
  }

  return s
}

/** Полный SVG мандалы 200×200 (как логотип, но без плашки и тени). */
export function mandalaSvg(P: SchoolBrandingParams): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><g transform="translate(100 100) scale(.8)">${mandalaGroup(P)}</g></svg>`
}
