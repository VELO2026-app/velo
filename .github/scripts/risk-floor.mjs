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
//         `v-html` or `innerHTML`, names a secret outside the app sources,
//         weakens a gate list or budget, or the PR calls its door one-way.
//   R1 -- every changed file is in an R1 class (light()) and the .vue edits
//         together stay within VUE_R1_LINES changed lines.
//   R2 -- everything else.
//
// The effective level is the higher of declared and floor; a PR without a
// declaration counts as R2. The check fails when the declaration is lower
// than the floor -- the error names the files that raised it.
//
// The review-risk workflow runs the copy of this script from the BASE
// branch, so a PR that edits the rules is judged by the rules it would
// replace (and this file sits in the ci-deploy zone: editing it is R3).
//
// Outputs (GITHUB_OUTPUT when set, always stdout):
//   floor, declared (R1|R2|R3|none), level (the effective one), ok (true|false)
//
// Node stdlib only; usage:
//   node .github/scripts/risk-floor.mjs <base> <head> [--body-file <path>]
// floor(), declared(), decide() and VUE_R1_LINES are exported for the test.
// =============================================================================
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const LEVELS = ['R1', 'R2', 'R3']

// Changed lines in .vue files that an R1 PR may carry in total.
export const VUE_R1_LINES = 150

// An allowlist (what the e2e gates forgive) weakens its gate by growing: a
// change that only removes entries is not R3 (safeDirection below); a deleted
// list always is. The sweep's route list has no safe direction: besides the
// rows it carries crash allowances (`allow:`) and the fillPath logic that can
// drop a route, so any edit to it is R3.
const GROWS_WEAKER = /^frontend\/e2e\/.*allowlist[^/]*\.ts$/

// Sensitive zones: a single changed file here makes the floor R3. Test files
// do not count (testFile below): a test of a zone does not change the zone.
// Keep in step with the zone table of docs/review-risk.md.
const SENSITIVE = {
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
    /^frontend\/src\/composables\/queries\/persist\.ts$/,
    /^frontend\/src\/pwa\/precache-shell\.ts$/,
  ],
  security: [/^frontend\/index\.html$/, /^frontend\/nginx/, /^frontend\/src\/utils\/textHighlight\.ts$/],
  'external-packages': [
    /^\.github\/brand-skins\.json$/,
    /^frontend\/src\/platform\/(skin|skin-virtual|texts)\.ts$/,
    /^frontend\/src\/locales\/overlayShape\.ts$/,
    /^frontend\/scripts\/(validate-skin|validate-texts)\.mjs$/,
    /^frontend\/scripts\/lib\/(skin-package|texts-package|brand-packages|brand-git)\.mjs$/,
  ],
  gates: [
    GROWS_WEAKER,
    /^frontend\/e2e\/sweep\/routes\.ts$/,
    /^frontend\/e2e\/.*allowance[^/]*\.ts$/,
    /^frontend\/(vitest|playwright)\.config\.ts$/,
    /^frontend\/eslint\.config\.js$/,
    /^frontend\/eslint-rules\//,
    /^frontend\/\.husky\//,
    /^frontend\/scripts\/(lint-budget|coverage-budget|bundle-budget-guard|bundle-report|brand-grep|token-audit|build-log-gate|verify-quick|spec-coverage|doc-coverage|no-cyrillic|css-lint|key-audit|api-type-dupes)\.mjs$/,
    /^frontend\/scripts\/lib\/(token-audit|build-log-gate|bundle-budget|duration-shard)\.mjs$/,
    /^frontend\/scripts\/spec-coverage\.baseline\.json$/,
    /^frontend\/scripts\/lib\/.*\.test\.mjs$/,
  ],
  'ci-deploy': [
    /^\.github\/workflows\//,
    /^\.github\/scripts\//,
    /^frontend\/Dockerfile/,
    /^docker-compose/,
    /^primer\.(yaml|lock)$/,
    /^editions\.json$/,
    /^(frontend|packages\/velo-ui)\/vite\.config\.ts$/,
    /^pnpm-lock\.yaml$/,
    /^pnpm-workspace\.yaml$/,
  ],
  backend: [/^backend\//],
}

// The gates' own tests are part of the gate: a weakened test there is a
// weakened gate. Everywhere else a test file does not raise the floor.
const GATE_TEST = /^(\.github\/scripts|frontend\/eslint-rules|frontend\/scripts)\//

