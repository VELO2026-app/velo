// =============================================================================
// VELO Frontend -- build-log gate (FE-153)
// =============================================================================
// Usage: node scripts/build-log-gate.mjs <build.log>
// CI tees `pnpm -C frontend build` into a file and runs this on it: a
// cyclic cross-chunk re-export or an undefined html env placeholder fails
// the job. The rules live in scripts/lib/build-log-gate.mjs (unit-tested).
// =============================================================================
import { readFileSync } from 'node:fs'
import { findBuildLogWarnings } from './lib/build-log-gate.mjs'

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/build-log-gate.mjs <build.log>')
  process.exit(2)
}

const findings = findBuildLogWarnings(readFileSync(file, 'utf8'))
if (findings.length > 0) {
  console.error(`build-log gate: ${findings.length} gated warning(s) in ${file}`)
  for (const { rule, line } of findings) console.error(`  [${rule}] ${line}`)
  process.exit(1)
}
console.log('build-log gate: clean (no cyclic re-exports, no undefined html env placeholders)')
