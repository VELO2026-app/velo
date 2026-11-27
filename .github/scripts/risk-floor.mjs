#!/usr/bin/env node
// =============================================================================
// VELO CI -- review risk floor (FE-279)
//
// Every PR declares a review level in its description:
//   **Ревью:** R1 | R2 | R3 -- why
// The policy -- what each level means and how deep the review goes -- is
// docs/review-risk.md. This script is its machine half: from the PR's own
// diff it computes the FLOOR, the lowest level the diff allows, and compares
// it with the declared level.
//
//   R3 -- the diff touches a sensitive zone (SENSITIVE below), adds a
//         `v-html`, names a secret, or weakens a gate list or budget.
//   R1 -- every changed file is in an R1 class (light()) and the .vue edits
//         together stay within VUE_R1_LINES changed lines.
//   R2 -- everything else.
//
// The effective level is the higher of declared and floor; a PR without a
// declaration counts as R2. The check fails when the declaration is lower
// than the floor -- the error names the files that raised it.
//
// Outputs (GITHUB_OUTPUT when set, always stdout):
//   floor, declared (R1|R2|R3|none), level (the effective one), ok (true|false)
//
// Node stdlib only; usage:
//   node .github/scripts/risk-floor.mjs <base> <head> [--body-file <path>]
// The functions are exported for the test (risk-floor.test.mjs).
// =============================================================================
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const LEVELS = ['R1', 'R2', 'R3']

// Changed lines in .vue files that an R1 PR may carry in total.
export const VUE_R1_LINES = 150

