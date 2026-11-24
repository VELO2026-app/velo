// The brand clone shared by the CI fetcher (.github/scripts/fetch-brand-skins.mjs)
// and the Figma sync (scripts/lib/brand-packages.mjs): a regression here
// breaks the CI matrix.
//
// The pinned regression: a git hook (pre-push runs these tests) exports
// GIT_DIR and friends, and a clone or a rev-parse with them aims at the
// HOOK's repository, not at ours -- a test run corrupted a working repository
// that way. The tests below poison the environment on purpose; the module
// must strip it (gitEnv) whatever the caller inherited.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneAtTag, cloneEnv, cloneFailure, cloneUrl, gitEnv } from './brand-git.mjs'
import { fixtureEnv, makeRepo, run, useQuietGitConfig } from './test-git-fixtures.mjs'

useQuietGitConfig()

let tmp
let origin
let sha
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'brand-git-'))
  origin = join(tmp, 'origin')
  sha = makeRepo(origin)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const pin = () => ({ name: 'velo-brand', repo: 'org/velo-brand', tag: 'v1.0.0' })
const clone = (target, opts = {}) =>
  cloneAtTag(pin(), target, {
    url: `file://${origin}`,
    anonymousHint: 'ANON-HINT',
    expectSha: sha,
    movedMessage: (head) => `MOVED ${head}`,
    ...opts,
  })
const failure = (fn) => {
  try {
    fn()
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  throw new Error('no error')
}

describe('the token', () => {
  it('is a header in the environment, with no prompt', () => {
    const env = cloneEnv('tok', {})
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GIT_CONFIG_COUNT).toBe('1')
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader')
    expect(env.GIT_CONFIG_VALUE_0).toMatch(/^AUTHORIZATION: basic /)
    expect(cloneEnv('', {}).GIT_CONFIG_COUNT).toBeUndefined()
  })
  it('is never in the URL', () => {
    expect(cloneUrl('a/b')).toBe('https://github.com/a/b.git')
    expect(cloneUrl('a/b')).not.toMatch(/@|token/)
  })
  it('is never in the clone config', () => {
    const target = join(tmp, 'pkg')
    clone(target, { token: 'ghp_secret123' })
    expect(readFileSync(join(target, '.git', 'config'), 'utf8')).not.toContain('ghp_secret123')
  })
})

describe('cloneFailure', () => {
  it('with a key tells what to do and never prints the token, plain or base64', () => {
    const basic = Buffer.from('x-access-token:s3cret').toString('base64')
    const text = cloneFailure(pin(), `fatal: s3cret ${basic}`, {
      token: 's3cret',
      anonymousHint: 'ANON-HINT',
    })
    expect(text).not.toContain('s3cret')
    expect(text).not.toContain(basic)
    expect(text).toMatch(/the tag may be missing, or BRAND_REPO_TOKEN cannot read/)
    expect(text).not.toContain('ANON-HINT')
  })
  it("without a key the hint is the caller's", () => {
    const text = cloneFailure(pin(), 'fatal: not found', { anonymousHint: 'ANON-HINT' })
    expect(text).toBe(
      'velo-brand: cannot clone org/velo-brand at v1.0.0 -- ANON-HINT\nfatal: not found',
    )
  })
})

describe('a git hook environment', () => {
  // The poison a pre-push hook leaves behind; the fixture must prove it
  // diverts git, or the regression test proves nothing.
  it('GIT_DIR / GIT_WORK_TREE do not aim our git at the hook repository', () => {
    const hook = join(tmp, 'hook-repo')
    const other = join(tmp, 'other')
    execFileSync('git', ['init', '--quiet', hook], { env: fixtureEnv })
    execFileSync('git', ['init', '--quiet', other], { env: fixtureEnv })
    const poisoned = { ...fixtureEnv, GIT_DIR: join(hook, '.git'), GIT_WORK_TREE: hook }
    const aimed = (env) =>
      execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
        cwd: other,
        env,
        encoding: 'utf8',
      }).trim()
    // realpath: on macOS TMPDIR is a symlink and git answers with the resolved path.
    expect(aimed(poisoned)).toBe(realpathSync(join(hook, '.git')))
    expect(aimed(gitEnv(poisoned))).toBe(realpathSync(join(other, '.git')))
    expect(cloneEnv('', poisoned).GIT_DIR).toBeUndefined()
  })
  it('the ways to reach a remote stay; the token header survives the strip', () => {
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
    const snapshot = () => [
      run(decoy, 'rev-parse', 'HEAD'),
      readFileSync(join(decoy, '.git', 'config'), 'utf8'),
    ]
    const before = snapshot()
    const names = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']
    const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]))
    process.env.GIT_DIR = join(decoy, '.git')
    process.env.GIT_WORK_TREE = decoy
    process.env.GIT_INDEX_FILE = join(decoy, '.git', 'index')
    try {
      writeFileSync(join(decoy, 'a.txt'), 'edited') // dirty decoy: a leaked GIT_DIR would report it
      const target = join(tmp, 'pkg')
      clone(target) // the commit check passes only if rev-parse answers for the clone
      expect(run(target, 'rev-parse', 'HEAD')).toBe(sha)
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
    expect(snapshot()).toEqual(before)
  })
})

describe('cloneAtTag', () => {
  it('clones the tag and accepts the pinned commit', () => {
    const target = join(tmp, 'pkg')
    clone(target)
    expect(run(target, 'rev-parse', 'HEAD')).toBe(sha)
  })
  it("refuses a moved tag with the caller's message", () => {
    expect(failure(() => clone(join(tmp, 'pkg'), { expectSha: 'b'.repeat(40) }))).toBe(
      `MOVED ${sha}`,
    )
  })
  it("a failed clone names the caller's hint", () => {
    const text = failure(() => clone(join(tmp, 'pkg'), { url: `file://${tmp}/missing` }))
    expect(text).toMatch(/velo-brand: cannot clone org\/velo-brand at v1\.0\.0 -- ANON-HINT/)
  })
  it('a failed clone with a key masks it', () => {
    const token = 'ghp_secret123'
    const text = failure(() => clone(join(tmp, 'pkg'), { url: `file://${tmp}/${token}`, token }))
    expect(text).toMatch(/the tag may be missing/)
    expect(text).not.toContain(token)
  })
})
