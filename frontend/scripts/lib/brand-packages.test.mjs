// FE-234 item 6: a skin package of a Figma mode is the pinned commit -- a clone
// at the tag or a clean local checkout. The clone machinery (the token, the
// masking, the hook-proof environment of the clone) is brand-git.test.mjs;
// these tests pin this module's own contract: its hint, its moved-tag message
// and checkoutProblem, which runs git itself.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkoutProblem, fetchPackage } from './brand-packages.mjs'
import { makeRepo, run, useQuietGitConfig } from './test-git-fixtures.mjs'

useQuietGitConfig()

let tmp
let origin
let sha
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
  it("a failed clone tells this tool's way out: --pkg", () => {
    expect(() =>
      fetchPackage({ ...pin(), tag: 'v9.9.9' }, join(tmp, 'pkg'), { url: `file://${origin}` }),
    ).toThrow(/cannot clone org\/velo-brand at v9\.9\.9 .*pass --pkg <mode>=<checkout>/s)
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
  it('GIT_DIR / GIT_INDEX_FILE of a hook do not aim the checks at its repository', () => {
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
