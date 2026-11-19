// FE-203: the local ESLint plugin for test hygiene (docs/testing.md rule 10).
// Two rules modeled on Landmines' no-fixed-sleep / no-flake-masking, built
// on our own ESLint instead of a second linter, plus the shrink-only
// exception list (test-lint-allowlist.json). Both eslint.config.js files
// (the app's and packages/velo-ui's) spread `testRulesConfig()`; the app's
// also spreads `e2eRulesConfig()` (FE-211: no-wait-for-timeout on the
// Playwright suite, no-fixed-sleep on its specs).
//
// Cache: ESLint fingerprints a plugin by name and meta.version only, not by
// its code. meta.version is therefore a hash of the rule sources, so an edit
// to a rule invalidates every cached result (locally and in CI, whose cache
// key also hashes eslint-rules/**). The list is passed as rule OPTIONS, so it
// is part of the resolved config and invalidates the cache the same way.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import noFixedSleep from './no-fixed-sleep.mjs'
import noFlakeMasking from './no-flake-masking.mjs'
import noWaitForTimeout from './no-wait-for-timeout.mjs'
import { ALLOWLIST_PATH, REPO_ROOT } from './ratchet.mjs'

const RULES = ['no-fixed-sleep', 'no-flake-masking', 'no-wait-for-timeout']

/** The files the rules run on, repo-relative: a list key must be one. */
const LINTED =
  /^((frontend|packages\/velo-ui)\/(src\/.+\.test\.ts|vitest\.config\.ts)|frontend\/e2e\/.+\.ts)$/

/** A hash of the rule sources (the *.mjs here, tests excluded). */
function sourceHash() {
  const dir = fileURLToPath(new URL('.', import.meta.url))
  const hash = createHash('sha256')
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.mjs') || name.endsWith('.test.mjs')) continue
    hash.update(name).update(readFileSync(path.join(dir, name)))
  }
  return hash.digest('hex').slice(0, 16)
}

export const plugin = {
  meta: { name: 'velo-tests', version: sourceHash() },
  rules: {
    'no-fixed-sleep': noFixedSleep,
    'no-flake-masking': noFlakeMasking,
    'no-wait-for-timeout': noWaitForTimeout,
  },
}

/**
 * Reads the exception list and splits it per rule.
 *
 * @param listPath - The list file, repo-relative (tests pass a temp file).
 * @returns `{ [rule]: { [repoPath]: count } }` for the rule options.
 * @throws Error when an entry names a file the rules do not lint, a missing
 * file or an unknown rule -- such an entry would keep a debt allowance
 * nobody can see.
 */
export function loadAllowlist(listPath = ALLOWLIST_PATH) {
  const raw = JSON.parse(readFileSync(path.resolve(REPO_ROOT, listPath), 'utf8'))
  const perRule = Object.fromEntries(RULES.map((r) => [r, {}]))
  for (const [file, counts] of Object.entries(raw.files ?? {})) {
    if (!LINTED.test(file)) {
      throw new Error(
        `${listPath}: ${file} is not a file the test rules lint ` +
          '(frontend/ or packages/velo-ui/: src/**/*.test.ts, vitest.config.ts; ' +
          'frontend/e2e/**/*.ts) -- fix the key.',
      )
    }
    if (!existsSync(path.join(REPO_ROOT, file))) {
      throw new Error(`${listPath}: ${file} does not exist -- remove its entry.`)
    }
    for (const [rule, count] of Object.entries(counts)) {
      if (!RULES.includes(rule)) {
        throw new Error(`${listPath}: ${file} names an unknown rule "${rule}".`)
      }
      perRule[rule][file] = count
    }
  }
  return perRule
}

/**
 * The flat-config entries that switch both rules on.
 *
 * @param testFiles - Globs of the test files, relative to the config.
 * @param configFiles - Globs of the vitest config files (timeouts, retry).
 * @returns Flat-config objects to spread into an eslint.config.js.
 */
export function testRulesConfig(testFiles, configFiles = []) {
  const allow = loadAllowlist()
  /** @type {import('eslint').Linter.Config[]} */
  const entries = [
    {
      files: testFiles,
      plugins: { 'velo-tests': plugin },
      rules: {
        'velo-tests/no-fixed-sleep': ['error', { allow: allow['no-fixed-sleep'] }],
        'velo-tests/no-flake-masking': ['error', { allow: allow['no-flake-masking'] }],
      },
    },
  ]
  if (configFiles.length > 0) {
    entries.push({
      files: configFiles,
      plugins: { 'velo-tests': plugin },
      rules: {
        'velo-tests/no-flake-masking': ['error', { allow: allow['no-flake-masking'] }],
      },
    })
  }
  return entries
}

/**
 * The flat-config entries for the Playwright suite (FE-211).
 *
 * @remarks
 * no-wait-for-timeout runs on every e2e file: Playwright's sleep has no
 * harness use. no-fixed-sleep runs on the test files only, as in the unit
 * suite: the harness keeps two runner-side timers in a Promise on purpose --
 * the 50 ms poll of settle() (a condition poll with a deadline) and the
 * `delayMs` of the API mock (a slow server, not a test waiting).
 * no-flake-masking is not applied: its limits are vitest's, and the
 * Playwright config bans retries on its own (retries: 0, forbidOnly on CI).
 *
 * @param allFiles - Globs of every e2e file, relative to the config.
 * @param testFiles - Globs of the e2e test files (specs, setup projects).
 * @returns Flat-config objects to spread into an eslint.config.js.
 */
export function e2eRulesConfig(allFiles, testFiles) {
  const allow = loadAllowlist()
  return [
    {
      files: allFiles,
      plugins: { 'velo-tests': plugin },
      rules: {
        'velo-tests/no-wait-for-timeout': ['error', { allow: allow['no-wait-for-timeout'] }],
      },
    },
    {
      files: testFiles,
      plugins: { 'velo-tests': plugin },
      rules: {
        'velo-tests/no-fixed-sleep': ['error', { allow: allow['no-fixed-sleep'] }],
      },
    },
  ]
}
