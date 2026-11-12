// =============================================================================
// VELO Frontend -- texts package validator, Node entry (FE-133)
// =============================================================================
// The machine runs `validate-texts <dir>` in the image (nginx/validate.js, njs).
// This is the same check under Node, for a developer or CI of a texts package:
//
//   node scripts/validate-texts.mjs <packageDir> [baseDir]
//
// baseDir holds <lang>.json base texts; default: written on the fly from
// src/locales (what the image carries). Exits 1 on any problem.
// =============================================================================

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { readBaseTexts } from './export-base-texts.mjs'
import primer from './lib/texts-package.mjs'

/** Check a package against `baseDir`, or against src/locales when not given. */
export function validateTexts(packageDir, baseDir) {
  if (baseDir) return primer.checkTexts(resolve(packageDir), resolve(baseDir))
  const tmp = mkdtempSync(join(tmpdir(), 'base-texts-'))
  try {
    const base = readBaseTexts(join(import.meta.dirname, '../src/locales'))
    for (const [lang, messages] of Object.entries(base))
      writeFileSync(join(tmp, `${lang}.json`), JSON.stringify(messages))
    return primer.checkTexts(resolve(packageDir), tmp)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [packageDir, baseDir] = process.argv.slice(2)
  if (!packageDir) {
    console.error('usage: validate-texts <packageDir> [baseDir]')
    process.exit(2)
  }
  const result = validateTexts(packageDir, baseDir)
  result.warnings.forEach((w) => console.log(`validate-texts: warning: ${w}`))
  result.problems.forEach((p) => console.log(`validate-texts: ${p}`))
  console.log(
    `validate-texts: ${result.problems.length} problem(s), ${result.warnings.length} warning(s)`,
  )
  process.exit(result.problems.length > 0 ? 1 : 0)
}
