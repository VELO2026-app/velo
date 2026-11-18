// =============================================================================
// VELO Frontend -- the Vitest sequencer: --shard by recorded duration (FE-204)
// =============================================================================
// Only shard() changes: the files of shard i/n come from
// scripts/lib/duration-shard.mjs over test-durations.json instead of a path
// hash. The order inside a shard stays Vitest's own (failed, then slowest
// first, from its results cache).
// =============================================================================
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { BaseSequencer, type TestSpecification } from 'vitest/node'
import { partitionByDuration } from './scripts/lib/duration-shard.mjs'

const RECORD = new URL('./test-durations.json', import.meta.url)

/** Shards by recorded duration; everything else is the base sequencer. */
export default class DurationSequencer extends BaseSequencer {
  override shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config
    if (!shard) return Promise.resolve(files)
    const durations = JSON.parse(readFileSync(RECORD, 'utf8')) as Record<string, number>
    const keyOf = (f: TestSpecification) => `${f.project.name}:${relative(root, f.moduleId)}`
    const buckets = partitionByDuration(files.map(keyOf), durations, shard.count)
    const mine = new Set(buckets[shard.index - 1])
    return Promise.resolve(files.filter((f) => mine.has(keyOf(f))))
  }
}
