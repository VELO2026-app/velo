// =============================================================================
// FE-204 -- unit tests for the duration-balanced shard engine
// (node:test; run by `pnpm test` -- vitest globs src/** only).
// =============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { partitionByDuration, FILE_OVERHEAD_MS } from './duration-shard.mjs'

const KEYS = ['dom:a', 'dom:b', 'dom:c', 'dom:d', 'node:e', 'dom:new']
const DUR = { 'dom:a': 4000, 'dom:b': 3000, 'dom:c': 1000, 'dom:d': 1000, 'node:e': 500 }

test('every file lands in exactly one shard, new ones included', () => {
  const shards = partitionByDuration(KEYS, DUR, 3)
  assert.equal(shards.length, 3)
  assert.deepEqual(shards.flat().sort(), [...KEYS].sort())
})

test('the slow files are spread, not stacked: no shard holds the two slowest', () => {
  const shards = partitionByDuration(KEYS, DUR, 2)
  assert.ok(!shards.some((s) => s.includes('dom:a') && s.includes('dom:b')))
})

test('shard totals stay within one file of each other', () => {
  const keys = Array.from({ length: 40 }, (_, i) => `dom:f${i}`)
  const dur = Object.fromEntries(keys.map((k, i) => [k, (i % 7) * 300 + 100]))
  const totals = partitionByDuration(keys, dur, 3).map((s) =>
    s.reduce((sum, k) => sum + dur[k] + FILE_OVERHEAD_MS, 0),
  )
  const heaviest = Math.max(...Object.values(dur)) + FILE_OVERHEAD_MS
  assert.ok(Math.max(...totals) - Math.min(...totals) <= heaviest)
})

test('the same input gives the same partition (every shard computes it alone)', () => {
  const shuffled = [...KEYS].reverse()
  assert.deepEqual(partitionByDuration(KEYS, DUR, 3), partitionByDuration(shuffled, DUR, 3))
})

test('one shard holds everything; a bad count is refused', () => {
  assert.deepEqual(partitionByDuration(KEYS, DUR, 1)[0].sort(), [...KEYS].sort())
  assert.throws(() => partitionByDuration(KEYS, DUR, 0), /positive integer/)
})
