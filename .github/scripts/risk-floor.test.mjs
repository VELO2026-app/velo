#!/usr/bin/env node
// =============================================================================
// VELO CI -- the test of risk-floor.mjs (FE-279)
//
// The pure functions on hand-made diffs (one case per rule of
// docs/review-risk.md), then the CLI once in a throwaway git repository, as
// the review-risk workflow runs it.
// Locally: node --test .github/scripts/risk-floor.test.mjs
// Node stdlib and git only.
// =============================================================================
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

import { decide, declared, floor, VUE_R1_LINES } from './risk-floor.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'risk-floor.mjs')
const file = (path, added = ['x'], extra = {}) => ({ path, added, changed: added.length, ...extra })
const lvl = (...files) => floor(files).floor

test('docs, styles, locales and tests are R1', () => {
  assert.equal(
    lvl(
      file('docs/figma/guide.md'),
      file('frontend/src/styles/base.css'),
      file('frontend/src/locales/ru.json'),
      file('frontend/src/views/user/HomeView.test.ts'),
      file('frontend/e2e/booking.spec.ts'),
    ),
    'R1',
  )
})

test('a small .vue edit is R1, a large one R2', () => {
  assert.equal(lvl(file('frontend/src/views/user/HomeView.vue', Array(VUE_R1_LINES).fill('<p/>'))), 'R1')
  assert.equal(lvl(file('frontend/src/views/user/HomeView.vue', Array(VUE_R1_LINES + 1).fill('<p/>'))), 'R2')
})

test('logic in .ts and documents agents execute as rules are R2', () => {
  assert.equal(lvl(file('frontend/src/composables/useNow.ts')), 'R2')
  assert.equal(lvl(file('docs/delivery.md')), 'R2')
  assert.equal(lvl(file('docs/agents/e2e.md')), 'R2')
  assert.equal(lvl(file('.github/pull_request_template.md')), 'R2')
  assert.equal(lvl(file('tz-curator.md')), 'R2')
  assert.equal(lvl(file('docs/README.md')), 'R1')
})

test('every sensitive zone is R3', () => {
  for (const path of [
    'frontend/src/platform/browser-login.ts',
    'frontend/src/router/guards.ts',
    'frontend/src/api/client.ts',
    'frontend/src/components/console/finance/PromosPanel.vue',
    'frontend/src/views/master/MasterFinanceView.vue',
    'frontend/src/platform/error-reporter.ts',
    'frontend/src/pwa/precache-shell.ts',
    'frontend/index.html',
    'frontend/nginx.conf',
    'frontend/src/locales/overlayShape.ts',
    '.github/brand-skins.json',
    'frontend/src/composables/queries/persist.ts',
    'frontend/.husky/pre-push',
    'frontend/scripts/lint-budget.mjs',
    'frontend/scripts/lib/token-audit.test.mjs',
    'frontend/scripts/lib/token-audit.mjs',
    'frontend/scripts/lib/build-log-gate.mjs',
    'frontend/scripts/lib/bundle-budget.mjs',
    'frontend/e2e/support/layout-allowance.ts',
    'packages/velo-ui/vite.config.ts',
    'frontend/scripts/lib/texts-package.mjs',
    'frontend/e2e/support/allowlist.ts',
    'frontend/e2e/a11y/allowlist.ts',
    'frontend/playwright.config.ts',
    'frontend/vitest.config.ts',
    'frontend/eslint-rules/index.mjs',
    '.github/workflows/ci.yml',
    '.github/scripts/ci-scope.mjs',
    'frontend/vite.config.ts',
    'pnpm-lock.yaml',
    'primer.yaml',
    'backend/app/main.py',
  ]) {
    assert.equal(lvl(file(path)), 'R3', path)
  }
})

test('an allowlist weakens a gate by growing, the sweep route list by shrinking', () => {
  const entry = ['  { route: "/x", rule: "overflow" },']
  assert.equal(lvl(file('frontend/e2e/support/layout-allowlist.ts', entry)), 'R3')
  assert.equal(lvl(file('frontend/e2e/support/layout-allowlist.ts', [], { removed: entry })), 'R1')
  assert.equal(lvl(file('frontend/e2e/a11y/allowlist.ts', ['  // why the entry went away'], { removed: entry })), 'R1')
  assert.equal(lvl(file('frontend/e2e/sweep/routes.ts', ["  { path: '/console/new' },"])), 'R3')
  assert.equal(lvl(file('frontend/e2e/sweep/routes.ts', [], { removed: ["  { path: '/console/old' },"] })), 'R3')
})

