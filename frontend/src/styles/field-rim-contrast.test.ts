// =============================================================================
// VELO Frontend -- field rim and focus ring (FE-249)
// =============================================================================
// A text field is a white plate. With no rim at rest the plate edge read 1.04-1.10:1
// against the page (WCAG 1.4.11 asks 3:1 for the edge of a control). The rim is the
// token --velo-border-input-rest and the focus ring is --velo-border-input-ring, so a
// skin can change both; this suite pins what the core ships, token-law's raw-source
// discipline (the same reading helpers as placeholder-contrast.test.ts):
//
//   1. the rim clears 3:1 against the white plate on the core palette;
//   2. the focus ring clears 3:1 and is never paler than the rim at rest (a focused
//      field must not look weaker than an idle one);
//   3. every rule that draws a field's rim reads the rim token, and every focus
//      rule reads the ring tokens, each rule checked on its own.
// =============================================================================

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// variables.css is read from disk off the project root vitest runs from (vite's
// ?raw glob hands CSS back empty under the css:false pipeline).
const variablesCss = readFileSync(resolve(process.cwd(), 'src/styles/variables.css'), 'utf8')

const kit = (name: string): string =>
  readFileSync(
    resolve(process.cwd(), `../packages/velo-ui/src/components/${name}/${name}.vue`),
    'utf8',
  )

// -- CSS reading helpers --------------------------------------------------------

/** Drop /*…*\/ CSS comments so a value cited in prose cannot satisfy a check. */
function stripCssComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Raw declared value of a custom property ("" when absent). */
function tokenValue(name: string): string {
  const match = stripCssComments(variablesCss).match(new RegExp(`${name}:\\s*([^;]+);`))
  return match?.[1]?.trim() ?? ''
}

/** Body of the rule that STARTS with `selector` ("" when there is none). */
function cssRule(src: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = stripCssComments(src).match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`))
  return match?.[1] ?? ''
}

// -- Color math (WCAG 2.x relative luminance) -----------------------------------

type Rgb = [number, number, number]

function hex(value: string): Rgb {
  const m = value.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/)
  if (!m) throw new Error(`unsupported color: ${value}`)
  return [parseInt(m[1] ?? '', 16), parseInt(m[2] ?? '', 16), parseInt(m[3] ?? '', 16)]
}

/** A token's color: a #rrggbb literal, an alias var(--x), or an srgb mix of two of those. */
function color(value: string): Rgb {
  const v = value.trim()
  const alias = v.match(/^var\((--[\w-]+)\)$/)
  if (alias?.[1]) return color(tokenValue(alias[1]))
  const mix = v.match(
    /^color-mix\(\s*in srgb,\s*(var\(--[\w-]+\)|#[0-9a-fA-F]{6})\s+(\d+)%,\s*(var\(--[\w-]+\)|#[0-9a-fA-F]{6})\s*\)$/,
  )
  if (!mix) return hex(v)
  const [, first = '', share = '0', second = ''] = mix
  const a = color(first)
  const b = color(second)
  const p = Number(share) / 100
  const channel = (i: 0 | 1 | 2): number => Math.round(a[i] * p + b[i] * (1 - p))
  return [channel(0), channel(1), channel(2)]
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(a: Rgb, b: Rgb): number {
  const hi = Math.max(luminance(a), luminance(b))
  const lo = Math.min(luminance(a), luminance(b))
  return (hi + 0.05) / (lo + 0.05)
}

const plate = color(tokenValue('--velo-bg-card-solid'))
const rim = color(tokenValue('--velo-border-input-rest'))
const ring = color(tokenValue('--velo-border-input-ring'))

describe('field rim and focus ring on the core palette (FE-249)', () => {
  it('the rim clears 3:1 against the white plate', () => {
    expect(contrast(rim, plate)).toBeGreaterThanOrEqual(3)
  })

  it('the focus ring clears 3:1 and is not paler than the rim at rest', () => {
    expect(contrast(ring, plate)).toBeGreaterThanOrEqual(3)
    expect(contrast(ring, plate)).toBeGreaterThanOrEqual(contrast(rim, plate))
  })
})

describe('the rules of the field components read the tokens (FE-249)', () => {
  it.each([
    ['VInput', '.v-input__field'],
    ['VInput', '.v-input__box'],
    ['VSelect', '.v-select__field'],
    ['VTextarea', '.v-textarea__field'],
    ['VTextarea', '.v-textarea__takeover--plate'],
  ])('%s %s draws its rim at rest with the rim token', (name, selector) => {
    expect(cssRule(kit(name), selector)).toMatch(/border:[^;]*var\(--velo-border-input-rest\)/)
  })

  it.each([
    ['VInput', '.v-input__field:focus'],
    ['VInput', '.v-input__box:focus-within'],
    ['VSelect', '.v-select__field:focus'],
    ['VTextarea', '.v-textarea__field:focus'],
  ])('%s %s draws the ring from the ring tokens', (name, selector) => {
    const rule = cssRule(kit(name), selector)
    expect(rule).toMatch(/border-color:\s*var\(--velo-border-input-ring\)/)
    expect(rule).toMatch(/box-shadow:\s*var\(--velo-shadow-field-focus\)/)
  })

  it('the focus shadow token is the ring color, one border width wide', () => {
    expect(tokenValue('--velo-shadow-field-focus')).toBe(
      'inset 0 0 0 var(--velo-border-width) var(--velo-border-input-ring)',
    )
  })
})
