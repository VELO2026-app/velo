/*
  VELO Frontend -- schoolBranding/noise (tz-curator.md §5.3)

  Природный шум и цветовые утилиты. Порт прототипа -- формулы и константы
  не трогать (golden-тесты сверяются с эталоном).
*/

import { fnv1a } from './hash'

const TAU_INTERNAL = Math.PI * 2

/**
 * Детерминированный сглаженный value-noise на решётке (сидируется хэшем
 * школы). Плавный шум = крупные "природные" формы; резкий случайный шум
 * выглядел бы механически.
 */
export function makeNoise(seedStr: string): (x: number, y: number) => number {
  const base = fnv1a(seedStr)
  const h = (xi: number, yi: number): number => {
    let n = Math.imul(xi, 374761393) ^ Math.imul(yi, 668265263) ^ base
    n = Math.imul(n ^ (n >>> 13), 1274126177)
    n ^= n >>> 16
    return ((n >>> 0) % 65536) / 65536
  }
  const fade = (t: number): number => t * t * (3 - 2 * t)
  return (x: number, y: number): number => {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const xf = x - xi
    const yf = y - yi
    const a = h(xi, yi)
    const b = h(xi + 1, yi)
    const c2 = h(xi, yi + 1)
    const d = h(xi + 1, yi + 1)
    const u = fade(xf)
    const v = fade(yf)
    return a + (b - a) * u + (c2 - a) * v + (a - b - c2 + d) * u * v
  }
}

/** Кратчайшая дуговая интерполяция углов. */
export function mixAngle(a: number, b: number, t: number): number {
  const d = ((b - a + Math.PI * 3) % TAU_INTERNAL) - Math.PI
  return a + d * t
}

/** Смешивание цветов: приглушение тона ленты к её хвосту (как в акварели). */
export function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16)
  const pb = parseInt(b.slice(1), 16)
  const ch = (x: number, y: number): number =>
    Math.round(((x >> 16) & 255) * (1 - t) + ((y >> 16) & 255) * t)
  const ch2 = (x: number, y: number): number =>
    Math.round(((x >> 8) & 255) * (1 - t) + ((y >> 8) & 255) * t)
  const ch3 = (x: number, y: number): number => Math.round((x & 255) * (1 - t) + (y & 255) * t)
  return (
    '#' +
    [ch(pa, pb), ch2(pa, pb), ch3(pa, pb)].map((v) => v.toString(16).padStart(2, '0')).join('')
  )
}

/** Профиль ширины ленты: тонкий вход, толстое тело, сходящий на нет хвост. */
export function rampW(t: number): number {
  const inR = Math.min(1, t / 0.12)
  const s = inR * inR * (3 - 2 * inR)
  const out = t > 0.8 ? Math.max(0.12, 1 - ((t - 0.8) / 0.2) * 0.88) : 1
  return s * out
}
