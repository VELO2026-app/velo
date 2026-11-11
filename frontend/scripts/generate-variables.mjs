// =============================================================================
// FE-124 track T, step 1 -- the token pipeline (tz-whitelabel §3.3): tokens.json is
// the SOURCE, variables.css is GENERATED from it.
// =============================================================================
// Rule-based inverse of the one-time extractor: walk the DTCG tree in
// $extensions.pridem.order, emit `before` comments verbatim, then the
// declaration line (`  <cssName>: <verbatim value>;` + optional trailing
// comment), then the reduced-motion block verbatim. The output must be BYTE
// FOR BYTE equal to the migrated file -- styles/variables-roundtrip.test.ts
// pins that, so a hand-edit to EITHER side goes red until tokens.json (the
// source) and the file agree.
//
// Run from frontend/:  node scripts/generate-variables.mjs [outfile]
// No outfile -> writes src/styles/variables.css in place.
// =============================================================================
import { pathToFileURL } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const tokensPath = join(here, '..', 'tokens.json')
const cssPath = join(here, '..', 'src', 'styles', 'variables.css')

/** Build variables.css from the token document. PURE (no fs): the unit test
 *  pins its output byte-for-byte against the committed file. */
export function generateVariables(doc) {
  const ext = doc.$extensions.pridem
  const root = doc.root

  const rows = []
  const walk = (node) => {
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('$')) continue
      if (value && typeof value === 'object' && '$value' in value) {
        // A token MAY also carry nested children (--velo-primary is a leaf AND
        // the group of --velo-primary-dark): collect it AND keep walking.
        rows.push({ key, token: value })
        walk(value)
      } else if (value && typeof value === 'object') {
        walk(value)
      }
    }
  }
  walk(root)
  rows.sort((a, b) => a.token.$extensions.pridem.order - b.token.$extensions.pridem.order)

  const out = [ext.header]
  for (const { token } of rows) {
    const p = token.$extensions?.pridem ?? {}
    // The reduced-motion block is emitted at the very end (see below) -- not
    // here: the root trailing comment sits between the last token and it.
    if (p.overrides !== undefined) continue
    for (const line of p.before ?? []) out.push(line)
    // The value slice is VERBATIM from the source line(s) (leading space and
    // interior newlines included): one template reproduces both shapes 1:1.
    // FE-150: DTCG `$deprecated` (a string: "<date>: <why>, delete in <generation>";
    // scripts/lib/token-audit.mjs refuses every other shape)
    // is the machine-readable source of the deprecation; the CSS mirrors it as
    // its own comment line right above the declaration (a trailing one would
    // push the line past prettier's width and get the value re-wrapped).
    if (typeof token.$deprecated === 'string') out.push(`  /* @deprecated ${token.$deprecated} */`)
    out.push(`  ${p.cssName}:${token.$value};${p.trailing ? ` /* ${p.trailing} */` : ''}`)
  }
  for (const line of ext.trailingComment ?? []) out.push(line)
  out.push('}', '', ext.mediaBlock)
  return out.join('\n')
}

// CLI entry: node scripts/generate-variables.mjs [outfile] (default: the
// real variables.css). The import above stays side-effect free for tests.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const doc = JSON.parse(readFileSync(tokensPath, 'utf8'))
  writeFileSync(process.argv[2] ?? cssPath, generateVariables(doc))
  console.log('variables.css generated from tokens.json')
}
