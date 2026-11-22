// =============================================================================
// VELO Frontend -- placeholder token contract (FE-79 + PROMPT №679)
// =============================================================================
// FE-79 asked for the new-event screen
// (i18n:user.screens.externalActivityCreate.title) placeholders "noticeably
// fainter" than typed text -- a user had taken the long thoughts hint
// (i18n:user.screens.externalActivityCreate.thoughts.label) for her own input.
// №679 (owner option B) had moved them the other way for WCAG: the DS token
// --velo-text-placeholder is 90% alpha of the text hue, the minimum clean
// value clearing 4.5:1.
//
// The FE-79 resolution (screen-scoped): the GLOBAL token keeps №679's rule,
// while .ea (the one screen) re-points it at --velo-text-placeholder-faint,
// a lighter value at the same contrast level.
//
// FE-230: the core's colours are neutral greys; the golden VELO values (and
// their saturation gap, HSL S 29% vs 17%) live in the velo-brand skin
// package. This suite pins the rules on the core's own values and the
// screen's CSS wiring, token-law.test.ts's raw-source discipline:
//
//   1. №679 holds: the global placeholder clears 4.5:1 composited on
//      --velo-bg-card-solid;
//   2. the faint value clears 4.5:1 AND sits under the typed text in
//      contrast and lightness;
//   3. every hint on the new-event screen rides the SAME token, and
//      that token resolves to the faint sibling inside .ea only.
// =============================================================================

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// variables.css cannot come through vite's ?raw glob: vitest's css:false
// pipeline hands CSS module ids back EMPTY (measured), and happy-dom rewrites
// import.meta.url to an http scheme -- so the token canon is read from disk
// off the project root vitest runs from.
const variablesCss = readFileSync(resolve(process.cwd(), 'src/styles/variables.css'), 'utf8')

const raw = import.meta.glob<string>(['/src/views/user/ExternalActivityCreateView.vue'], {
  query: '?raw',
  import: 'default',
  eager: true,
})

const createView = raw['/src/views/user/ExternalActivityCreateView.vue'] ?? ''
// FE-153: VTextarea is a kit resident now -- read off disk like the token
// canon (the package sits outside the app root the glob is anchored to).
const vTextarea = readFileSync(
  resolve(process.cwd(), '../packages/velo-ui/src/components/VTextarea/VTextarea.vue'),
  'utf8',
)

// -- CSS reading helpers --------------------------------------------------------

/** Drop /*…*\/ CSS comments so a hex cited in prose cannot satisfy a check. */
function stripCssComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Raw declared value of a custom property ("" when absent). */
function tokenValue(src: string, name: string): string {
  const match = stripCssComments(src).match(new RegExp(`${name}:\\s*([^;]+);`))
  return match?.[1]?.trim() ?? ''
}

/** Body of a CSS rule ("" when the selector does not exist). */
function cssRule(src: string, selector: string): string {
  const match = stripCssComments(src).match(
    new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`),
  )
  return match?.[1] ?? ''
}

// -- Color math (WCAG 2.x relative luminance; the formulas №679 measured with) --

type Rgb = [number, number, number]

function parseColor(value: string, bg: Rgb): Rgb {
  const solid = value.match(/^#([0-9a-fA-F]{6})$/)?.[1]
  if (solid) {
    return [
      parseInt(solid.slice(0, 2), 16),
      parseInt(solid.slice(2, 4), 16),
      parseInt(solid.slice(4, 6), 16),
    ]
  }
  const rgba = value.match(
    /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/,
  )
  if (rgba) {
    // Alpha composites over the field surface -- how №679 measured the tokens.
    const [r, g, b, a = '1'] = rgba.slice(1) as [string, string, string, string?]
    const alpha = Number(a)
    return [
      Number(r) * alpha + bg[0] * (1 - alpha),
      Number(g) * alpha + bg[1] * (1 - alpha),
      Number(b) * alpha + bg[2] * (1 - alpha),
    ]
  }
  throw new Error(`unsupported color literal: ${value}`)
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

/** HSL lightness in percent. */
function lightness([r, g, b]: Rgb): number {
  return ((Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255) * 100
}

// -- The tokens this contract balances -------------------------------------------

const card = parseColor(tokenValue(variablesCss, '--velo-bg-card-solid'), [255, 255, 255])
const placeholderGlobal = parseColor(tokenValue(variablesCss, '--velo-text-placeholder'), card)
const placeholderFaint = parseColor(tokenValue(variablesCss, '--velo-text-placeholder-faint'), card)
const textMuted = parseColor(tokenValue(variablesCss, '--velo-text-muted'), card)

describe('placeholder token contract (FE-79 / PROMPT №679)', () => {
  it('the harness reads the canon: every token and rule this suite pins exists', () => {
    // A gate that cannot fire is decoration (token-law's rule): fail loudly
    // on a rename/misspelling instead of silently testing nothing.
    expect(variablesCss).toMatch(/--velo-text-placeholder-faint:/)
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 2)
    expect(createView).toContain('ea__picker--empty')
    expect(vTextarea).toContain('v-textarea__field')
  })

  it('№679 holds: the global placeholder clears 4.5:1 where muted text does not', () => {
    expect(contrast(placeholderGlobal, card)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(textMuted, card)).toBeLessThan(4.5)
  })

  it('FE-79 rail: the faint value clears 4.5:1 AND stays paler than the global placeholder', () => {
    expect(contrast(placeholderFaint, card)).toBeGreaterThanOrEqual(4.5)
    // Fainter than the hint it replaces on the new-event screen -- in
    // contrast and in lightness -- and so fainter than the typed text too.
    expect(contrast(placeholderFaint, card)).toBeLessThan(contrast(placeholderGlobal, card))
    expect(lightness(placeholderFaint)).toBeGreaterThan(lightness(placeholderGlobal))
  })

  it('FE-79 wiring: the faint tint is SCOPED to «Новое событие», one token for every hint', () => {
    // The screen root re-points the DS token at the faint sibling -- every
    // placeholder inside .ea flips together, nothing outside .ea changes.
    expect(cssRule(createView, '.ea')).toMatch(
      /--velo-text-placeholder:\s*var\(--velo-text-placeholder-faint\)/,
    )
    // The date/time pickers (i18n:user.screens.externalActivityCreate.fields.date,
    // i18n:user.screens.externalActivityCreate.fields.time): an empty picker IS
    // this screen's placeholder -- the former --velo-text-muted ride was the
    // 2.15:1 outlier №679 banned.
    expect(cssRule(createView, '.ea__picker--empty')).toMatch(
      /color:\s*var\(--velo-text-placeholder\)/,
    )
    // The custom-variant input's own placeholder (i18n:practice.customVariant).
    expect(cssRule(createView, '.ea__custom-input::placeholder')).toMatch(
      /color:\s*var\(--velo-text-placeholder\)/,
    )
    // The thoughts field (i18n:user.screens.externalActivityCreate.thoughts.label):
    // VTextarea stays on the DS token UNTOUCHED -- it inherits the
    // faint value through .ea's scope, no :deep color override needed.
    expect(cssRule(vTextarea, '.v-textarea__field::placeholder')).toMatch(
      /color:\s*var\(--velo-text-placeholder\)/,
    )
  })
})
