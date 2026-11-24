/**
 * The accessibility gate's pure logic (FE-241): turn an axe result into the
 * findings that fail a test. No browser here -- the spec (./a11y.spec.ts)
 * runs axe and the page probe; this module decides what counts.
 *
 * Two kinds of exceptions, never one rule switched off wholesale:
 *   - the skin package's own `contrastExceptions` (contract 2.1): the pair the
 *     package declared and validate-skin already accepts down to 3:1 -- read
 *     from the package, not copied here;
 *   - ./allowlist.ts: known violations of one rule on named screens, each
 *     entry pinned to one element selector (any rule but contrast) or one
 *     color pair (contrast), with its reason and the task that fixes it.
 */
import type { AxeResults, Result } from 'axe-core'

/** The WCAG 2.1 A and AA rule tags. */
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const
/** Two more rules axe keeps outside that set: heading order (best-practice) and label in name, WCAG 2.5.3 (experimental). */
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

/** A color token of the package: its CSS name and the value as written. */
export interface ColorToken {
  css: string
  value: string
}

/**
 * The color tokens of a package's DTCG file (a plain hex or an rgb()/rgba()
 * value) under their CSS names (`velo.tg.header` -> `--velo-tg-header`). The
 * spec compares every one with what the page paints, so a stale or wrong build
 * cannot pass for the skin under test.
 */
export function colorTokens(doc: unknown, path: string[] = []): ColorToken[] {
  if (typeof doc !== 'object' || doc === null) return []
  const out: ColorToken[] = []
  for (const [key, value] of Object.entries(doc)) {
    if (key === '$value') {
      if (typeof value === 'string' && parseColor(value) !== null)
        out.push({ css: `--${path.join('-')}`, value })
    } else if (!key.startsWith('$')) out.push(...colorTokens(value, [...path, key]))
  }
  return out
}

/** A plain `#rrggbb` or an rgb()/rgba() value as numbers; null for anything else. */
function parseColor(css: string): { r: number; g: number; b: number; a: number } | null {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(css.trim())
  if (hex)
    return { r: parseInt(hex[1]!, 16), g: parseInt(hex[2]!, 16), b: parseInt(hex[3]!, 16), a: 1 }
  return parseRgb(css)
}

