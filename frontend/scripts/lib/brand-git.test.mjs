// FE-239: the ONE brand clone -- the environment, the token, the failure
// text. The CI fetcher (.github/scripts/fetch-brand-skins.mjs) and the Figma
// sync (scripts/lib/brand-packages.mjs) both run on this module, so a
// regression here breaks the CI matrix.
//
// The pinned regression: a git hook (pre-push runs these tests) exports
// GIT_DIR and friends, and a clone or a rev-parse with them aims at the
// HOOK's repository, not at ours -- a test run corrupted a working repository
// that way (24.11). The tests below poison the environment on purpose; the
// module must strip it (gitEnv) whatever the caller inherited.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneAtTag, cloneEnv, cloneFailure, cloneUrl, gitEnv, revParseHead } from './brand-git.mjs'

// Any git the fixtures run: the hook's repository-local variables go
// (gitEnv), no global or system config, and the author comes from the
// variables below -- never from the machine running the tests.
const fixtureEnv = {
  ...gitEnv(process.env),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@test.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@test.invalid',
}
const run = (dir, ...a) =>
  execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: fixtureEnv }).trim()

// The clones INSIDE the module build their environment from process.env: pin
// the global and system config to nothing for the duration too, so no test
// ever reads the machine's git config (gitEnv keeps those variables on
// purpose -- they are the user's, only a test must not depend on them).
let savedGlobal
let savedSystem
beforeEach(() => {
  savedGlobal = process.env.GIT_CONFIG_GLOBAL
  savedSystem = process.env.GIT_CONFIG_SYSTEM
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_SYSTEM = '/dev/null'
})
afterEach(() => {
  if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = savedGlobal
  if (savedSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM
  else process.env.GIT_CONFIG_SYSTEM = savedSystem
})

let tmp
let origin
let sha
/** A repository with one commit tagged v1.0.0. */
function makeRepo(dir, text = 'one') {
  execFileSync('git', ['init', '--quiet', dir], { env: fixtureEnv })
  writeFileSync(join(dir, 'a.txt'), text)
  run(dir, 'add', '.')
  run(dir, 'commit', '--quiet', '--no-gpg-sign', '-m', 'one')
  run(dir, 'tag', 'v1.0.0')
  return run(dir, 'rev-parse', 'HEAD')
}
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'brand-git-'))
  origin = join(tmp, 'origin')
  sha = makeRepo(origin)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const pin = () => ({ name: 'velo-brand', repo: 'org/velo-brand', tag: 'v1.0.0', sha })

describe('the token', () => {
  it('never goes in the URL; it is a header in the environment', () => {
    expect(cloneUrl('a/b')).toBe('https://github.com/a/b.git')
    const env = cloneEnv('tok', {})
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GIT_CONFIG_COUNT).toBe('1')
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader')
    expect(env.GIT_CONFIG_VALUE_0).toMatch(/^AUTHORIZATION: basic /)
    expect(cloneEnv('', {}).GIT_CONFIG_COUNT).toBeUndefined()
  })
})

describe('cloneFailure', () => {
  const brand = { name: 'x', repo: 'a/b', tag: 'v1.0.0' }
  it('tells what to do and never prints the token, plain or base64', () => {
    const basic = Buffer.from('x-access-token:s3cret').toString('base64')
    const withToken = cloneFailure(brand, `fatal: s3cret ${basic}`, { token: 's3cret' })
    expect(withToken).not.toContain('s3cret')
    expect(withToken).not.toContain(basic)
    expect(withToken).toMatch(/the tag may be missing, or BRAND_REPO_TOKEN cannot read/)
  })
  it("without a key the hint is the caller's, not the token hint", () => {
    const text = cloneFailure(brand, 'fatal: not found', { anonymousHint: 'ANON-HINT' })
    expect(text).toMatch(/x: cannot clone a\/b at v1\.0\.0 -- ANON-HINT\nfatal: not found/)
  })
})

