/*
  VELO Frontend -- schoolBranding/params (tz-curator.md §5.3)

  Хэш → параметры стиля. Всё разнообразие решается здесь; рендер
  (mandala/logo/banner) -- чистая функция от params. Порт прототипа:
  константы диапазонов не трогать (golden-тесты сверяются с эталоном).
*/

import { fnv1a, mulberry32 } from './hash'
import { PALETTES, type Palette } from './palettes'

/** Немного крупных зон вместо множества мелких -- так читается на телефоне. */
function helpers(rng: () => number) {
  return {
    f: (a: number, b: number): number => a + rng() * (b - a),
    i: (a: number, b: number): number => Math.floor(a + rng() * (b - a + 1)),
    pick: <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)]!,
    chance: (p: number): boolean => rng() < p,
  }
}

export interface BrandingStyle {
  palette: Palette
  k: number // симметрия
  main: 'round' | 'teardrop' | 'diamond'
  crown: 'petals' | 'scallops' | 'diamonds'
  colorway: 'deep' | 'mid' | 'duo'
}

export interface MandalaParams {
  rot: number
  core: {
    dot: number
    ringR: number
    dots: { r: number; n: number; size: number } | null
  }
  main: { r0: number; r1: number; w: number }
  divider: number
  crown: { r0: number; r1: number; w: number }
  curlsDir: number
}

export interface BannerBand {
  alpha: number
  arc: number
  r0: number
  W: number
  drift: number
  tuck: number
  Wg: number
  ox: number
  oy: number
  color: 'deep' | 'mid' | 'soft' | 'accent'
  opacity: number
}

export interface BannerTail {
  alpha: number
  arc: number
  r0: number
  grow: number
  W: number
  color: 'mid' | 'soft' | 'accent'
  opacity: number
}

export interface BannerParams {
  glow: { cx: number; cy: number; r: number }
  grainSeed: number
  swirl: {
    cx: number
    cy: number
    dir: number
    bands: BannerBand[]
    tails: BannerTail[]
    wobble: number
    nSeed: number
  }
  mountains: {
    ridges: Array<{
      pts: Array<[number, number]>
      color: 'soft' | 'mid'
      blur: number
      opacity: number
    }>
    fog: { y: number; h: number; w: number; opacity: number }
  } | null
  leaves: {
    x: number
    y: number
    items: Array<{
      a: number
      len: number
      w: number
      color: 'mid' | 'deep' | 'accent'
      opacity: number
    }>
  } | null
}

export interface SchoolBrandingParams {
  hash: string
  style: BrandingStyle
  mandala: MandalaParams
  bg: BannerParams
}

/** Гауссовы вершины суммируются в природный хребет. */
function mkPeaks(endX: number, hMax: number, R: ReturnType<typeof helpers>) {
  const peaks: Array<{ x: number; h: number; w: number }> = []
  let x = R.f(0, 90)
  while (x < endX) {
    peaks.push({ x, h: hMax * R.f(0.35, 1), w: R.f(55, 150) })
    x += R.f(90, 190)
  }
  return peaks
}

function mkRange(
  peaks: Array<{ x: number; h: number; w: number }>,
  baseY: number,
): Array<[number, number]> {
  const pts: Array<[number, number]> = [[-60, 620]]
  for (let x = -60; x <= 940; x += 16) {
    let y = baseY
    for (const p of peaks) y -= p.h * Math.exp(-((x - p.x) ** 2) / (2 * p.w * p.w))
    pts.push([x, y])
  }
  pts.push([1000, 620])
  return pts
}

/**
 * Хэш → параметры. «Роза-вихрь» фона: вложенные широкие ленты плотно
 * упаковывают диск (ширина ≈ шагу спирали), швы каждой следующей повёрнуты,
 * тона чередуются контрастно, из-под внешних витков вылетают тонкие струи.
 * Плюс горы и листья.
 */
