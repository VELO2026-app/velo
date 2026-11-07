// =============================================================================
// @velo/ui -- the reverse boundary (P8, tz-ui-package.md §4 P8; principle 2)
// =============================================================================
//
// The kit consumes the HOST's tokens and seams and never reaches back into
// the host application: no '@/...' alias imports, no 'frontend/...' path
// imports, and no kit-resident module escaping the package root relatively
// ('../../../frontend/...'). Host wiring arrives ONLY through the seams
// (configureUi({ t }), provide/inject keys) or props -- that inversion is
// the whole dependency arrow the migration built, so the gate that keeps it
// lives here, next to the app's own boundary law
// (frontend/src/ui-package-boundary.test.ts -- "only the doors import
// @velo/ui"). The eslint rule in eslint.config.js mirrors this for editors;
// this test is the CI gate.
//
// Scans *.ts and *.vue sources as raw text (the app's boundary test reads
// the same way).
// =============================================================================

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const PKG_ROOT = process.cwd()

function walkSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walkSources(p, out)
    else if (/\.(ts|vue)$/.test(name)) out.push(p)
  }
  return out
}

const HOST_IMPORT = /from\s+['"](?:@\/|frontend\/|\.\.\/(?:\.\.\/)+(?:frontend|packages\/(?!velo-ui)))[^'"]*['"]/

describe('@velo/ui reverse boundary (P8: the kit never imports the host)', () => {
  it('the detector works: host aliases and escapes are found in a fixture', () => {
    expect(HOST_IMPORT.test("import { t } from '@/locales'")).toBe(true)
    expect(HOST_IMPORT.test("import { host } from '../../frontend/src/platform/host'")).toBe(true)
    expect(HOST_IMPORT.test("import VButton from '../VButton'")).toBe(false)
    expect(HOST_IMPORT.test("import { configureUi } from './i18n'")).toBe(false)
  })

  it('no kit source imports the host application', () => {
    // The boundary test itself quotes host imports as detector fixtures --
    // it is the one exempt file (the same self-test shape every gate here
    // carries: a gate that cannot see its own fixtures is decoration).
    const files = walkSources(resolve(PKG_ROOT, 'src')).filter(
      (f) => !f.endsWith('src/boundary.test.ts'),
    )
    expect(files.length).toBeGreaterThan(50) // the walk saw the codebase
    const violations: string[] = []
    for (const path of files) {
      const rel = path.slice(PKG_ROOT.length + 1)
      const lines = readFileSync(path, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (HOST_IMPORT.test(line)) violations.push(`${rel}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(violations).toEqual([])
  })
})
