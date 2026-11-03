// =============================================================================
// VELO Frontend -- @velo/ui boundary (FE-116 raised it, FE-117 batch A opens
// the ONE legitimate door, tz-ui-package.md §3/§4 P2)
// =============================================================================
//
// From batch A on, the application's UI barrel (src/components/ui/index.ts)
// re-exports migrated components from '@velo/ui' component-by-component --
// that is the migration's whole mechanics (principle 1: consumers never
// change an import). The boundary law around that door:
//
//   1. ONLY src/components/ui/index.ts may import '@velo/ui' -- no view,
//      store, composable or any other source touches the package directly;
//   2. the specifier must be the EXACT barrel '@velo/ui' -- a deep subpath
//      ('@velo/ui/...') stays banned until P8 reviews the eslint boundary.
//
// Scans *.ts and *.vue sources for imports of '@velo/ui' (any subpath).
// =============================================================================

import { describe, expect, it } from 'vitest'

const files = import.meta.glob<string>('/src/**/*.{ts,vue}', {
  query: '?raw',
  import: 'default',
  eager: true,
})

const UI_PACKAGE_IMPORT = /from\s+['"](@velo\/ui[^'"]*)['"]/
const BARREL_PATH = 'components/ui/index.ts'

describe('@velo/ui boundary (FE-117: the barrel flips, nothing else touches the package)', () => {
  it('the detector works: real and deep imports are found in a fixture', () => {
    // Self-test of the harness -- a gate that cannot fire is decoration.
    const legal = "import { VButton } from '@velo/ui'"
    const deep = "import { VButton } from '@velo/ui/dist'"
    const appLocal = "import { VButton } from '@/components/ui'"
    expect(legal.match(UI_PACKAGE_IMPORT)?.[1]).toBe('@velo/ui')
    expect(deep.match(UI_PACKAGE_IMPORT)?.[1]).toBe('@velo/ui/dist')
    expect(appLocal.match(UI_PACKAGE_IMPORT)).toBeNull()
  })

  it('only the ui barrel imports @velo/ui, and only the exact barrel specifier', () => {
    expect(Object.keys(files).length).toBeGreaterThan(100) // the glob saw the codebase
    const violations: string[] = []
    let barrelImports = 0
    for (const [rawPath, content] of Object.entries(files)) {
      const path = rawPath.replace(/^\/src\//, '')
      const lines = content.split('\n')
      lines.forEach((line, index) => {
        const specifier = line.match(UI_PACKAGE_IMPORT)?.[1]
        if (!specifier) return
        if (path !== BARREL_PATH) {
          violations.push(`${path}:${index + 1}: import outside the barrel -- use @/components/ui`)
          return
        }
        barrelImports += 1
        if (specifier !== '@velo/ui') {
          violations.push(`${path}:${index + 1}: deep import '${specifier}' -- the barrel only`)
        }
      })
    }
    // The flip is live: the barrel itself must reference the package.
    expect(barrelImports).toBeGreaterThan(0)
    expect(violations).toEqual([])
  })
})