export function generateParams(hashHex: string): SchoolBrandingParams {
  const rng = mulberry32(fnv1a(hashHex))
  const R = helpers(rng)

  const style: BrandingStyle = {
    palette: R.pick(PALETTES),
    k: R.pick([8, 10, 12]), // симметрия
    main: R.pick(['round', 'teardrop', 'diamond']), // форма главного венца
    crown: R.pick(['petals', 'scallops', 'diamonds']), // внешняя корона
    colorway: R.pick(['deep', 'mid', 'duo']), // распределение тонов
  }

  const mandala: MandalaParams = {
    rot: R.f(0, 360),
    core: {
      dot: R.f(4.5, 6),
      ringR: R.f(9.5, 11.5),
      dots: R.chance(0.7) ? { r: R.f(13.5, 15.5), n: R.pick([4, 6]), size: R.f(2.2, 3.2) } : null,
    },
    main: { r0: R.f(17, 20), r1: R.f(44, 48), w: R.f(6.5, 9.5) },
    divider: R.f(50.5, 53.5),
    crown: { r0: R.f(55, 58), r1: R.f(74, 79), w: R.f(4.5, 6.5) },
    curlsDir: R.chance(0.5) ? 1 : -1,
  }

  // NB: в прототипе здесь создавался makeNoise(hashHex), но переменная была
  // мёртвой (шум фона сидируется в banner.ts из того же хэша) -- не портируем.
  const bg: BannerParams = (() => {
    const wraps = R.i(4, 6)
    const rIn = R.f(30, 46)
    const RR = R.f(340, 410)
    const pitch = (RR - rIn) / wraps
    const dir = R.chance(0.5) ? 1 : -1
    const roles = ['deep', 'mid', 'soft', 'accent'] as const
    const bands: BannerBand[] = []
    let ox = 0
    let oy = 0
    let prevRole: string | null = null
    for (let i = 0; i < wraps; i++) {
      ox += R.f(-9, 9)
      oy += R.f(-9, 9) // центр ролла слегка «гуляет»
      let role: (typeof roles)[number]
      do {
        role = R.pick([...roles])
      } while (role === prevRole) // соседние ленты контрастны
      prevRole = role
      bands.push({
        alpha: dir * i * R.f(0.5, 0.95),
        arc: R.f(2.3, 2.95) * Math.PI,
        r0: rIn + (i + 0.5) * pitch,
        W: pitch * R.f(0.95, 1.18),
        drift: R.f(0.12, 0.35) * pitch,
        tuck: pitch * R.f(0.25, 0.45),
        Wg: R.f(0.15, 0.45),
        ox,
        oy,
        color: role,
        opacity: R.f(0.88, 0.97),
      })
    }
    const tails: BannerTail[] = Array.from({ length: R.i(1, 2) }, () => {
      const arc = R.f(1.6, 2.6)
      const endA = R.f(Math.PI * 1.05, Math.PI * 1.5) // струи улетают влево-вверх
      return {
        alpha: endA - dir * arc,
        arc,
        r0: RR * R.f(0.5, 0.75),
        grow: R.f(0.7, 1.5),
        W: R.f(16, 34),
        color: R.pick(['mid', 'soft', 'accent']),
        opacity: R.f(0.5, 0.68),
      }
    })
    return {
      glow: { cx: R.f(430, 560), cy: R.f(230, 300), r: R.f(260, 330) },
      grainSeed: R.i(1, 999),
      swirl: {
        cx: R.f(760, 880),
        cy: R.f(210, 280),
        dir,
        bands,
        tails,
        wobble: R.f(6, 12),
        nSeed: R.f(0, 500),
      },
      mountains: R.chance(0.92)
        ? {
            // хребты разного масштаба: далёкие пики, средний план, предгорья
            ridges: [
              {
                pts: mkRange(mkPeaks(R.f(650, 880), R.f(260, 360), R), R.f(575, 605)),
                color: 'soft' as const,
                blur: 4.5,
                opacity: R.f(0.25, 0.35),
              },
              {
                pts: mkRange(mkPeaks(R.f(560, 780), R.f(170, 260), R), R.f(565, 595)),
                color: 'soft' as const,
                blur: 3,
                opacity: R.f(0.28, 0.4),
              },
              {
                pts: mkRange(mkPeaks(R.f(480, 680), R.f(90, 160), R), R.f(555, 585)),
                color: 'mid' as const,
                blur: 1.8,
                opacity: R.f(0.3, 0.42),
              },
            ],
            fog: { y: R.f(470, 520), h: R.f(120, 190), w: R.f(720, 950), opacity: R.f(0.45, 0.65) },
          }
        : null,
      leaves: R.chance(0.7)
        ? {
            x: R.f(860, 1060),
            y: R.f(450, 560),
            items: Array.from({ length: R.i(2, 4) }, () => ({
              a: R.f(-Math.PI * 0.85, -Math.PI * 0.15),
              len: R.f(60, 120),
              w: R.f(9, 17),
              color: R.pick(['mid', 'deep', 'accent']),
              opacity: R.f(0.5, 0.75),
            })),
          }
        : null,
    }
  })()

  return { hash: hashHex, style, mandala, bg }
}
