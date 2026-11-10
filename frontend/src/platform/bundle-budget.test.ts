// =============================================================================
// VELO Frontend -- bundle budget gate tests (FE-157 stage 2E)
// =============================================================================
// `bundle-report --budget` runs against a synthetic dist/ whose entry gzip
// size is measured here, so the budget is set relative to the real number:
// +2% of the budget passes, beyond it fails; a precache over budget fails.
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
}

// Deterministic, poorly compressible entry content.
let seed = 12345
const noise = Array.from({ length: 20000 }, () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return String.fromCharCode(33 + (seed % 90))
}).join('')
const entryGzip = gzipSync(Buffer.from(noise)).length
const precacheBytes = 1000

/** Build a minimal dist/ plus a budget file, run the gate, return exit code and output. */
function run(name: string, budget: Budget, withSw = true) {
  const dir = join(root, name)
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<html></html>')
  writeFileSync(join(dir, 'assets/app-abc.js'), noise)
  writeFileSync(join(dir, 'pre.bin'), Buffer.alloc(precacheBytes))
  if (withSw) {
    writeFileSync(join(dir, 'sw.js'), 'precacheAndRoute([{url:"pre.bin",revision:null}],{})')
  }
  const budgetPath = join(dir, 'budget.json')
  writeFileSync(budgetPath, JSON.stringify(budget))
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

  it('fails when precache exceeds the budget, even by one byte', () => {
    const r = run('over-precache', { entryGzip, precacheBytes: precacheBytes - 1 })
    expect(r.status).toBe(1)
    expect(r.out).toContain('precache')
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
  })
})
