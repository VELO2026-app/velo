// =============================================================================
// @velo/ui -- Storybook main config (FE-116 skeleton, tz-ui-package.md §3.4)
// =============================================================================
// The витрина is up in P1, not P7: every migrating batch (P2-P6) writes its
// stories in the same переносной PR -- "стории пишутся в батчах, не в
// конце" -- and checks each one against the component's Figma frame.
// =============================================================================

import { basename, delimiter, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StorybookConfig } from '@storybook/vue3-vite'
import type { Plugin } from 'vite'

import {
  isSkinPackage,
  loadSkinPackage,
  readGoldenTokens,
  skinCss,
} from '../../../frontend/scripts/lib/skin-package.mjs'

const FRONTEND = fileURLToPath(new URL('../../../frontend/', import.meta.url))
const SKINS_MODULE = 'virtual:velo-skins'

/** The skin switcher's data (§3.7): the packages listed in VELO_SKINS
 *  (package directories separated by the path delimiter, e.g.
 *  `VELO_SKINS=../goodo-brand/skin pnpm storybook`) --
 *  converted to its token layer by the SAME engine the app build uses
 *  (FE-131: the packages are DTCG, the browser cannot read them as CSS).
 *  The showcase keeps the golden font, so the @font-face rules are left out.
 *  A broken package fails the storybook build, named. velo carries no skins
 *  (FE-131: partner brands live in their own repositories): without
 *  VELO_SKINS the switcher offers golden only. */
function veloSkins(): Plugin {
  return {
    name: 'velo-skins',
    resolveId: (id) => (id === SKINS_MODULE ? `\0${SKINS_MODULE}` : undefined),
    load(id) {
      if (id !== `\0${SKINS_MODULE}`) return undefined
      const golden = readGoldenTokens(FRONTEND)
      const layers: Record<string, string> = {}
      const dirs = (process.env['VELO_SKINS'] ?? '').split(delimiter).filter(Boolean)
      // Relative paths resolve from where the command was typed (pnpm
      // runs the script in packages/velo-ui; INIT_CWD is the caller's cwd).
      const base = process.env['INIT_CWD'] ?? process.cwd()
      for (const pkgDir of dirs.map((d) => resolve(base, d))) {
        // A package checked out as <repo>/skin is named after its repo.
        const name =
          basename(pkgDir) === 'skin' ? basename(resolve(pkgDir, '..')) : basename(pkgDir)
        if (!isSkinPackage(pkgDir)) throw new Error(`VELO_SKINS: ${pkgDir} is not a skin package`)
        const pkg = loadSkinPackage(pkgDir, golden)
        if (pkg.problems.length > 0) throw new Error(`${name}: ${pkg.problems.join('; ')}`)
        layers[name] = skinCss({ ...pkg, brand: pkg.brand && { ...pkg.brand, fonts: [] } })
      }
      return `export default ${JSON.stringify(layers)}`
    },
  }
}

const config: StorybookConfig = {
  // The token registry page (§3.7) lives HERE, not in src/: it reads the
  // host's variables.css and the skin files as build-time ?raw inputs --
  // showcase tooling, which the boundary law (the kit never imports the
  // host) deliberately scopes OUT of src/**.
  stories: ['../src/**/*.stories.ts', '../.storybook/**/*.stories.ts'],
  framework: {
    name: '@storybook/vue3-vite',
    options: {},
  },
  viteFinal: (vite) => ({ ...vite, plugins: [...(vite.plugins ?? []), veloSkins()] }),
}

export default config
