// =============================================================================
// VELO Frontend -- placeholder token contract (FE-79 + PROMPT №679)
// =============================================================================
// FE-79 asked for screen «Новое событие» placeholders «noticeably fainter»
// than typed text -- a user had taken the long «Мысли» hint for her own input.
// №679 (owner option B) had moved them the other way for WCAG: the DS token
// --velo-text-placeholder is 90% alpha of the text hue, the minimum clean
// value clearing 4.5:1 (4.75:1) -- and same-hue alpha cannot satisfy both
// asks at once: text (#4c6589) measures 5.95:1 while the 4.5:1 ceiling
// composites to 4.75:1, a gap no eye separates.
//
// The FE-79 resolution (screen-scoped, pending the owner's global-vs-screen
// ruling): the GLOBAL token keeps №679's value byte-exact -- fading the app's
// other ~10 placeholder consumers is the owner's call -- while .ea (the one
// screen) re-points it at --velo-text-placeholder-faint: a desaturated,
// lighter blue-grey at №679's own contrast level (4.79:1) that earns the
// paleness on the axis alpha could not move, SATURATION (the text keeps its
// blue cast, the hint reads grey; HSL S 29% vs 17%).
//
// Neither existing gate can hold that balance: stylelint sees tokens, not
// ratios, and the DOM suite never applies SFC styles (vitest css is off).
// This suite pins it straight against the token canon and the screen's CSS
// wiring, token-law.test.ts's raw-source discipline:
//
//   1. №679 intact: --velo-text-placeholder is EXACTLY rgba(76,101,137,0.9)
//      -- a drive-by global fade must not slip in under FE-79's name;
//   2. the faint value clears 4.5:1 composited on --velo-bg-card-solid AND
//      stays visibly greyer than the text -- the saturation gap threshold
//      (8pp) is calibrated so №679's own 0.9-alpha value (5.9pp) FAILS it:
//      the gate holds THIS fix, not just any value over the WCAG bar;
//   3. every hint on the «Новое событие» screen rides the SAME token, and
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

const raw = import.meta.glob<string>(
  ['/src/views/user/ExternalActivityCreateView.vue', '/src/components/ui/VTextarea.vue'],
  {
    query: '?raw',
    import: 'default',
    eager: true,
  },
)

const createView = raw['/src/views/user/ExternalActivityCreateView.vue'] ?? ''
const vTextarea = raw['/src/components/ui/VTextarea.vue'] ?? ''

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

/** HSL lightness/saturation in percent -- paleness rides the saturation axis. */
function hslPercent([r, g, b]: Rgb): { l: number; s: number } {
  const max = Math.max(r, g, b) / 255
  const min = Math.min(r, g, b) / 255
  const l = (max + min) / 2
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1))
  return { l: l * 100, s: s * 100 }
}

// The paleness discriminator: how many saturation points the hint sits under
// the typed text. 8 is calibrated BETWEEN the two known values -- №679's
// rgba(76,101,137,0.9) composites to a 5.9pp gap (must FAIL), the FE-79 faint
// value sits at 11.6pp (must PASS) -- so the assertion holds this exact fix,
// not merely «some color over the WCAG bar».
const SATURATION_GAP_PP = 8

// -- The tokens this contract balances -------------------------------------------

const card = parseColor(tokenValue(variablesCss, '--velo-bg-card-solid'), [255, 255, 255])
const textPrimary = parseColor(tokenValue(variablesCss, '--velo-text-primary'), card)
const placeholderGlobal = parseColor(tokenValue(variablesCss, '--velo-text-placeholder'), card)
const placeholderFaint = parseColor(tokenValue(variablesCss, '--velo-text-placeholder-faint'), card)
const textMuted = parseColor(tokenValue(variablesCss, '--velo-text-muted'), card)

