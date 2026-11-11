// =============================================================================
// VELO Frontend -- apply a skin package (tz-whitelabel §3)
// =============================================================================
// Copies a package (a checkout of a skin package repository -- velo carries
// no skins, FE-131) into public/skin/ WHOLE, then validates it -- the local fitting of
// what the deploy machine does on apply:build (the machine's slot is the
// rollout; this stays a dev tool, tz-whitelabel §3). The whole-folder copy is
// the point: the velo_test_front_bot incident happened because a partial
// package (tokens without the background) can be assembled by hand -- this
// command cannot be run halfway. A .git directory of a package checkout is
// left behind. Fails (exit 1) when the validator rejects the result; public/skin/
// is gitignored, this is a local/stand step BEFORE `pnpm build`.
//
// Usage: node scripts/apply-skin.mjs <package dir>  (e.g. `pnpm skin ../goodo-brand/skin`)
//        node scripts/apply-skin.mjs --remove      (back to the golden build)
// =============================================================================

import { cpSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IGNORED_FILES } from './lib/skin-package.mjs'

const frontendDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const target = join(frontendDir, 'public', 'skin')
const arg = process.argv[2]

if (arg === '--remove' || arg === 'remove') {
  rmSync(target, { recursive: true, force: true })
  console.log('apply-skin: package removed -- the next build is the golden VELO')
  process.exit(0)
}

if (!arg) {
  console.error('usage: node scripts/apply-skin.mjs <package dir>   |   --remove')
  process.exit(1)
}

const source = resolve(arg)
if (!existsSync(join(source, 'primer-package.yaml'))) {
  console.error(`apply-skin: no primer-package.yaml in ${source} (a skin package directory)`)
  process.exit(1)
}

// Whole-folder replace: never merge with a previous package's leftovers.
rmSync(target, { recursive: true, force: true })
cpSync(source, target, {
  recursive: true,
  filter: (from) => {
    const parts = from.split(/[\\/]/)
    return !parts.includes('.git') && !IGNORED_FILES.has(parts.at(-1) ?? '')
  },
})

const { validateSkin } = await import('./validate-skin.mjs')
const report = validateSkin(target, frontendDir)
for (const line of [...report.fails, ...report.warns, ...report.manual]) console.log(line)
console.log(
  `apply-skin: ${report.fails.length} fail(s), ${report.warns.length} warn(s) -- ` +
    (report.fails.length === 0 ? 'package applied, run `pnpm build`' : 'package REJECTED'),
)
process.exit(report.fails.length > 0 ? 1 : 0)
