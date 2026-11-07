// =============================================================================
// VELO Frontend -- @velo/ui boundary (FE-116 raised it, FE-117 batch A opens
// the first legitimate door, FE-119 P4 opens the second, FE-143 opens the
// third -- the seam module, tz-ui-package.md §3/§4 P2/P4/P5)
// =============================================================================
//
// From batch A on, the application's UI barrel (src/components/ui/index.ts)
// re-exports migrated components from '@velo/ui' component-by-component --
// that is the migration's whole mechanics (principle 1: consumers never
// change an import). FE-119 (P4) moves the 12 cross-cutting glyphs into the
// kit's icon family and opens the same door for the icon barrel
// (src/components/icons/index.ts): it re-exports them from '@velo/ui' while
// the domain icons stay local. FE-143 (P5) moves the kit's first shared
// COMPOSABLE (the body-scroll lock -- it travels the ui barrel like the
// components) and inverts useKeyboardFieldScroll into a kit provide/inject
// seam: the app half of that seam
// (src/composables/useKeyboardFieldScroll.ts) must import the kit's
// injection key directly -- a provide/inject key cannot travel a barrel
// that components cycle back into -- so it becomes the third door.
//
// The boundary law around those doors:
//
//   1. ONLY the doors -- src/components/ui/index.ts,
//      src/components/icons/index.ts,
//      src/composables/useKeyboardFieldScroll.ts and, since P8,
//      src/components/ui/VTextarea.vue and
//      src/composables/useLoadingHold.ts -- may import '@velo/ui';
//      (the useLoadingHold door: the loading rule moved into the kit with
//      VLoadingSwap; screens keep importing it from the composables door,
//      the FE-143 shape)
//      no view, store, or any other source touches the package directly.
//      The VTextarea door (P8): the voice field is DOMAIN and stays
//      app-side (tz-ui-package §0, third exception next to VeloLogo /
//      VRatingBadges), yet it composes the kit's VFieldError; the door is
//      the exact-barrel import, the same one the kit-resident fields use.
//      A barrel-door import ('@/components/ui') here would CYCLE: the app
//      barrel re-exports VTextarea itself. When the voice seam is cut and
//      VTextarea moves, this door closes;
//   2. the specifier must be the EXACT barrel '@velo/ui' -- a deep subpath
//      ('@velo/ui/...') is banned by the P8 eslint boundary (no-restricted-imports).
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
const BARREL_PATHS = new Set([
  'components/ui/index.ts',
  'components/icons/index.ts',
  'composables/useKeyboardFieldScroll.ts',
  // P8: the residual voice field composes the kit's VFieldError (see above).
  'components/ui/VTextarea.vue',
  // P8: the loading rule moved into the kit with VLoadingSwap.
  'composables/useLoadingHold.ts',
])

describe('@velo/ui boundary (FE-117/FE-119: the barrels flip, nothing else touches the package)', () => {
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
        if (!BARREL_PATHS.has(path)) {
          violations.push(
            `${path}:${index + 1}: import outside the barrels -- use @/components/ui or @/components/icons`,
          )
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
