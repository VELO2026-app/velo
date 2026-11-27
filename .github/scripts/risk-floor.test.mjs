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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

import { decide, declared, floor, VUE_R1_LINES } from './risk-floor.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'risk-floor.mjs')
const file = (path, added = ['x'], extra = {}) => ({ path, added, changed: added.length, ...extra })
const lvl = (...files) => floor(files).floor

test('docs, styles, locales, tests and a brand pin are R1', () => {
  assert.equal(
    lvl(
      file('docs/figma/guide.md'),
      file('frontend/src/styles/base.css'),
      file('frontend/src/locales/ru.json'),
      file('frontend/src/views/user/HomeView.test.ts'),
      file('frontend/e2e/booking.spec.ts'),
      file('.github/brand-skins.json'),
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
  assert.equal(lvl(file('frontend/e2e/sweep/routes.ts', ["  { path: '/console/new' },"])), 'R1')
  assert.equal(lvl(file('frontend/e2e/sweep/routes.ts', [], { removed: ["  { path: '/console/old' },"] })), 'R3')
})

test('the rest of the e2e harness is R2', () => {
  assert.equal(lvl(file('frontend/e2e/support/fixtures.ts')), 'R2')
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
  assert.equal(lvl(file('frontend/src/components/shared/Row.test.ts', ['<p v-html="x" />'])), 'R1')
})

test('a budget is R3 only when it weakens the gate', () => {
  const lint = (b, h) => file('frontend/lint-budget.json', ['x'], { base: { maxWarnings: b }, head: { maxWarnings: h } })
  const cov = (b, h) => file('frontend/coverage-budget.json', ['x'], { base: { floors: { lines: b } }, head: { floors: { lines: h } } })
  assert.equal(lvl(lint(700, 690)), 'R1')
  assert.equal(lvl(lint(700, 701)), 'R3')
  assert.equal(lvl(cov(90.5, 90.6)), 'R1')
  assert.equal(lvl(cov(90.5, 90.4)), 'R3')
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
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  for (const [path, text] of Object.entries(files)) write(path, text)
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

test('CLI: a raised lint budget is R3', () => {
  const r = run({ 'frontend/lint-budget.json': '{"maxWarnings": 701}\n' }, '**Ревью:** R3 — gate')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /gates: frontend\/lint-budget\.json weakened \(maxWarnings\)/)
})
