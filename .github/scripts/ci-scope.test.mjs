#!/usr/bin/env node
// =============================================================================
// VELO CI -- the test of ci-scope.mjs (FE-187)
//
// Runs the classifier, as the scope job does, in throwaway git repositories
// built here, and reads the outputs it writes to $GITHUB_OUTPUT. Covers the
// push input -- the range a push brought, and every case where that range
// cannot be trusted and the push gets the full gate -- and keeps the pull
// request input as it was.
//
// Run by the scope job of ci.yml before it classifies (the classifier is the
// gate's size; since FE-187 a push no longer runs the full gate behind it).
// Locally: node --test .github/scripts/ci-scope.test.mjs
// Node stdlib and git only.
// =============================================================================
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'ci-scope.mjs')
const ROOTS = []
after(() => ROOTS.forEach((r) => rmSync(r, { recursive: true, force: true })))

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'ci-scope test',
  GIT_AUTHOR_EMAIL: 'ci-scope@test.invalid',
  GIT_COMMITTER_NAME: 'ci-scope test',
  GIT_COMMITTER_EMAIL: 'ci-scope@test.invalid',
}

// A repository with one base commit; returns helpers bound to it.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'ci-scope-'))
  ROOTS.push(dir)
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  const write = (file, text) => {
    mkdirSync(join(dir, dirname(file)), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  const commit = (files, message = 'change') => {
    for (const [file, text] of Object.entries(files)) write(file, text)
    git('add', '-A')
    git('commit', '-q', '-m', message)
    return git('rev-parse', 'HEAD')
  }
  commit({ 'backend/app/main.py': 'x = 1\n', 'frontend/src/a.ts': 'export const a = 1\n', 'docs/a.md': 'a\n' }, 'base')
  return { dir, git, commit }
}

// Runs the classifier in the repository; returns its outputs as an object
// (and what it printed, under the key `log`, for the cases that check why).
function run(dir, ...args) {
  const out = join(dir, '.ci-output')
  writeFileSync(out, '')
  const log = execFileSync('node', [SCRIPT, ...args], {
    cwd: dir,
    env: { ...GIT_ENV, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: '' },
    encoding: 'utf8',
  })
  const outputs = Object.fromEntries(
    readFileSync(out, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('=')),
  )
  return { outputs, log }
}
const classify = (dir, ...args) => run(dir, ...args).outputs

const FULL = { frontend: 'full', drift: 'true', docker: 'true', visual: 'true' }

test('push: the whole range a batch brought is classified, not only its last commit', () => {
  const { dir, git, commit } = repo()
  const before = git('rev-parse', 'HEAD')
  commit({ 'frontend/src/a.ts': 'export const a = 2\n' }, 'frontend first')
  const sha = commit({ 'backend/app/main.py': 'x = 2\n' }, 'backend last')
  const got = classify(dir, '--push', before, sha)
  assert.equal(got.frontend, 'full')
  assert.equal(got.drift, 'true')
})

test('push: backend only -> no frontend jobs, the drift check runs', () => {
  const { dir, git, commit } = repo()
  const before = git('rev-parse', 'HEAD')
  const sha = commit({ 'backend/app/main.py': 'x = 3\n' })
  assert.deepEqual(classify(dir, '--push', before, sha), {
    frontend: 'skip',
    drift: 'true',
    docker: 'false',
    visual: 'false',
  })
})

test('push: docs only -> nothing runs', () => {
  const { dir, git, commit } = repo()
  const before = git('rev-parse', 'HEAD')
  const sha = commit({ 'docs/a.md': 'b\n' })
  assert.deepEqual(classify(dir, '--push', before, sha), {
    frontend: 'skip',
    drift: 'false',
    docker: 'false',
    visual: 'false',
  })
})

test('push: the gate itself -> everything', () => {
  const { dir, git, commit } = repo()
  const before = git('rev-parse', 'HEAD')
  const sha = commit({ '.github/workflows/ci.yml': 'name: CI\n' })
  const got = classify(dir, '--push', before, sha)
  assert.equal(got.frontend, 'full')
  assert.equal(got.drift, 'true')
  assert.equal(got.docker, 'true')
})

// The three untrusted ranges all end in the full gate; each says which rule
// sent it there -- the line an operator reads in the step summary.
test('push: before all zeros (a new branch) -> the full gate', () => {
  const { dir, git } = repo()
  const { outputs, log } = run(dir, '--push', '0'.repeat(40), git('rev-parse', 'HEAD'))
  assert.deepEqual(outputs, FULL)
  assert.match(log, /no before \(a new branch\)/)
})

test('push: before not in the history -> the full gate', () => {
  const { dir, commit } = repo()
  const sha = commit({ 'docs/a.md': 'c\n' })
  const { outputs, log } = run(dir, '--push', 'deadbeef'.repeat(5), sha)
  assert.deepEqual(outputs, FULL)
  assert.match(log, /is not in the fetched history/)
})

test('push: a forced push (before not an ancestor of sha) -> the full gate', () => {
  // A docs-only rewrite: classified as a range it would skip everything, so
  // FULL here can only come from the forced-push rule.
  const { dir, git, commit } = repo()
  const base = git('rev-parse', 'HEAD')
  const before = commit({ 'docs/a.md': 'old head\n' }, 'the old head')
  git('reset', '-q', '--hard', base)
  const sha = commit({ 'docs/a.md': 'new head\n' }, 'the rewritten head')
  const { outputs, log } = run(dir, '--push', before, sha)
  assert.deepEqual(outputs, FULL)
  assert.match(log, /a forced push/)
})

test('pull request: the merge commit against its first parent, as before', () => {
  const { dir, commit } = repo()
  commit({ 'backend/app/main.py': 'x = 4\n' })
  assert.deepEqual(classify(dir, 'HEAD^1', 'HEAD'), {
    frontend: 'skip',
    drift: 'true',
    docker: 'false',
    visual: 'false',
  })
})
