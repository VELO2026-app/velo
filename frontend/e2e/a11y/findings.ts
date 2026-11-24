/**
 * The accessibility gate's pure logic (FE-241): turn an axe result into the
 * findings that fail a test. No browser here -- the spec (./a11y.spec.ts)
 * runs axe and the page probe; this module decides what counts.
 *
 * Two kinds of exceptions, never one rule switched off wholesale:
 *   - the skin package's own `contrastExceptions` (contract 2.1): the pair the
 *     package declared and validate-skin already accepts down to 3:1 -- read
 *     from the package, not copied here;
 *   - ./allowlist.ts: a known violation of one rule on one screen, with its
 *     reason and the task that fixes it.
 */
import type { AxeResults, Result } from 'axe-core'

/** WCAG 2.1 A and AA, plus the rules the task names that axe keeps outside that set. */
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const
/** Heading order (best-practice) and label in name, WCAG 2.5.3 (experimental). */
export const EXTRA_RULES = ['heading-order', 'label-content-name-mismatch'] as const

/** The floor a declared contrast exception holds (validate-skin EXCEPTION_FLOOR). */
export const EXCEPTION_FLOOR = 3.0

/** One entry of the package's `contrastExceptions`. */
export interface ContrastException {
  /** Token path of the text color, e.g. `velo.text.secondary`. */
  text: string
  /** Token path of the surface color, e.g. `velo.bg.card.solid`. */
  surface: string
  reason: string
}

/** The pair validate-skin lets a package declare (EXCEPTION_PAIRS there). */
export const EXCEPTION_TEXT = 'velo.text.secondary'
export const EXCEPTION_SURFACE = 'velo.bg.card.solid'

/** `rgb(...)`/`rgba(...)` as numbers; null for any other color syntax. */
function parseRgb(css: string): { r: number; g: number; b: number; a: number } | null {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(
    css.trim(),
  )
  if (!m) return null
  const raw = m[4]
  const a = raw === undefined ? 1 : raw.endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw)
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a }
}

/**
 * The declared pair as painted: the text color (often translucent -- the
 * golden secondary text is 70% of the text hue) blended over the surface the
 * way axe blends it, each channel rounded. Null if either color cannot be read
 * or the surface is not opaque.
 */
export function pairFromCss(textCss: string, surfaceCss: string): ResolvedPair | null {
  const t = parseRgb(textCss)
  const s = parseRgb(surfaceCss)
  if (!t || !s || s.a !== 1) return null
  const hex = (n: number): string => Math.round(n).toString(16).padStart(2, '0')
  const mix = (f: number, b: number): string => hex(f * t.a + b * (1 - t.a))
  return {
    text: `#${mix(t.r, s.r)}${mix(t.g, s.g)}${mix(t.b, s.b)}`,
    surface: `#${hex(s.r)}${hex(s.g)}${hex(s.b)}`,
  }
}

/** A color token of the package whose value is a plain hex. */
export interface HexToken {
  css: string
  hex: string
}

/**
 * The plain-hex color tokens of a package's DTCG file as CSS names
 * (`velo.tg.header` -> `--velo-tg-header`). The spec compares them with what
 * the page paints, so a stale or wrong build cannot pass for the skin under test.
 */
export function hexTokens(doc: unknown, path: string[] = []): HexToken[] {
  if (typeof doc !== 'object' || doc === null) return []
  const out: HexToken[] = []
  for (const [key, value] of Object.entries(doc)) {
    if (key === '$value') {
      if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value))
        out.push({ css: `--${path.join('-')}`, hex: value.toLowerCase() })
    } else if (!key.startsWith('$')) out.push(...hexTokens(value, [...path, key]))
  }
  return out
}

/** `rgb(...)` as `#rrggbb`; null for anything else or a translucent color. */
export function rgbToHex(css: string): string | null {
  const c = parseRgb(css)
  if (!c || c.a !== 1) return null
  return `#${[c.r, c.g, c.b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`
}

/** Colors of the declared pair as the page paints them (`#rrggbb`). */
export interface ResolvedPair {
  text: string
  surface: string
}

/** A violation that fails the test. */
export interface Finding {
  rule: string
  impact: string
  /** CSS selector path of the element (the last frame of axe's target). */
  target: string
  message: string
}