test('the rest of the e2e harness is R2', () => {
  assert.equal(lvl(file('frontend/e2e/support/fixtures.ts')), 'R2')
})

test('any edit to the sweep route list is R3: rows carry crash allowances', () => {
  const allow = ["  { path: '/home', allow: () => [{ reason: 'flaky', console: [/./], errors: [/./] }] },"]
  assert.equal(lvl(file('frontend/e2e/sweep/routes.ts', allow, { removed: ["  { path: '/home' },"] })), 'R3')
  assert.equal(lvl(file('frontend/e2e/sweep/routes.ts', ['  if (row.path.startsWith("/home")) missing = true'])), 'R3')
})

test('a deleted gate list or a new filter over the routes is R3', () => {
  assert.equal(lvl(file('frontend/e2e/support/layout-allowlist.ts', [], { deleted: true })), 'R3')
  assert.equal(lvl(file('frontend/e2e/sweep/routes.ts', ['  .filter((r) => r.role !== "admin")'])), 'R3')
})

test('allowance logic is R3 even when it only loses lines', () => {
  assert.equal(lvl(file('frontend/e2e/support/allowance.ts', [], { removed: ['  if (x) return false'] })), 'R3')
})

test('a one-way door in the description is R3', () => {
  assert.equal(floor([file('docs/a.md')], '**Дверь:** односторонняя — удаление данных').floor, 'R3')
  assert.equal(floor([file('docs/a.md')], '**Дверь:** двусторонняя').floor, 'R1')
})

test('docs scripts and public scripts are not R1', () => {
  assert.equal(lvl(file('docs/figma/velo-figma-designer/designer-lib.figma.js')), 'R2')
  assert.equal(lvl(file('frontend/public/sw.js')), 'R2')
})

test('a test of a zone does not raise the floor, a test of a gate does', () => {
  assert.equal(lvl(file('frontend/src/router/guards.test.ts')), 'R1')
  assert.equal(lvl(file('frontend/src/views/master/MasterFinanceView.test.ts')), 'R1')
  assert.equal(lvl(file('.github/scripts/ci-scope.test.mjs')), 'R3')
  assert.equal(lvl(file('frontend/eslint-rules/test-rules.test.mjs')), 'R3')
})

test('an added v-html or a secret name is R3 wherever it lands', () => {
  assert.equal(lvl(file('frontend/src/components/shared/Row.vue', ['<p v-html="x" />'])), 'R3')
  assert.equal(lvl(file('frontend/scripts/sync.mjs', ['const t = process.env.BRAND_REPO_TOKEN'])), 'R3')
  assert.equal(lvl(file('frontend/scripts/sync.mjs', ['const t = env(secrets.X)'])), 'R3')
  assert.equal(lvl(file('frontend/scripts/sync.mjs', ['const k = process.env.FIGMA_PAT'])), 'R3')
  assert.equal(lvl(file('frontend/src/composables/useDraft.ts', ['const DRAFT_STORAGE_KEY = "d"'])), 'R2')
  assert.equal(lvl(file('frontend/src/utils/html.ts', ['el.innerHTML = s'])), 'R3')
  assert.equal(lvl(file('frontend/src/components/shared/Row.test.ts', ['<p v-html="x" />'])), 'R1')
})

test('a budget is R3 only when it weakens the gate', () => {
  const lint = (b, h) => file('frontend/lint-budget.json', ['x'], { base: { maxWarnings: b }, head: { maxWarnings: h } })
  const cov = (b, h) => file('frontend/coverage-budget.json', ['x'], { base: { floors: { lines: b } }, head: { floors: { lines: h } } })
  assert.equal(lvl(lint(700, 690)), 'R1')
  assert.equal(lvl(lint(700, 701)), 'R3')
  assert.equal(lvl(cov(90.5, 90.6)), 'R1')
  assert.equal(lvl(cov(90.5, 90.4)), 'R3')
  const covGone = file('frontend/coverage-budget.json', ['x'], { base: { floors: { lines: 90, branches: 84 } }, head: { floors: { lines: 90 } } })
  assert.equal(lvl(covGone), 'R3')
  assert.equal(lvl(file('frontend/lint-budget.json', [], { base: { maxWarnings: 700 }, head: undefined, deleted: true })), 'R3')
  const bundle = (b, h) => file('frontend/bundle-budget.json', ['x'], { base: { entryGzip: b }, head: { entryGzip: h } })
  assert.equal(lvl(bundle(100, 101)), 'R3')
})

