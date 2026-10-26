// =============================================================================
// VELO Frontend -- token law: raw colors in *.ts (tz-whitelabel §3.1, step 0)
// =============================================================================
// The stylelint gate (pnpm lint:css) covers *.css and *.vue <style> blocks.
// TypeScript is NOT visible to it -- so a raw hex smuggled into a .ts literal
// (an SVG fill, a canvas paint, a manifest color) would ship a color the skin
// cannot retheme, exactly the «один зашитый #334D6E» hole §3.1 describes.
// This suite is that side of the lock: a raw color in ANY *.ts outside the
// exception registry is red.
//
// The registry -- explicit list with a reason (tz-whitelabel §3.1):
//   utils/schoolBranding/**  golden port of the curator branding generator;
//                            palettes/logo hex ARE the product data (the same
//                            exemption no-cyrillic.mjs carries)
//   platform/telegram.ts     platform boundary; tokenColor('--velo-…',
//                            fallback) is the «токен-первым» pattern
//   platform/zoom-sdk.ts     same boundary, same pattern
//   pwa/manifest.ts          build-time instance metadata; moves into the
//                            brand.json materialization (§1)
//   utils/displayHelpers.ts  MOOD_SCALE_FILLS -- the TS mirror of the
//                            analytics tokens (variables.css comment points
//                            back); same «токен-первым» fallback shape
//
// Comments are stripped before scanning (a ticket reference like «recon
// #589» is not a color; the TZ audit likewise excluded comment hits), with
// the same quote-aware stripper discipline no-cyrillic.mjs uses.
// =============================================================================

import { describe, expect, it } from 'vitest'

const tsFiles = import.meta.glob<string>('/src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
})

// The mood-scale icons are the one place a raw hex is LEGAL: as the second
// argument of a token-first var(). stylelint's color-no-hex is switched off
// for them (it cannot see inside var()), so THIS check is what keeps the
// exemption honest: every hex in those templates must sit inside
// var(--velo-…, #hex) — never bare.
const moodIconFiles = import.meta.glob<string>('/src/components/icons/IconMoodScale*.vue', {
  query: '?raw',
  import: 'default',
  eager: true,
})

/** Registry, relative to src/ (prefixes allowed). Keep in sync with the
 * banner above -- and with tz-whitelabel §3.1. */
const REGISTRY: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^utils\/schoolBranding\//, reason: 'golden port (product data)' },
  { pattern: /^platform\/(telegram|zoom-sdk)\.ts$/, reason: 'platform boundary, token-first' },
  { pattern: /^pwa\/manifest\.ts$/, reason: 'build-time instance metadata (F2 materializes)' },
  { pattern: /^utils\/displayHelpers\.ts$/, reason: 'MOOD_SCALE_FILLS mirror, token-first' },
]

const HEX = /#[0-9a-fA-F]{3,8}\b/g

/** Quote-aware JS comment stripper (line + block), keeping string contents
 * byte-identical -- the no-cyrillic.mjs discipline, ported to TS. */
export function stripJsComments(src: string): string {
  let out = ''
  let i = 0
  let quote: string | null = null
  while (i < src.length) {
    const ch = src[i]
    if (quote) {
      out += ch
      if (ch === '\\') {
        out += src[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i++
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ch
      i++
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      // indexOf, not a stride-2 scan: a stride can step OVER the closing
      // '*/' and leave the comment body in the output (the self-test below
      // pins exactly that case).
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? src.length : end + 2
      continue
    }
    out += ch
    i++
  }
  return out
}

describe('token law: no raw hex in *.ts outside the registry (tz-whitelabel §3.1)', () => {
  it('the detector works: comments hide hex, code does not', () => {
    // Self-test of the harness — a gate that cannot fire is decoration.
    const src = [
      '// recon #589 — a ticket ref, not a color', //
      '/* #deadbeef */',
      "const url = 'https://x/#anchor'",
      "const color = '#334D6E'",
    ].join('\n')
    const clean = stripJsComments(src)
    expect(clean.match(HEX)).toEqual(['#334D6E'])
    expect(clean).toContain('https://x/#anchor') // strings survive intact
  })

  it('every scanned source file sits outside the registry or inside it', () => {
    // Sanity on the harness itself: the glob must have seen the codebase,
    // and the registry must have actually matched something (a registry
    // whose patterns typo'd into nothing would silently «clean»).
    expect(Object.keys(tsFiles).length).toBeGreaterThan(100)
    expect(
      Object.keys(tsFiles).filter((path) =>
        REGISTRY.some((entry) => entry.pattern.test(path.replace(/^\/src\//, ''))),
      ).length,
    ).toBeGreaterThan(4)
    // The icon check below polices an OFF stylelint rule for these files -- a
    // glob that matched nothing would silently exempt them instead.
    expect(Object.keys(moodIconFiles).length).toBeGreaterThanOrEqual(5)
  })

  it('raw hex appears only inside the exception registry', () => {
    const violations: string[] = []
    for (const [rawPath, content] of Object.entries(tsFiles)) {
      const path = rawPath.replace(/^\/src\//, '')
      if (path.includes('.test.')) continue // tests pin hex on purpose
      if (REGISTRY.some((entry) => entry.pattern.test(path))) continue
      const clean = stripJsComments(content)
      const lines = clean.split('\n')
      lines.forEach((line, index) => {
        for (const match of line.matchAll(HEX)) {
          violations.push(`${path}:${index + 1}: ${match[0]} in ${line.trim().slice(0, 80)}`)
        }
      })
    }
    expect(violations).toEqual([])
  })

  it('the mood-scale icons carry hex only inside a token-first var() fallback', () => {
    // stylelint's color-no-hex is OFF for these five files (it cannot see
    // inside var()); this check is what keeps that exemption honest.
    const violations: string[] = []
    for (const [rawPath, content] of Object.entries(moodIconFiles)) {
      const path = rawPath.replace(/^\/src\//, '')
      const lines = content.split('\n')
      lines.forEach((line, index) => {
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
        for (const match of line.matchAll(HEX)) {
          const insideFallback = /var\(--velo-[^)]*#[0-9a-fA-F]{3,8}\)/.test(line)
          if (!insideFallback) {
            violations.push(
              `${path}:${index + 1}: ${match[0]} outside var() in ${trimmed.slice(0, 80)}`,
            )
          }
        }
      })
    }
    expect(violations).toEqual([])
  })
})
