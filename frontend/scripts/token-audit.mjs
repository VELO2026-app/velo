// =============================================================================
// FE-150 -- token usage report (tz-whitelabel §3.3; Gen-2 registry reduction).
// =============================================================================
// Reads tokens.json and every consumer (src/, index.html, packages/velo-ui),
// prints: violations (the guard in scripts/lib/token-audit.test.mjs), the
// $deprecated tokens waiting for the next generation (with the skins that still set them),
// and the RARE tokens (1-2 product references) -- the input for the owner's
// consolidation calls. The rules live in scripts/lib/token-audit.mjs.
//
// Run from frontend/:  node scripts/token-audit.mjs [--json]
// Exit 1 when a violation exists.
// =============================================================================
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditTokens, auditViolations, readTree } from './lib/token-audit.mjs'

const frontendDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const { doc, files, skins } = readTree(frontendDir)
const rows = auditTokens(doc, files, skins)
const violations = auditViolations(rows)
const deprecated = rows.filter((r) => r.deprecated)
const rare = rows.filter((r) => !r.deprecated && r.prod > 0 && r.prod <= 2 && !r.dynamic)

if (process.argv.includes('--json')) {
  const plain = (r) => ({ ...r, files: [...r.files] })
  console.log(
    JSON.stringify(
      {
        tokens: rows.length,
        files: files.length,
        violations,
        deprecated: deprecated.map(plain),
        rare: rare.map(plain),
      },
      null,
      2,
    ),
  )
} else {
  const oneLine = (v) => v.replace(/\s+/g, ' ').trim()
  const out = []
  out.push(`## Token audit -- ${rows.length} tokens, ${files.length} files scanned`)
  out.push('')
  out.push(`### Violations (${violations.length})`)
  for (const v of violations) out.push(`- ${v}`)
  out.push('')
  out.push(`### Deprecated, removed in the next generation (${deprecated.length})`)
  for (const r of deprecated) {
    const skinNote = r.skins.length > 0 ? ` -- still set by ${r.skins.join(', ')}` : ''
    out.push(`- \`${r.cssName}\`: ${oneLine(r.value)} (${r.deprecated})${skinNote}`)
  }
  out.push('')
  out.push(`### Rare: 1-2 product references (${rare.length})`)
  for (const r of rare) {
    out.push(`- \`${r.cssName}\`: ${oneLine(r.value)} -- ${r.prod}x in ${[...r.files].join(', ')}`)
  }
  console.log(out.join('\n'))
}
process.exit(violations.length > 0 ? 1 : 0)
