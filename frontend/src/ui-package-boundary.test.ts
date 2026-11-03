// =============================================================================
// VELO Frontend -- @velo/ui boundary (FE-116 acceptance, tz-ui-package.md §3)
// =============================================================================
//
// P1 raises the @velo/ui skeleton (packages/velo-ui) with ZERO application
// imports: components migrate in P2-P6 batches, the barrel flips
// component-by-component, and the app keeps importing @/components/ui. This
// test pins that acceptance mechanically -- the first import from the
// package appears only in the batch PRs that migrate a component, and P8 is
// the phase where the boundary legitimately opens (the barrel re-export +
// package.json workspace:* dependency).
//
// Scans *.ts and *.vue sources for imports of '@velo/ui' (any subpath).
// =============================================================================

import { describe, expect, it } from 'vitest'

const files = import.meta.glob<string>('/src/**/*.{ts,vue}', {
  query: '?raw',
  import: 'default',
  eager: true,
})

const UI_PACKAGE_IMPORT = /from\s+['"]@velo\/ui/

describe('@velo/ui boundary (FE-116: the app imports nothing from the package)', () => {
  it('the detector works: a real import is found in a fixture', () => {
    // Self-test of the harness -- a gate that cannot fire is decoration.
    const fixture = [
      "import { VButton } from '@/components/ui'", // legal, stays
      "import { VButton } from '@velo/ui'", // what P1 forbids
    ].join('\n')
    expect(fixture.match(UI_PACKAGE_IMPORT)?.[0]).toContain('@velo/ui')
    expect("import { VButton } from '@/components/ui'".match(UI_PACKAGE_IMPORT)).toBeNull()
  })

  it('no application source imports @velo/ui', () => {
    expect(Object.keys(files).length).toBeGreaterThan(100) // the glob saw the codebase
    const violations: string[] = []
    for (const [rawPath, content] of Object.entries(files)) {
      const path = rawPath.replace(/^\/src\//, '')
      const lines = content.split('\n')
      lines.forEach((line, index) => {
        if (UI_PACKAGE_IMPORT.test(line))
          violations.push(`${path}:${index + 1}: ${line.trim().slice(0, 80)}`)
      })
    }
    expect(violations).toEqual([])
  })
})
