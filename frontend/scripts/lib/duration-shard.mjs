// =============================================================================
// VELO Frontend -- test shards balanced by recorded duration (FE-204)
// =============================================================================
// Vitest's own --shard sorts the files by a path hash and cuts equal COUNTS,
// so one shard can draw the three slowest screens and set the pace for all.
// This engine cuts equal TIME instead: longest file first onto the lightest
// shard (LPT). Every shard of a run reads the same committed
// test-durations.json, so they all compute the same partition -- each file
// lands in exactly one shard by construction. A file the record does not
// know yet (a new test) weighs the median, so it still lands somewhere; a
// stale record only costs balance, never coverage.
//
// The weight adds a fixed per-file cost: the recorded duration is the tests'
// own time, while every file also pays its environment and imports.
//
// Pure (keys in, buckets out) so it is unit-tested; vitest.sequencer.ts
// wires it in, scripts/test-durations.mjs refreshes the record.
// =============================================================================

/** Per-file setup (environment, imports) that the recorded duration leaves out, ms. */
export const FILE_OVERHEAD_MS = 300

/**
 * Split test files into `count` shards of near-equal total weight.
 *
 * @param keys - Every test file of the run, as `<project>:<path from root>`.
 * @param durations - Recorded duration per key, ms.
 * @param count - Number of shards (1 or more).
 * @returns One array of keys per shard; together they hold every key exactly once.
 */
export function partitionByDuration(keys, durations, count) {
  if (!Number.isInteger(count) || count < 1)
    throw new Error(`shard count must be a positive integer, got ${count}`)
  const known = keys.map((k) => durations[k]).filter((d) => typeof d === 'number')
  const sorted = [...known].sort((a, b) => a - b)
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
  const weight = (k) =>
    (typeof durations[k] === 'number' ? durations[k] : median) + FILE_OVERHEAD_MS
  const order = [...new Set(keys)].sort(
    (a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0),
  )
  /** @type {{ keys: string[], total: number }[]} */
  const shards = Array.from({ length: count }, () => ({ keys: [], total: 0 }))
  for (const key of order) {
    let lightest = shards[0]
    for (const s of shards) if (s.total < lightest.total) lightest = s
    lightest.keys.push(key)
    lightest.total += weight(key)
  }
  return shards.map((s) => s.keys)
}
