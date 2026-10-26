// =============================================================================
// VELO Frontend -- apply a skin package (tz-whitelabel §3)
// =============================================================================
// Copies a package from skins/<name> (or any path) into public/skin/ WHOLE,
// then validates it. The whole-folder copy is the point: the velo_test_front_bot
// incident happened because a partial package (brand.json + tokens.css
// without bg/) can be assembled by hand -- this command cannot be run
// halfway. Fails (exit 1) when the validator rejects the result; public/skin/
// is gitignored, this is a local/stand step BEFORE `pnpm build`.
//
// Usage: node scripts/apply-skin.mjs <name|path>   (e.g. `pnpm skin nightfall`)
//        node scripts/apply-skin.mjs --remove      (back to the golden build)
// =============================================================================

import { cpSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const frontendDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const target = join(frontendDir, 'public', 'skin')
const arg = process.argv[2]

if (arg === '--remove' || arg === 'remove') {
  rmSync(target, { recursive: true, force: true })
  console.log('apply-skin: package removed -- the next build is the golden VELO')
  process.exit(0)
}

if (!arg) {
  console.error('usage: node scripts/apply-skin.mjs <name|path>   |   --remove')
  process.exit(1)
}

const source = existsSync(arg) ? resolve(arg) : join(frontendDir, 'skins', arg)
if (!existsSync(join(source, 'brand.json'))) {
  console.error(`apply-skin: no brand.json in ${source} (skins/<name> or a path)`)
  process.exit(1)
}

// Whole-folder replace: never merge with a previous package's leftovers.
rmSync(target, { recursive: true, force: true })
cpSync(source, target, { recursive: true })

const { validateSkin } = await import('./validate-skin.mjs')
const report = validateSkin(target, frontendDir)
for (const line of [...report.fails, ...report.warns, ...report.manual]) console.log(line)
console.log(
  `apply-skin: ${report.fails.length} fail(s), ${report.warns.length} warn(s) -- ` +
    (report.fails.length === 0 ? 'package applied, run `pnpm build`' : 'package REJECTED'),
)
process.exit(report.fails.length > 0 ? 1 : 0)
