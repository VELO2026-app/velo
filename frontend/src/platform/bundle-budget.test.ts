// =============================================================================
// VELO Frontend -- bundle budget gate tests (FE-157 stage 2E)
// =============================================================================
// `bundle-report --budget` runs against a synthetic dist/ whose entry gzip
// size is measured here, so the budget is set relative to the real number:
// within +-2% of the budget passes, beyond it fails (FE-183: both sides, both
// metrics); over the ceiling fails. The rules themselves are pinned by
// scripts/lib/bundle-budget.test.mjs; this file is the CLI end to end.
// =============================================================================

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'

const script = join(__dirname, '../../scripts/bundle-report.mjs')
const root = mkdtempSync(join(tmpdir(), 'velo-budget-test-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

interface Budget {
  entryGzip: number
  precacheBytes: number
  ceiling?: { entryGzip: number; precacheBytes: number }
}

const CEILING = { entryGzip: 1_000_000, precacheBytes: 1_000_000 }

// Deterministic, poorly compressible entry content.
let seed = 12345
const noise = Array.from({ length: 20000 }, () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return String.fromCharCode(33 + (seed % 90))
}).join('')
const entryGzip = gzipSync(Buffer.from(noise)).length
const precacheBytes = 1000

/** Build a minimal dist/ plus a budget file, run the gate, return exit code and output. */
function run(
  name: string,
  budget: Budget,
  withSw = true,
  swList = '{url:"pre.bin",revision:null}',
) {
  const dir = join(root, name)
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<html></html>')
  writeFileSync(join(dir, 'assets/app-abc.js'), noise)
  writeFileSync(join(dir, 'pre.bin'), Buffer.alloc(precacheBytes))
  if (withSw) {
    writeFileSync(join(dir, 'sw.js'), `precacheAndRoute([${swList}],{})`)
  }
  const budgetPath = join(dir, 'budget.json')
  writeFileSync(budgetPath, JSON.stringify({ ceiling: CEILING, ...budget }))
  const r = spawnSync('node', [script, '--dist', dir, '--budget', budgetPath], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
  })
  return { status: r.status, out: r.stdout + r.stderr }
}

describe('bundle-report --budget', () => {
  it('passes when sizes equal the budget and prints the delta table', () => {
    const r = run('equal', { entryGzip, precacheBytes })
    expect(r.status).toBe(0)
    expect(r.out).toContain('| app chunk gzip |')
    expect(r.out).toContain('(±0.0%)')
  })

  it('passes when entry exceeds the budget by less than 2%', () => {
    const r = run('within', { entryGzip: Math.ceil(entryGzip / 1.015), precacheBytes })
    expect(r.status).toBe(0)
    expect(r.out).toContain('Bundle budget: ok')
  })

  it('fails when entry exceeds the budget by more than 2%', () => {
    const r = run('over-entry', { entryGzip: Math.floor(entryGzip / 1.03), precacheBytes })
    expect(r.status).toBe(1)
    expect(r.out).toContain('app chunk gzip')
    expect(r.out).toContain('FAIL')
  })

  it('fails when precache exceeds the budget by more than 2%', () => {
    const r = run('over-precache', { entryGzip, precacheBytes: Math.floor(precacheBytes / 1.03) })
    expect(r.status).toBe(1)
    expect(r.out).toContain('precache')
  })

  it('fails with the value to lower the budget to when the build is >2% below it', () => {
    const r = run('below', { entryGzip: Math.ceil(entryGzip * 1.1), precacheBytes })
    expect(r.status).toBe(1)
    expect(r.out).toContain(`lower the budget to ${Math.ceil(entryGzip * 1.01)}`)
    expect(r.out).toContain('bundle-report.mjs --modules')
  })

  it('fails over the ceiling even when the budget allows it', () => {
    const r = run('ceiling', {
      entryGzip,
      precacheBytes,
      ceiling: { entryGzip: entryGzip - 1, precacheBytes: 1_000_000 },
    })
    expect(r.status).toBe(1)
    expect(r.out).toContain('over the ceiling')
  })

  it('fails when the budget file has no ceiling', () => {
    const dir = join(root, 'no-ceiling')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ entryGzip, precacheBytes }))
    const r = spawnSync('node', [script, '--budget', join(dir, 'b.json')], { encoding: 'utf8' })
    expect(r.status).not.toBe(0)
  })

  it('counts a URL listed twice once (the PWA plugin repeats the manifest icons)', () => {
    const twice = '{url:"pre.bin",revision:null},{url:"pre.bin",revision:null}'
    const r = run('twice', { entryGzip, precacheBytes }, true, twice)
    expect(r.status).toBe(0)
  })

  it('fails when dist has no sw.js', () => {
    expect(run('no-sw', { entryGzip, precacheBytes }, false).status).toBe(1)
  })

  it('the committed budget file has numeric limits', () => {
    const b = JSON.parse(
      readFileSync(join(__dirname, '../../bundle-budget.json'), 'utf8'),
    ) as Budget
    expect(Number.isFinite(b.entryGzip)).toBe(true)
    expect(Number.isFinite(b.precacheBytes)).toBe(true)
    expect(b.ceiling?.entryGzip).toBe(150_000)
    expect(b.ceiling?.precacheBytes).toBe(1_000_000)
  })
})