function testFile(path) {
  if (GATE_TEST.test(path)) return false
  return /\.test\.(ts|mjs)$/.test(path) || /^frontend\/e2e\/.*\.spec\.ts$/.test(path)
}

const hasCode = (lines) => lines.some((line) => line.trim() && !/^\s*(\/\/|\*|\/\*)/.test(line))

/** Whether an allowlist only lost entries. */
function safeDirection(f) {
  return !f.deleted && GROWS_WEAKER.test(f.path) && !hasCode(f.added)
}

// Documents that agents execute as rules: never R1 (a wrong fact in them
// spreads to every agent that reads them).
const RULES_DOC =
  /^(docs\/(delivery|testing|figma-protocol|frontend-comments|review-risk)\.md|docs\/(agents|ci)\/|\.github\/pull_request_template\.md|tz-[^/]*\.md$)/

// R1 classes. A .vue file is R1 only within the shared line budget (floor()).
function light(path) {
  if (RULES_DOC.test(path)) return false
  if (/^(docs|diagrams|Design_prototype)\/.*\.(md|png|jpe?g|svg|webp)$/.test(path)) return true
  if (!path.includes('/') && path.endsWith('.md')) return true
  if (testFile(path)) return true
  if (/\.css$/.test(path)) return true
  if (/^frontend\/src\/locales\/.*\.json$/.test(path)) return true
  if (/^frontend\/tokens\.json$/.test(path)) return true
  if (/^frontend\/public\/.*\.(png|jpe?g|svg|webp|ico|woff2?)$/.test(path)) return true
  return false
}

// Content signals in ADDED lines of non-test files. Secrets are looked for
// outside the app sources only: the bundle is public, and app constants like
// DRAFT_STORAGE_KEY are not secrets.
const APP_SRC = /^(frontend|packages\/[^/]+)\/src\//
const CONTENT = [
  { zone: 'security', test: (path, line) => /\.(vue|ts)$/.test(path) && /\bv-html\b|\binnerHTML\b/.test(line) },
  {
    zone: 'secrets',
    test: (path, line) => !APP_SRC.test(path) && /\b[A-Z][A-Z0-9_]*_(TOKEN|PAT|KEY|SECRET)\b|\bsecrets\.[A-Za-z_]/.test(line),
  },
]

// A budget whose change makes the gate weaker: allowed warnings or bytes going
// up, coverage floors going down, a number removed, the file deleted or no
// longer valid JSON. Inputs: the parsed JSON of base and head (undefined when
// that side is missing or does not parse).
const BUDGETS = {
  'frontend/lint-budget.json': (b, h) => h > b,
  'frontend/bundle-budget.json': (b, h) => h > b,
  'frontend/coverage-budget.json': (b, h) => h < b,
}

function weakenedBudget(f) {
  const weaker = BUDGETS[f.path]
  if (!weaker || f.base === undefined) return []
  if (f.head === undefined) return ['file deleted or not valid JSON']
  return numbersBy(f.base, f.head, weaker)
}

function numbersBy(base, head, weaker, path = '') {
  const at = path || '(root)'
  if (typeof base === 'number') return typeof head !== 'number' ? [`${at} removed`] : weaker(base, head) ? [at] : []
  if (!base || typeof base !== 'object') return []
  if (!head || typeof head !== 'object') return [`${at} removed`]
  return Object.keys(base).flatMap((k) => numbersBy(base[k], head[k], weaker, path ? `${path}.${k}` : k))
}

/**
 * The floor of a diff.
 * @param {{path: string, added: string[], removed?: string[], deleted?: boolean, changed: number, base?: unknown, head?: unknown}[]} files
 *   one entry per changed file: its added and removed lines, whether the
 *   file is deleted, the count of changed lines, and for a budget file the
 *   parsed JSON of both sides
 * @param {string} [body] the PR description (a one-way door is R3)
 * @returns {{floor: string, reasons: string[]}} the level and why
 */
