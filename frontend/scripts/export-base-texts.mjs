// =============================================================================
// VELO Frontend -- the base texts for validate-texts (FE-133)
// =============================================================================
// Writes <outDir>/<lang>.json for every locale folder of src/locales: the
// folder's catalogs merged root-wise (the shape the composer holds, as
// locales/index.ts composes it; timezones.json is data, not messages). The
// runtime image carries them as /usr/local/lib/primer/texts: they are the
// product's languages and the messages a texts package overrides, for the
// machine's check (scripts/lib/texts-package.mjs). Run by the Dockerfile.
//
// Usage: node scripts/export-base-texts.mjs <outDir> [localesDir]
// =============================================================================

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Base catalogs by language: every <localesDir>/<lang>/*.json merged root-wise. */
export function readBaseTexts(localesDir) {
  const base = {}
  for (const lang of readdirSync(localesDir).sort()) {
    const langDir = join(localesDir, lang)
    if (!statSync(langDir).isDirectory()) continue
    const merged = {}
    for (const file of readdirSync(langDir).sort()) {
      if (!file.endsWith('.json') || file === 'timezones.json') continue
      Object.assign(merged, JSON.parse(readFileSync(join(langDir, file), 'utf8')))
    }
    base[lang] = merged
  }
  return base
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outDir = process.argv[2]
  if (!outDir) {
    console.error('usage: export-base-texts <outDir> [localesDir]')
    process.exit(2)
  }
  const localesDir = resolve(process.argv[3] ?? join(import.meta.dirname, '../src/locales'))
  mkdirSync(outDir, { recursive: true })
  const base = readBaseTexts(localesDir)
  for (const [lang, messages] of Object.entries(base))
    writeFileSync(join(outDir, `${lang}.json`), JSON.stringify(messages))
  console.log(`export-base-texts: ${Object.keys(base).join(', ')} -> ${outDir}`)
}