/** Do two color values paint the same (channels within half a step, alpha within 1%)? */
export function sameColor(expected: string, painted: string): boolean {
  const e = parseColor(expected)
  const p = parseColor(painted)
  if (!e || !p) return false
  return (
    Math.abs(e.r - p.r) <= 0.5 &&
    Math.abs(e.g - p.g) <= 0.5 &&
    Math.abs(e.b - p.b) <= 0.5 &&
    Math.abs(e.a - p.a) <= 0.01
  )
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

/**
 * A known violation, narrow on purpose. `allowanceProblems` is the rule: a
 * contrast entry names its color pair (`detail`), any other rule names the
 * element (`target`), so a new violation of the same rule on the same route
 * stays open.
 */
export interface A11yAllowance {
  rule: string
  /** The sweep table keys of the routes (e2e/sweep/routes.ts). */
  routes: string[]
  /** Contrast: a substring of the message, the colors `#b2b2b2 on #ffffff`. */
  detail?: string
  /** Other rules: the element's selector, as `normalizeTarget` writes it. */
  target?: string
  /** The skins it holds on; absent = both. */
  skins?: SkinName[]
  /** Why the violation stays, in a sentence. */
  reason: string
  /** The task that fixes it, `FE-123`. */
  task: string
}

/** What is wrong with an allowance as written (empty = fine). */
export function allowanceProblems(a: A11yAllowance): string[] {
  const problems: string[] = []
  if (a.reason.trim().length < 10) problems.push('no reason')
  if (!/^(?:FE|BE)-\d+$/.test(a.task)) problems.push('no task key')
  if (a.routes.length === 0) problems.push('no routes')
  if (a.rule === 'color-contrast') {
    if (!a.detail || !/^#\w+ on #\w+$/.test(a.detail)) problems.push('contrast needs `detail`')
  } else if (!a.target) problems.push(`${a.rule} needs \`target\``)
  return problems
}

/**
 * A selector without what changes between runs and builds: the scoped-style
 * attribute (`[data-v-1a2b3c4d=""]`, a hash of the file) and `:nth-child(n)`
 * (a list that grows with the data).
 */
export function normalizeTarget(selector: string): string {
  return selector
    .replace(/\[data-v-[0-9a-f]+(?:=""|="[^"]*")?\]/g, '')
    .replace(/:nth-child\(\d+\)/g, '')
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

/**
 * Every node of every violation, split into the findings and the nodes of the
 * declared contrast pair (the package's `contrastExceptions`), which are not
 * findings.
 */
export function findingsOf(
  results: Pick<AxeResults, 'violations'>,
  declared: ResolvedPair | null,
): { findings: Finding[]; waived: Finding[] } {
  const findings: Finding[] = []
  const waived: Finding[] = []
  for (const v of results.violations) {
    for (const node of v.nodes) {
      const data = v.id === 'color-contrast' ? contrastDataOf(node) : undefined
      const extra =
        data?.contrastRatio !== undefined
          ? ` (${data.fgColor} on ${data.bgColor}, ${data.contrastRatio}:1)`
          : ''
      const finding: Finding = {
        rule: v.id,
        impact: v.impact ?? 'unknown',
        target: targetOf(node),
        message: `${v.help}${extra}`,
      }
      if (v.id === 'color-contrast' && isDeclaredContrast(node, declared)) waived.push(finding)
      else findings.push(finding)
    }
  }
  return { findings, waived }
}

/** Does this allowance cover the finding on this route and skin? */
export function covers(a: A11yAllowance, f: Finding, route: string, skin: SkinName): boolean {
  return (
    a.rule === f.rule &&
    a.routes.includes(route) &&
    (a.skins ?? ['gold', 'goodo']).includes(skin) &&
    (a.detail === undefined || f.message.includes(a.detail)) &&
    (a.target === undefined || normalizeTarget(f.target) === a.target)
  )
}

/** The findings no allowance covers, and for each allowance the findings it covered. */
export function judge(
  findings: readonly Finding[],
  allowlist: readonly A11yAllowance[],
  route: string,
  skin: SkinName,
): { open: Finding[]; covered: Map<number, number> } {
  const covered = new Map<number, number>()
  const open = findings.filter((f) => {
    let hit = false
    allowlist.forEach((a, i) => {
      if (!covers(a, f, route, skin)) return
      hit = true
      covered.set(i, (covered.get(i) ?? 0) + 1)
    })
    return !hit
  })
  return { open, covered }
}

/** Name of the attachment a test puts its `RouteReport` in; ./report.ts reads it. */
export const REPORT_ATTACHMENT = 'a11y.json'

/** What one test tells the reporter (attached as `a11y.json`). */
export interface RouteReport {
  route: string
  role: string
  skin: SkinName
  /** Findings no allowance covers: the test fails on them. */
  open: Finding[]
  /** Allowance index -> number of findings it covered here. */
  covered: Array<[number, number]>
  /** Nodes of the package's declared contrast pair. */
  waived: number
}

/**
 * Allowances of this skin that covered nothing in the whole run: the violation
 * is gone (or never was), the entry hides nothing and must go.
 */
export function unusedAllowances(
  allowlist: readonly A11yAllowance[],
  reports: readonly RouteReport[],
  skin: SkinName,
): number[] {
  const used = new Set(reports.flatMap((r) => r.covered.map(([i]) => i)))
  return allowlist.flatMap((a, i) =>
    (a.skins ?? ['gold', 'goodo']).includes(skin) && !used.has(i) ? [i] : [],
  )
}

/** One message listing every open finding, for the failed test. */
export function formatFindings(findings: readonly Finding[]): string {
  return findings.map((f) => `  - ${f.rule} [${f.impact}] ${f.target}: ${f.message}`).join('\n')
}