export function floor(files, body = '') {
  files = files.map((f) => ({ removed: [], deleted: false, ...f }))
  const reasons = []
  if (/^\*\*Дверь:\*\*\s*односторонн/im.test(body)) reasons.push('one-way door in the PR description')
  for (const f of files) {
    if (!testFile(f.path)) {
      for (const [zone, pats] of Object.entries(SENSITIVE)) {
        if (pats.some((p) => p.test(f.path)) && !safeDirection(f)) reasons.push(`${zone}: ${f.path}${f.deleted ? ' (deleted)' : ''}`)
      }
      for (const c of CONTENT) {
        if (f.added.some((line) => c.test(f.path, line))) reasons.push(`${c.zone}: ${f.path} (added line)`)
      }
    }
    const weakened = weakenedBudget(f)
    if (weakened.length) reasons.push(`gates: ${f.path} weakened (${weakened.join(', ')})`)
  }
  if (reasons.length) return { floor: 'R3', reasons: [...new Set(reasons)] }

  const heavy = files.filter((f) => !light(f.path) && !safeDirection(f) && !f.path.endsWith('.vue') && !BUDGETS[f.path])
  const vueLines = files.filter((f) => f.path.endsWith('.vue')).reduce((n, f) => n + f.changed, 0)
  if (heavy.length) return { floor: 'R2', reasons: heavy.slice(0, 5).map((f) => `not R1: ${f.path}`) }
  if (vueLines > VUE_R1_LINES) return { floor: 'R2', reasons: [`not R1: ${vueLines} changed .vue lines > ${VUE_R1_LINES}`] }
  return { floor: 'R1', reasons: [] }
}

/**
 * The declared level from a PR description, or null. Only a line that starts
 * with the marker counts, the last one wins: the description may quote the
 * marker in prose or code above the "Риск мержа" section.
 */
export function declared(body) {
  const all = [...(body ?? '').matchAll(/^\*\*Ревью:\*\*\s*(R[123])\b/gm)]
  return all.length ? all.at(-1)[1] : null
}

/** declared vs floor -> the effective level and the verdict. */
export function decide(declaredLevel, floorLevel) {
  const rank = (l) => LEVELS.indexOf(l)
  const level = LEVELS[Math.max(rank(floorLevel), rank(declaredLevel ?? 'R2'))]
  return { level, ok: declaredLevel === null || rank(declaredLevel) >= rank(floorLevel) }
}

// --- CLI ---------------------------------------------------------------------

// Paths come unquoted (core.quotePath=false) so non-ASCII names match the
// zones. Lines are attributed by the `diff --git` header of each file and
// counted only inside its `@@` hunks, so a content line that looks like a
// header (`++ x`, `-- y`) is still content.
function readDiff(base, head) {
  const git = (...args) =>
    execFileSync('git', ['-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 64 << 20 })
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
    files.set(path, { path, added: [], removed: [], deleted: false, changed: (Number(a) || 0) + (Number(d) || 0) })
  }
  for (const row of git('diff', '--name-status', '--no-renames', base, head).split('\n').filter(Boolean)) {
    const [status, path] = row.split('\t')
    if (status === 'D' && files.has(path)) files.get(path).deleted = true
  }
  let current = null
  let inHunk = false
  for (const line of git('diff', '--no-renames', '--no-ext-diff', '-U0', base, head).split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = [...files.values()].find((f) => line === `diff --git a/${f.path} b/${f.path}`) ?? null
      inHunk = false
    } else if (line.startsWith('@@')) inHunk = true
    else if (current && inHunk && line.startsWith('+')) current.added.push(line.slice(1))
    else if (current && inHunk && line.startsWith('-')) current.removed.push(line.slice(1))
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
  const { floor: floorLevel, reasons } = floor(readDiff(base, head), body)
  const declaredLevel = declared(body)
  const { level, ok } = decide(declaredLevel, floorLevel)
  const out = { floor: floorLevel, declared: declaredLevel ?? 'none', level, ok: String(ok) }
  const text = Object.entries(out).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
  process.stdout.write(text)
  for (const r of reasons) console.log(`  ${r}`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text)
  if (declaredLevel === null) console.log('No "**Ревью:** R1|R2|R3" line in the PR description: counted as R2 (docs/review-risk.md).')
  if (!ok) {
    console.error(`Declared ${declaredLevel} is below the floor ${floorLevel}. Raise the "**Ревью:**" line to ${floorLevel} (docs/review-risk.md).`)
    process.exitCode = 1
  }
}

const invoked = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : ''
if (import.meta.url === invoked) main(process.argv.slice(2))
