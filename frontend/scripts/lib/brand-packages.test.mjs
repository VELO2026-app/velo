// FE-234 item 6: a skin package of a Figma mode is the pinned commit -- a clone
// at the tag (the token never in the URL) or a clean local checkout.
// The clone machinery itself (the hook-proof environment, the token, the
// masking) is FE-239's brand-git.test.mjs; these tests pin THIS module's own
// wording: the hint that names --pkg, the moved-tag message, checkoutProblem.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkoutProblem, fetchPackage } from './brand-packages.mjs'
import { gitEnv } from './brand-git.mjs'

// A git hook (pre-push runs these tests) exports GIT_DIR and friends: the fixture drops them
// (gitEnv) and reads no global or system config; the author comes from the environment.
const env = {
  ...gitEnv(process.env),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@test.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@test.invalid',
}
const run = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env }).trim()

// fetchPackage clones through cloneEnv(process.env): pin the config files it
// will read, so no test depends on the machine's git config.
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
    ).toThrow(/the pin is/)
  })
  it("a failed clone tells this tool's way out: --pkg", () => {
    const err = (() => {
      try {
        fetchPackage({ ...pin(), tag: 'v9.9.9' }, join(tmp, 'pkg'), { url: `file://${origin}` })
      } catch (e) {
        return /** @type {Error} */ (e)
      }
      throw new Error('no error')
    })()
    expect(err.message).toMatch(/cannot clone org\/velo-brand at v9\.9\.9/)
    expect(err.message).toMatch(/pass --pkg <mode>=<checkout>/)
  })
  it('a failed clone with a key never prints it', () => {
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
    expect(err.message).toMatch(
      /the tag may be missing, or BRAND_REPO_TOKEN cannot read the repository/,
    )
    expect(err.message).not.toContain(token)
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
