// Git fixtures shared by the brand clone tests (brand-git.test.mjs,
// brand-packages.test.mjs). They do NOT use the code under test to build their
// environment: every GIT_* variable is dropped here (a git hook exports
// GIT_DIR and friends, and a fixture aimed at the hook's repository corrupts
// it), then no global or system config is read and the author is fixed.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach } from 'vitest'

/** The environment of a fixture git call: no GIT_* of the caller at all. */
export const fixtureEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@test.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@test.invalid',
}

/** `git -C dir ...` in the fixture environment; returns trimmed stdout. */
export const run = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: fixtureEnv }).trim()

/** A repository with one commit tagged v1.0.0; returns the commit. */
export function makeRepo(dir, text = 'one') {
  execFileSync('git', ['init', '--quiet', dir], { env: fixtureEnv })
  writeFileSync(join(dir, 'a.txt'), text)
  run(dir, 'add', '.')
  run(dir, 'commit', '--quiet', '--no-gpg-sign', '-m', 'one')
  run(dir, 'tag', 'v1.0.0')
  return run(dir, 'rev-parse', 'HEAD')
}

/**
 * The code under test builds its git environment from process.env: for the
 * length of each test no global or system config is read, whatever the
 * machine has. Call once at the top of a test file.
 */
export function useQuietGitConfig() {
  let saved
  beforeEach(() => {
    saved = [process.env.GIT_CONFIG_GLOBAL, process.env.GIT_CONFIG_SYSTEM]
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'
    process.env.GIT_CONFIG_SYSTEM = '/dev/null'
  })
  afterEach(() => {
    const [global, system] = saved
    if (global === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = global
    if (system === undefined) delete process.env.GIT_CONFIG_SYSTEM
    else process.env.GIT_CONFIG_SYSTEM = system
  })
}