/** A known violation: narrow on purpose (one rule, one route, one element). */
export interface A11yAllowance {
  rule: string
  /** The sweep table keys of the routes (e2e/sweep/routes.ts). */
  routes: string[]
  /** A substring of the finding's message, e.g. the colors `#b2b2b2 on #ffffff`. */
  detail?: string
  /** A substring of the element's selector; absent = the rule on the whole route. */
  target?: string
  /** The skins it holds on; absent = both. */
  skins?: SkinName[]
  /** Why the violation stays, in a sentence. */
  reason: string
  /** The task that fixes it, `FE-123`. */
  task: string
}

/** Skin names of the matrix; `gold` is the velo-brand package. */
export type SkinName = 'gold' | 'goodo'

interface ContrastData {
  fgColor?: string
  bgColor?: string
  contrastRatio?: number
}

function contrastDataOf(node: Result['nodes'][number]): ContrastData | undefined {
  const check = [...node.any, ...node.all, ...node.none].find((c) => c.id === 'color-contrast')
  return check?.data as ContrastData | undefined
}

/** `#abc` or `#aabbcc` to lowercase `#aabbcc`; anything else unchanged. */
export function hex6(color: string): string {
  const c = color.trim().toLowerCase()
  const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(c)
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : c
}

/**
 * Is this color-contrast node the pair the package declared? Same colors as
 * the resolved pair and a ratio at or above the exception floor. A node
 * below the floor, or of any other pair, stays a violation.
 */
export function isDeclaredContrast(
  node: Result['nodes'][number],
  declared: ResolvedPair | null,
): boolean {
  if (!declared) return false
  const data = contrastDataOf(node)
  if (!data?.fgColor || !data.bgColor || typeof data.contrastRatio !== 'number') return false
  return (
    hex6(data.fgColor) === hex6(declared.text) &&
    hex6(data.bgColor) === hex6(declared.surface) &&
    data.contrastRatio >= EXCEPTION_FLOOR
  )
}

/** The contrast exception of the package that covers the allowed pair, or null. */
export function declaredException(list: readonly ContrastException[]): ContrastException | null {
  return list.find((e) => e.text === EXCEPTION_TEXT && e.surface === EXCEPTION_SURFACE) ?? null
}

function targetOf(node: Result['nodes'][number]): string {
  const last = node.target[node.target.length - 1]
  return Array.isArray(last) ? last.join(' ') : String(last)
}

/** Every node of every violation, minus the declared contrast pair. */
export function findingsOf(
  results: Pick<AxeResults, 'violations'>,
  declared: ResolvedPair | null,
): Finding[] {
  const out: Finding[] = []
  for (const v of results.violations) {
    for (const node of v.nodes) {
      if (v.id === 'color-contrast' && isDeclaredContrast(node, declared)) continue
      const data = v.id === 'color-contrast' ? contrastDataOf(node) : undefined
      const extra =
        data?.contrastRatio !== undefined
          ? ` (${data.fgColor} on ${data.bgColor}, ${data.contrastRatio}:1)`
          : ''
      out.push({
        rule: v.id,
        impact: v.impact ?? 'unknown',
        target: targetOf(node),
        message: `${v.help}${extra}`,
      })
    }
  }
  return out
}

/** Does this allowance cover the finding on this route and skin? */
export function covers(a: A11yAllowance, f: Finding, route: string, skin: SkinName): boolean {
  return (
    a.rule === f.rule &&
    a.routes.includes(route) &&
    (a.detail === undefined || f.message.includes(a.detail)) &&
    (a.skins ?? ['gold', 'goodo']).includes(skin) &&
    (a.target === undefined || f.target.includes(a.target))
  )
}

/** The findings no allowance covers, and the allowances that matched. */
export function judge(
  findings: readonly Finding[],
  allowlist: readonly A11yAllowance[],
  route: string,
  skin: SkinName,
): { open: Finding[]; used: Set<A11yAllowance> } {
  const used = new Set<A11yAllowance>()
  const open = findings.filter((f) => {
    const hit = allowlist.filter((a) => covers(a, f, route, skin))
    for (const a of hit) used.add(a)
    return hit.length === 0
  })
  return { open, used }
}

/** One message listing every open finding, for the failed test. */
export function formatFindings(findings: readonly Finding[]): string {
  return findings.map((f) => `  - ${f.rule} [${f.impact}] ${f.target}: ${f.message}`).join('\n')
}