describe('a git hook environment', () => {
  // The poison a pre-push hook leaves behind; the fixture must prove it
  // diverts git, or the regression test proves nothing.
  const hookRepo = () => {
    const hook = join(tmp, 'hook-repo')
    const clone = join(tmp, 'clone')
    execFileSync('git', ['init', '--quiet', hook], { env: fixtureEnv })
    execFileSync('git', ['init', '--quiet', clone], { env: fixtureEnv })
    const poisoned = {
      ...fixtureEnv,
      GIT_DIR: join(hook, '.git'),
      GIT_WORK_TREE: hook,
    }
    const aimed = (env) =>
      execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
        cwd: clone,
        env,
        encoding: 'utf8',
      }).trim()
    return { hook, clone, poisoned, aimed }
  }

  it('GIT_DIR / GIT_WORK_TREE do not aim our git at the hook repository', () => {
    const { hook, clone, poisoned, aimed } = hookRepo()
    // realpath: on macOS TMPDIR is a symlink (/var -> /private/var) and git
    // answers with the resolved path.
    expect(aimed(poisoned)).toBe(realpathSync(join(hook, '.git')))
    expect(aimed(gitEnv(poisoned))).toBe(realpathSync(join(clone, '.git')))
    expect(cloneEnv('', poisoned).GIT_DIR).toBeUndefined()
  })
  it('keeps the ways to reach a remote; the token header survives the strip', () => {
    const base = { GIT_ASKPASS: '/bin/askpass', GIT_SSH_COMMAND: 'ssh -i k', GIT_DIR: '/x' }
    const env = cloneEnv('tok', base)
    expect(env.GIT_ASKPASS).toBe('/bin/askpass')
    expect(env.GIT_SSH_COMMAND).toBe('ssh -i k')
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_CONFIG_COUNT).toBe('1')
  })
  it('a live clone and commit check under the poison leave the hook repository alone', () => {
    const decoy = join(tmp, 'decoy')
    makeRepo(decoy, 'decoy') // another commit: a leaked GIT_DIR shows up as a wrong HEAD
    const before = [
      run(decoy, 'rev-parse', 'HEAD'),
      readFileSync(join(decoy, '.git', 'config'), 'utf8'),
    ]
    const saved = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
    }
    process.env.GIT_DIR = join(decoy, '.git')
    process.env.GIT_WORK_TREE = decoy
    process.env.GIT_INDEX_FILE = join(decoy, '.git', 'index')
    try {
      writeFileSync(join(decoy, 'a.txt'), 'edited') // dirty decoy: a leaked GIT_DIR would report it
      const target = join(tmp, 'pkg')
      cloneAtTag(pin(), target, { url: `file://${origin}` })
      expect(revParseHead(target)).toBe(sha) // not the decoy's commit
      expect(revParseHead(origin)).toBe(sha) // the check answers for the clone, not the decoy
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
    expect([
      run(decoy, 'rev-parse', 'HEAD'),
      readFileSync(join(decoy, '.git', 'config'), 'utf8'),
    ]).toEqual(before)
  })
})

describe('cloneAtTag', () => {
  it('clones the tag', () => {
    const target = join(tmp, 'pkg')
    cloneAtTag(pin(), target, { url: `file://${origin}` })
    expect(revParseHead(target)).toBe(sha)
  })
  it("a failed clone names the caller's hint and masks the token", () => {
    const token = 'ghp_secret123'
    try {
      cloneAtTag({ ...pin(), tag: 'v9.9.9' }, join(tmp, 'pkg'), {
        url: `file://${origin}`,
        token,
        anonymousHint: 'ANON-HINT',
      })
      throw new Error('no error')
    } catch (e) {
      expect(e instanceof Error ? e.message : String(e)).toMatch(
        /velo-brand: cannot clone org\/velo-brand at v9\.9\.9 -- the tag may be missing/,
      )
      expect(e instanceof Error ? e.message : String(e)).not.toContain(token)
    }
  })
  it('the token travels as a header: never in the URL or the clone config', () => {
    const target = join(tmp, 'pkg')
    cloneAtTag(pin(), target, { url: `file://${origin}`, token: 'ghp_secret123' })
    expect(readFileSync(join(target, '.git', 'config'), 'utf8')).not.toContain('ghp_secret123')
  })
})
