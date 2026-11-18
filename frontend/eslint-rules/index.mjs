// FE-203: the local ESLint plugin for test hygiene (docs/testing.md rule 10).
// Two rules modeled on Landmines' no-fixed-sleep / no-flake-masking, built
// on our own ESLint instead of a second linter, plus the shrink-only
// exception list (test-lint-allowlist.json). Both eslint.config.js files
// (the app's and packages/velo-ui's) spread `testRulesConfig()`.
//
// The list is passed as rule OPTIONS, so it is part of the resolved config:
// editing it invalidates the ESLint cache like any other config change.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import noFixedSleep from './no-fixed-sleep.mjs'
import noFlakeMasking from './no-flake-masking.mjs'
import { ALLOWLIST_PATH, REPO_ROOT } from './ratchet.mjs'

const RULES = ['no-fixed-sleep', 'no-flake-masking']

export const plugin = {
  meta: { name: 'velo-tests' },
  rules: { 'no-fixed-sleep': noFixedSleep, 'no-flake-masking': noFlakeMasking },
}

/**
 * Reads the exception list and splits it per rule.
 *
 * @returns `{ [rule]: { [repoPath]: count } }` for the rule options.
 * @throws Error when an entry names a missing file or an unknown rule -- a
 * stale entry would keep a debt allowance nobody can see.
 */
function loadAllowlist() {
  const raw = JSON.parse(readFileSync(path.join(REPO_ROOT, ALLOWLIST_PATH), 'utf8'))
  const perRule = Object.fromEntries(RULES.map((r) => [r, {}]))
  for (const [file, counts] of Object.entries(raw.files ?? {})) {
    if (!existsSync(path.join(REPO_ROOT, file))) {
      throw new Error(`${ALLOWLIST_PATH}: ${file} does not exist -- remove its entry.`)
    }
    for (const [rule, count] of Object.entries(counts)) {
      if (!RULES.includes(rule)) {
        throw new Error(`${ALLOWLIST_PATH}: ${file} names an unknown rule "${rule}".`)
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
