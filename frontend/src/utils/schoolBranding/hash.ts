/*
  VELO Frontend -- schoolBranding/hash (tz-curator.md §5.1/§5.3)

  Deterministic base of the school branding generator (owner-approved
  prototype 2026-09-19, ported unchanged -- do not touch the constants and
  rounding: the same hash MUST yield the same SVG; determinism is pinned by
  the golden tests).
*/

/** 32-bit FNV-1a: the PRNG seed and the synchronous hash fallback. */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (const ch of str) {
    h ^= ch.codePointAt(0)!
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32: a seeded PRNG whose sequence depends only on the seed. */
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
 * School hash: SHA-256("school:" + name), first 16 hex chars (§5.1).
 * crypto.subtle is available only in a secure context (the Telegram Mini App
 * qualifies); outside it -- the prototype's synchronous fnv1a×2 fallback,
 * also 16 hex chars. Once the backend starts serving a stable branding_hash
 * (§5.2, option B), the frontend switches to the field -- the signature
 * already allows it.
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
