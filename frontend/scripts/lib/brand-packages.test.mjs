// FE-234 item 6: a skin package of a Figma mode is the pinned commit -- a clone
// at the tag (the token never in the URL) or a clean local checkout.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkoutProblem, cloneEnv, fetchPackage } from './brand-packages.mjs'

const run = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim()

let tmp
let origin
let sha
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'brand-packages-'))
  origin = join(tmp, 'origin')
  execFileSync('git', ['init', '--quiet', origin])
  run(origin, 'config', 'user.email', 't@t')
  run(origin, 'config', 'user.name', 't')
  writeFileSync(join(origin, 'a.txt'), 'one')
  run(origin, 'add', '.')
  run(origin, 'commit', '--quiet', '-m', 'one')
  run(origin, 'tag', 'v1.0.0')
  sha = run(origin, 'rev-parse', 'HEAD')
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
    const target = join(tmp, 'pkg')
    fetchPackage(pin(), target, { url: `file://${origin}`, token: 'ghp_secret123' })
    expect(readFileSync(join(target, '.git', 'config'), 'utf8')).not.toContain('ghp_secret123')
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