test('the reasons name the files that raised the floor', () => {
  const { reasons } = floor([file('frontend/src/router/guards.ts'), file('docs/a.md')])
  assert.deepEqual(reasons, ['auth: frontend/src/router/guards.ts'])
})

test('the declared level is read from the PR line', () => {
  assert.equal(declared('## Риск мержа\n**Ревью:** R1 — docs only'), 'R1')
  assert.equal(declared('**Ревью:**   R3 (auth)'), 'R3')
  assert.equal(declared('**Ревью:** <!-- R1 / R2 / R3 --> — почему'), null)
  assert.equal(declared('no line'), null)
  assert.equal(declared(undefined), null)
  assert.equal(declared('template.md + строка «**Ревью:** R1/R2/R3»\n\n**Ревью:** R3 — CI'), 'R3')
  assert.equal(declared('  **Ревью:** R1 — indented, quoted'), null)
})

test('effective level is the higher one; below the floor fails; none counts as R2', () => {
  assert.deepEqual(decide('R1', 'R1'), { level: 'R1', ok: true })
  assert.deepEqual(decide('R3', 'R1'), { level: 'R3', ok: true })
  assert.deepEqual(decide('R2', 'R3'), { level: 'R3', ok: false })
  assert.deepEqual(decide(null, 'R1'), { level: 'R2', ok: true })
  assert.deepEqual(decide(null, 'R3'), { level: 'R3', ok: true })
})

// --- the CLI in a real repository --------------------------------------------

const ROOTS = []
after(() => ROOTS.forEach((r) => rmSync(r, { recursive: true, force: true })))

// git's repository-local variables (GIT_DIR ...) are dropped: under a git hook
// they would aim the fixture at the caller's repository.
const LOCAL_VARS = new Set(
  execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).split('\n').filter(Boolean),
)
const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !LOCAL_VARS.has(k) && k !== 'GITHUB_OUTPUT')),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'risk-floor test',
  GIT_AUTHOR_EMAIL: 'risk-floor@test.invalid',
  GIT_COMMITTER_NAME: 'risk-floor test',
  GIT_COMMITTER_EMAIL: 'risk-floor@test.invalid',
}

