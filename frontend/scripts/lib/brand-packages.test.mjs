// FE-234 item 6: a skin package of a Figma mode is the pinned commit -- a clone
// at the tag (the token never in the URL) or a clean local checkout.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkoutProblem, cloneEnv, fetchPackage, gitEnv } from './brand-packages.mjs'

// A git hook (pre-push runs these tests) exports GIT_DIR and friends: the fixture drops them
// (gitEnv) and reads no global or system config; the author comes from the environment.
const env = {
  ...gitEnv(process.env),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@test.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@test.invalid',
}
const run = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env }).trim()

let tmp
let origin
let sha
/** A repository with one commit tagged v1.0.0. */
function makeRepo(dir, text = 'one') {
  execFileSync('git', ['init', '--quiet', dir], { env })
  writeFileSync(join(dir, 'a.txt'), text)
  run(dir, 'add', '.')
  run(dir, 'commit', '--quiet', '--no-gpg-sign', '-m', 'one')
  run(dir, 'tag', 'v1.0.0')
  return run(dir, 'rev-parse', 'HEAD')
}
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'brand-packages-'))
  origin = join(tmp, 'origin')
  sha = makeRepo(origin)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const pin = () => ({ name: 'velo-brand', repo: 'org/velo-brand', tag: 'v1.0.0', sha })

describe('fetchPackage', () => {
  it('clones the tag and accepts the pinned commit', () => {
    const target = join(tmp, 'pkg')
    fetchPackage(pin(), target, { url: `file://${origin}` })
    expect(run(target, 'rev-parse', 'HEAD')).toBe(sha)
  })
  it('refuses a tag that moved off the pinned commit', () => {
    expect(() =>
      fetchPackage({ ...pin(), sha: 'b'.repeat(40) }, join(tmp, 'pkg'), {
        url: `file://${origin}`,
      }),
    ).toThrow(/the tag moved/)
  })
  it('a failed clone names the hint and masks the token', () => {
    const token = 'ghp_secret123'
    const err = (() => {
      try {
        fetchPackage({ ...pin(), tag: 'v9.9.9' }, join(tmp, 'pkg'), {
          url: `file://${origin}`,
          token,
        })
      } catch (e) {
        return /** @type {Error} */ (e)
      }
      throw new Error('no error')
    })()
    expect(err.message).toMatch(/cannot clone org\/velo-brand at v9.9.9/)
    expect(err.message).not.toContain(token)
  })
  it('the token travels as a header: never in the URL or the clone config, no prompt', () => {
    const env = cloneEnv('ghp_secret123', {})
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader')
    expect(env.GIT_CONFIG_VALUE_0).not.toContain('ghp_secret123')
    expect(cloneEnv('', {})).toEqual({ GIT_TERMINAL_PROMPT: '0' })
    expect(cloneEnv('', { GIT_DIR: '/repo/.git', PATH: '/bin' })).toEqual({
      PATH: '/bin',
      GIT_TERMINAL_PROMPT: '0',
    })
    const target = join(tmp, 'pkg')
    fetchPackage(pin(), target, { url: `file://${origin}`, token: 'ghp_secret123' })
    expect(readFileSync(join(target, '.git', 'config'), 'utf8')).not.toContain('ghp_secret123')
  })
})

describe('a git hook environment', () => {
  it('GIT_DIR / GIT_INDEX_FILE of the caller reach neither the checks nor the clone', () => {
    const decoy = join(tmp, 'decoy')
    makeRepo(decoy, 'decoy') // another commit: a leaked GIT_DIR shows up as a wrong HEAD
    const before = [
      run(decoy, 'rev-parse', 'HEAD'),
      readFileSync(join(decoy, '.git', 'config'), 'utf8'),
    ]
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE }
    process.env.GIT_DIR = join(decoy, '.git')
    process.env.GIT_INDEX_FILE = join(decoy, '.git', 'index')
    try {
      writeFileSync(join(decoy, 'a.txt'), 'edited') // dirty decoy: a leaked GIT_DIR would report it
      expect(checkoutProblem(origin, sha)).toBeNull()
      const target = join(tmp, 'pkg')
      fetchPackage(pin(), target, { url: `file://${origin}` })
      expect(run(target, 'rev-parse', 'HEAD')).toBe(sha)
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
  it('keeps credential helpers: only the repository-local variables go', () => {
    const base = {
      GIT_DIR: '/repo/.git',
      GIT_INDEX_FILE: '/repo/.git/index',
      GIT_ASKPASS: '/askpass',
      GIT_SSH_COMMAND: 'ssh',
      PATH: '/bin',
    }
    expect(gitEnv(base)).toEqual({ GIT_ASKPASS: '/askpass', GIT_SSH_COMMAND: 'ssh', PATH: '/bin' })
  })
})

describe('checkoutProblem', () => {
  it('a clean checkout at the pin passes', () => {
    expect(checkoutProblem(origin, sha)).toBeNull()
  })
  it('refuses a folder that is not a checkout, another commit, an uncommitted edit', () => {
    expect(checkoutProblem(tmp, sha)).toMatch(/not a git checkout/)
    expect(checkoutProblem(origin, 'b'.repeat(40))).toMatch(/HEAD is/)
    writeFileSync(join(origin, 'a.txt'), 'edited')
    expect(checkoutProblem(origin, sha)).toMatch(/uncommitted changes/)
  })
})