// Sensitive zones: a single changed file here makes the floor R3. Test files
// do not count (testFile below): a test of a zone does not change the zone.
// Keep in step with the zone table of docs/review-risk.md.
export const SENSITIVE = {
  auth: [
    /^frontend\/src\/platform\/(session|session-token|session-memo|browser-login|telegram|telegram-sdk|launch|standalone)\.ts$/,
    /^frontend\/src\/stores\/auth\.ts$/,
    /^frontend\/src\/composables\/(useAuth|useRoleFreshness)\.ts$/,
    /^frontend\/src\/router\/(guards|deepLinks)\.ts$/,
    /^frontend\/src\/views\/auth\/TelegramLoginView\.vue$/,
    /^frontend\/src\/api\/(client|idempotent|mcpTokens)\.ts$/,
  ],
  money: [
    /^frontend\/src\/api\/(payments|promos)\.ts$/,
    /^frontend\/src\/stores\/balance\.ts$/,
    /^frontend\/src\/utils\/(commission|currency)\.ts$/,
    /^frontend\/src\/components\/console\/finance\//,
    /^frontend\/src\/.*\/[^/]*(payout|withdraw|payment|balance|promo|finance|revenue|wallet)[^/]*\.(vue|ts)$/i,
  ],
  'user-data': [
    /^frontend\/src\/platform\/(error-reporter|sw-caches)\.ts$/,
    /^frontend\/src\/composables\/(persistedCache|useFormDraft)\.ts$/,
    /^frontend\/src\/pwa\/precache-shell\.ts$/,
  ],
  security: [/^frontend\/index\.html$/, /^frontend\/nginx/, /^frontend\/src\/utils\/textHighlight\.ts$/],
  'external-packages': [
    /^frontend\/src\/platform\/(skin|skin-virtual|texts)\.ts$/,
    /^frontend\/src\/locales\/overlayShape\.ts$/,
    /^frontend\/scripts\/(validate-skin|validate-texts)\.mjs$/,
    /^frontend\/scripts\/lib\/(skin-package|texts-package|brand-packages)\.mjs$/,
  ],
  gates: [
    /^frontend\/e2e\/.*allow(list|ance)[^/]*\.ts$/,
    /^frontend\/e2e\/sweep\/routes\.ts$/,
    /^frontend\/(vitest|playwright)\.config\.ts$/,
    /^frontend\/eslint\.config\.js$/,
    /^frontend\/eslint-rules\//,
  ],
  'ci-deploy': [
    /^\.github\/workflows\//,
    /^\.github\/scripts\//,
    /^frontend\/Dockerfile/,
    /^docker-compose/,
    /^primer\.(yaml|lock)$/,
    /^editions\.json$/,
    /^frontend\/vite\.config\.ts$/,
    /^pnpm-lock\.yaml$/,
    /^pnpm-workspace\.yaml$/,
  ],
  backend: [/^backend\//],
}

// Lists that weaken a gate in one direction only. An allowlist (what the
// e2e gates forgive) weakens by growing; the sweep's route list weakens by
// shrinking. A change in the other direction is R1.
const GROWS_WEAKER = /^frontend\/e2e\/.*allow(list|ance)[^/]*\.ts$/
const SHRINKS_WEAKER = /^frontend\/e2e\/sweep\/routes\.ts$/
const code = (lines) => lines.some((line) => line.trim() && !/^\s*(\/\/|\*|\/\*)/.test(line))

/** Whether a one-direction list moved only the safe way. */
export function safeDirection(f) {
  if (GROWS_WEAKER.test(f.path)) return !code(f.added)
  if (SHRINKS_WEAKER.test(f.path)) return !code(f.removed ?? [])
  return false
}

// The gates' own tests are part of the gate: a weakened test there is a
// weakened gate. Everywhere else a test file does not raise the floor.
const GATE_TEST = /^(\.github\/scripts|frontend\/eslint-rules)\//

export function testFile(path) {
  if (GATE_TEST.test(path)) return false
  return /\.test\.(ts|mjs)$/.test(path) || /^frontend\/e2e\/.*\.spec\.ts$/.test(path)
}

// Documents that agents execute as rules: never R1 (a wrong fact in them
// spreads to every agent that reads them).
const RULES_DOC =
  /^(docs\/(delivery|testing|figma-protocol|frontend-comments|review-risk)\.md|docs\/(agents|ci)\/|\.github\/pull_request_template\.md|tz-[^/]*\.md$)/

// R1 classes. A .vue file is R1 only within the shared line budget (floor()).
export function light(path) {
  if (RULES_DOC.test(path)) return false
  if (/^(docs|diagrams|Design_prototype)\//.test(path)) return true
  if (!path.includes('/') && path.endsWith('.md')) return true
  if (testFile(path)) return true
  if (/\.css$/.test(path)) return true
  if (/^frontend\/src\/locales\/.*\.json$/.test(path)) return true
  if (/^frontend\/(tokens\.json|public\/)/.test(path)) return true
  if (path === '.github/brand-skins.json') return true
  return false
}

// Content signals in ADDED lines of non-test files.
const CONTENT = [
  { zone: 'security', test: (path, line) => /\.vue$/.test(path) && /\bv-html\b/.test(line) },
  { zone: 'secrets', test: (_path, line) => /\b[A-Z][A-Z0-9_]*_TOKEN\b|\bsecrets\.[A-Za-z_]/.test(line) },
]

// A budget whose change makes the gate weaker: lint warnings allowed going
// up, coverage floors going down. Inputs are the parsed JSON of base and head.
export const BUDGETS = {
  'frontend/lint-budget.json': (base, head) => numbersBy(base, head, (b, h) => h > b),
  'frontend/coverage-budget.json': (base, head) => numbersBy(base, head, (b, h) => h < b),
}

function numbersBy(base, head, weaker, path = '') {
  if (typeof base === 'number' && typeof head === 'number') return weaker(base, head) ? [path || '(root)'] : []
  if (!base || !head || typeof base !== 'object' || typeof head !== 'object') return []
  return Object.keys(head).flatMap((k) => numbersBy(base[k], head[k], weaker, path ? `${path}.${k}` : k))
}

/**
 * The floor of a diff.
 * @param {{path: string, added: string[], removed?: string[], changed: number, base?: unknown, head?: unknown}[]} files
 *   one entry per changed file: its added and removed lines, their count,
 *   and for a budget file the parsed JSON of both sides
 * @returns {{floor: string, reasons: string[]}} the level and why
 */
export function floor(files) {
  const reasons = []
  for (const f of files) {
    if (!testFile(f.path)) {
      for (const [zone, pats] of Object.entries(SENSITIVE)) {
        if (!pats.some((p) => p.test(f.path))) continue
        if (safeDirection(f)) continue
        reasons.push(`${zone}: ${f.path}`)
      }
      for (const c of CONTENT) {
        if (f.added.some((line) => c.test(f.path, line))) reasons.push(`${c.zone}: ${f.path} (added line)`)
      }
    }
    const weakened = BUDGETS[f.path]?.(f.base, f.head) ?? []
    if (weakened.length) reasons.push(`gates: ${f.path} weakened (${weakened.join(', ')})`)
  }
  if (reasons.length) return { floor: 'R3', reasons }

  const heavy = files.filter((f) => !light(f.path) && !safeDirection(f) && !f.path.endsWith('.vue') && !BUDGETS[f.path])
  const vueLines = files.filter((f) => f.path.endsWith('.vue')).reduce((n, f) => n + f.changed, 0)
  if (heavy.length) return { floor: 'R2', reasons: heavy.slice(0, 5).map((f) => `not R1: ${f.path}`) }
  if (vueLines > VUE_R1_LINES) return { floor: 'R2', reasons: [`not R1: ${vueLines} changed .vue lines > ${VUE_R1_LINES}`] }
  return { floor: 'R1', reasons: [] }
}

/** The declared level from a PR description, or null. */
export function declared(body) {
  const m = /\*\*Ревью:\*\*\s*(R[123])\b/.exec(body ?? '')
  return m ? m[1] : null
}

/** declared vs floor -> the effective level and the verdict. */
export function decide(decl, fl) {
  const rank = (l) => LEVELS.indexOf(l)
  const level = LEVELS[Math.max(rank(fl), rank(decl ?? 'R2'))]
  return { level, ok: decl === null || rank(decl) >= rank(fl) }
}

// --- CLI ---------------------------------------------------------------------

function readDiff(base, head) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 << 20 })
  const show = (rev, path) => {
    try {
      return JSON.parse(git('show', `${rev}:${path}`))
    } catch {
      return undefined
    }
  }
  const files = new Map()
  for (const row of git('diff', '--numstat', '--no-renames', base, head).split('\n').filter(Boolean)) {
    const [a, d, path] = row.split('\t')
    files.set(path, { path, added: [], removed: [], changed: (Number(a) || 0) + (Number(d) || 0) })
  }
  let current = null
  for (const line of git('diff', '--no-renames', '-U0', base, head).split('\n')) {
    if (line.startsWith('--- ')) continue
    if (line.startsWith('+++ ')) current = files.get(line.slice(6)) ?? null
    else if (current && line.startsWith('+')) current.added.push(line.slice(1))
    else if (current && line.startsWith('-')) current.removed.push(line.slice(1))
  }
  for (const path of Object.keys(BUDGETS)) {
    const f = files.get(path)
    if (f) Object.assign(f, { base: show(base, path), head: show(head, path) })
  }
  return [...files.values()]
}

function main(argv) {
  const bodyAt = argv.indexOf('--body-file')
  const body = bodyAt >= 0 ? readFileSync(argv[bodyAt + 1], 'utf8') : ''
  const [base = 'HEAD^1', head = 'HEAD'] = bodyAt >= 0 ? argv.toSpliced(bodyAt, 2) : argv
  const { floor: fl, reasons } = floor(readDiff(base, head))
  const decl = declared(body)
  const { level, ok } = decide(decl, fl)
  const out = { floor: fl, declared: decl ?? 'none', level, ok: String(ok) }
  const text = Object.entries(out).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
  process.stdout.write(text)
  for (const r of reasons) console.log(`  ${r}`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text)
  if (decl === null) console.log('No "**Ревью:** R1|R2|R3" line in the PR description: counted as R2 (docs/review-risk.md).')
  if (!ok) {
    console.error(`Declared ${decl} is below the floor ${fl}. Raise the "**Ревью:**" line to ${fl} (docs/review-risk.md).`)
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2))