function run(files, body) {
  const dir = mkdtempSync(join(tmpdir(), 'risk-floor-'))
  ROOTS.push(dir)
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' }).trim()
  const write = (path, text) => {
    mkdirSync(join(dir, dirname(path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  git('init', '-q', '-b', 'main')
  write('frontend/lint-budget.json', '{"maxWarnings": 700}\n')
  write('docs/a.md', 'a\n')
  write('frontend/e2e/sweep/routes.ts', "export const ROUTES = ['/a']\n")
  write('frontend/src/router/guards.ts', 'export const g = 1\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  for (const [path, text] of Object.entries(files)) {
    if (text === null) rmSync(join(dir, path))
    else write(path, text)
  }
  git('add', '-A')
  git('commit', '-q', '-m', 'head')
  write('body.md', body)
  const result = spawnSync('node', [SCRIPT, 'HEAD^1', 'HEAD', '--body-file', 'body.md'], { cwd: dir, env: GIT_ENV, encoding: 'utf8' })
  return { ...result, cwd: dir }
}

test('CLI: a declaration at the floor passes', () => {
  const r = run({ 'docs/a.md': 'b\n' }, '**Ревью:** R1 — docs')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /floor=R1\ndeclared=R1\nlevel=R1\nok=true/)
})

test('CLI: a declaration below the floor fails and names the file', () => {
  const r = run({ 'frontend/src/router/guards.ts': 'x\n', 'frontend/lint-budget.json': '{"maxWarnings": 690}\n' }, '**Ревью:** R2')
  assert.equal(r.status, 1)
  assert.match(r.stdout, /floor=R3/)
  assert.match(r.stdout, /auth: frontend\/src\/router\/guards\.ts/)
  assert.doesNotMatch(r.stdout, /lint-budget/)
  assert.match(r.stderr, /below the floor R3/)
})

test('CLI: without --body-file the two revisions are read as given', () => {
  const r = run({ 'docs/a.md': 'b\n' }, '')
  const again = spawnSync('node', [SCRIPT, 'HEAD^1', 'HEAD'], { cwd: r.cwd, env: GIT_ENV, encoding: 'utf8' })
  assert.match(again.stdout, /floor=R1\ndeclared=none\nlevel=R2\nok=true/)
})

test('CLI: deleting the sweep route list is R3', () => {
  const r = run({ 'frontend/e2e/sweep/routes.ts': null }, '**Ревью:** R1')
  assert.equal(r.status, 1)
  assert.match(r.stdout, /gates: frontend\/e2e\/sweep\/routes\.ts \(deleted\)/)
})

test('CLI: a renamed sensitive file is R3', () => {
  const r = run({ 'frontend/src/router/guards.ts': null, 'frontend/src/router/guardz.ts': 'export const g = 1\n' }, '**Ревью:** R3')
  assert.match(r.stdout, /auth: frontend\/src\/router\/guards\.ts/)
})

test('CLI: a content line that looks like a header does not hide the next line', () => {
  const r = run({ 'frontend/src/components/Row.vue': '++ x\n<p v-html="y" />\n' }, '**Ревью:** R3')
  assert.match(r.stdout, /security: frontend\/src\/components\/Row\.vue \(added line\)/)
})

test('CLI: a secret in a script and a non-ASCII money path are R3', () => {
  const r = run(
    { 'frontend/scripts/sync.mjs': 'const t = process.env.BRAND_REPO_TOKEN\n', 'frontend/src/views/выплаты/payoutForm.ts': 'x\n' },
    '**Ревью:** R3',
  )
  assert.match(r.stdout, /secrets: frontend\/scripts\/sync\.mjs/)
  assert.match(r.stdout, /money: frontend\/src\/views\/выплаты\/payoutForm\.ts/)
})

test('CLI: a deleted or broken lint budget is R3', () => {
  assert.match(run({ 'frontend/lint-budget.json': null }, '').stdout, /lint-budget\.json weakened \(file deleted or not valid JSON\)/)
  assert.match(run({ 'frontend/lint-budget.json': '{ 9999 \n' }, '').stdout, /lint-budget\.json weakened/)
})

test('CLI: the verdict goes to GITHUB_OUTPUT for the label step', () => {
  const r = run({ 'docs/a.md': 'b\n' }, '**Ревью:** R2')
  const out = join(r.cwd, 'out.txt')
  writeFileSync(out, '')
  spawnSync('node', [SCRIPT, 'HEAD^1', 'HEAD', '--body-file', 'body.md'], { cwd: r.cwd, env: { ...GIT_ENV, GITHUB_OUTPUT: out }, encoding: 'utf8' })
  assert.equal(readFileSync(out, 'utf8'), 'floor=R1\ndeclared=R2\nlevel=R2\nok=true\n')
})

test('CLI: removing one route row is R3', () => {
  const r = run({ 'frontend/e2e/sweep/routes.ts': "export const ROUTES = []\n" }, '**Ревью:** R1')
  assert.equal(r.status, 1)
  assert.match(r.stdout, /gates: frontend\/e2e\/sweep\/routes\.ts\n/)
})

test('CLI: content lines that look like ---/+++ headers stay content', () => {
  const r = run({ 'frontend/src/components/Row.vue': '--- a/x\n+++ b/y\n<p v-html="z" />\n' }, '**Ревью:** R3')
  assert.match(r.stdout, /security: frontend\/src\/components\/Row\.vue \(added line\)/)
})

test('CLI: a raised lint budget is R3', () => {
  const r = run({ 'frontend/lint-budget.json': '{"maxWarnings": 701}\n' }, '**Ревью:** R3 — gate')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /gates: frontend\/lint-budget\.json weakened \(maxWarnings\)/)
})
