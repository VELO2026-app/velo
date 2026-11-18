// =============================================================================
// VELO Frontend -- refresh test-durations.json from Vitest's results cache (FE-204)
// =============================================================================
// Run after a full local `vitest run`. The record only balances the CI
// shards (vitest.sequencer.ts); a stale one costs balance, never coverage.
// Usage: node scripts/test-durations.mjs
// =============================================================================
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'

const CACHE = new URL('../node_modules/.vite/vitest/', import.meta.url)
const OUT = new URL('../test-durations.json', import.meta.url)

const durations = {}
for (const dir of existsSync(CACHE) ? readdirSync(CACHE) : []) {
  const file = new URL(`${dir}/results.json`, CACHE)
  if (!existsSync(file)) continue
  for (const [key, { duration }] of JSON.parse(readFileSync(file, 'utf8')).results) {
    if (typeof duration === 'number') durations[key] = Math.round(duration)
  }
}
const keys = Object.keys(durations).sort()
if (keys.length === 0) {
  console.error('test-durations: no Vitest results cache -- run `pnpm vitest run` first')
  process.exit(1)
}
writeFileSync(
  OUT,
  JSON.stringify(Object.fromEntries(keys.map((k) => [k, durations[k]])), null, 2) + '\n',
)
console.log(`test-durations: ${keys.length} files written to test-durations.json`)