describe('placeholder token contract (FE-79 / PROMPT №679)', () => {
  it('the harness reads the canon: every token and rule this suite pins exists', () => {
    // A gate that cannot fire is decoration (token-law's rule): fail loudly
    // on a rename/misspelling instead of silently testing nothing.
    expect(variablesCss).toMatch(/--velo-text-placeholder-faint:/)
    expect(textPrimary).toEqual([76, 101, 137]) // #4c6589, the text hue
    expect(createView).toContain('ea__picker--empty')
    expect(vTextarea).toContain('v-textarea__field')
  })

  it('the color math reproduces the measurements the №679/FE-79 decisions cite', () => {
    // Self-test of the harness: black/white is exactly 21:1, and the numbers
    // recorded in variables.css' comment history re-derive from the declared
    // tokens -- the prose and the math cannot drift apart.
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 2)
    expect(contrast(textPrimary, card)).toBeCloseTo(5.95, 2)
    expect(contrast(textMuted, card)).toBeCloseTo(2.15, 2) // the pre-№679 outlier
    expect(contrast(placeholderGlobal, card)).toBeCloseTo(4.75, 2) // №679's pick
  })

  it('№679 intact: the GLOBAL placeholder token is byte-exact the owner-ruled value', () => {
    // FE-79 fades ONE screen; re-theming the app's other placeholder
    // consumers is the owner's pending global-vs-screen call. Whitespace is
    // normalized, the color itself is pinned.
    expect(tokenValue(variablesCss, '--velo-text-placeholder').replace(/\s+/g, '')).toBe(
      'rgba(76,101,137,0.9)',
    )
  })

  it('FE-79 rail: the faint value clears 4.5:1 AND stays noticeably greyer than the text', () => {
    // №679's WCAG bar holds...
    expect(contrast(placeholderFaint, card)).toBeGreaterThanOrEqual(4.5)
    // ...while the hint sits under the text in contrast and on BOTH
    // perceptual axes -- the saturation margin is what the old same-hue
    // alpha could never reach.
    expect(contrast(placeholderFaint, card)).toBeLessThan(contrast(textPrimary, card))
    const text = hslPercent(textPrimary)
    const hint = hslPercent(placeholderFaint)
    expect(hint.l - text.l).toBeGreaterThanOrEqual(3) // lightness gap, pp
    expect(text.s - hint.s).toBeGreaterThanOrEqual(SATURATION_GAP_PP) // the discriminator
  })

  it("the gate holds THIS fix: №679's own value would FAIL the saturation rail", () => {
    // The reason SATURATION_GAP_PP is 8, stated as an assertion: the
    // pre-FE-79 rgba(76,101,137,0.9) composites to a 5.9pp gap -- reverting
    // the faint value to it (the lazy «just darken the token» path) must
    // turn this suite red, and so must any future near-text retune.
    const old = hslPercent(placeholderGlobal)
    const text = hslPercent(textPrimary)
    expect(text.s - old.s).toBeLessThan(SATURATION_GAP_PP)
  })

  it('FE-79 wiring: the faint tint is SCOPED to «Новое событие», one token for every hint', () => {
    // The screen root re-points the DS token at the faint sibling -- every
    // placeholder inside .ea flips together, nothing outside .ea changes.
    expect(cssRule(createView, '.ea')).toMatch(
      /--velo-text-placeholder:\s*var\(--velo-text-placeholder-faint\)/,
    )
    // «Дата»/«Время»: an empty picker IS this screen's placeholder -- the
    // former --velo-text-muted ride was the 2.15:1 outlier №679 banned.
    expect(cssRule(createView, '.ea__picker--empty')).toMatch(
      /color:\s*var\(--velo-text-placeholder\)/,
    )
    // «Укажите ваш вариант»: the custom-variant input's own placeholder.
    expect(cssRule(createView, '.ea__custom-input::placeholder')).toMatch(
      /color:\s*var\(--velo-text-placeholder\)/,
    )
    // «Мысли»: VTextarea stays on the DS token UNTOUCHED -- it inherits the
    // faint value through .ea's scope, no :deep color override needed.
    expect(cssRule(vTextarea, '.v-textarea__field::placeholder')).toMatch(
      /color:\s*var\(--velo-text-placeholder\)/,
    )
  })
})
