/*
  VELO Frontend -- schoolBranding/hash (tz-curator.md §5.1/§5.3)

  Детерминированная база генератора фирменного стиля школы (утверждённый
  прототип 2026-09-19, перенесён без изменений -- константы и округления не
  трогать: тот же хэш обязан давать тот же SVG, детерминизм закреплён
  golden-тестами).
*/

/** 32-битный FNV-1a: сид для PRNG и синхронный fallback хэша. */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (const ch of str) {
    h ^= ch.codePointAt(0)!
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32: сидированный PRNG, последовательность зависит только от сида. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Хэш школы: SHA-256("school:" + name), первые 16 hex-символов (§5.1).
 * crypto.subtle доступен только в secure context (Telegram Mini App -- ок);
 * вне его -- синхронный fallback fnv1a×2 из прототипа, тоже 16 hex-символов.
 * Когда бэк начнёт отдавать стабильный branding_hash (§5.2, вариант B),
 * фронт переключается на поле -- сигнатура это позволяет.
 */
export async function schoolHashFromName(name: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    const buf = await subtle.digest('SHA-256', new TextEncoder().encode('school:' + name))
    return [...new Uint8Array(buf)]
      .slice(0, 8)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }
  const h = fnv1a(name)
  const h2 = fnv1a(h + ':' + name)
  return h.toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
}
