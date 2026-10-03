import { MOOD_SCALE_KEYS, type MoodScaleKey } from '@/utils/moodScale'

// BE-78: the server counts the zones (ScoreZoneCounts, BE-77) -- this
// module only reads them. No client copy of the 1..10 boundaries exists.
export type MoodCounts = Record<MoodScaleKey, number>

export function moodTotal(counts: MoodCounts): number {
  return MOOD_SCALE_KEYS.reduce((total, key) => total + counts[key], 0)
}

// Moved to @/utils/format (DistributionCard owns the strip rendering now);
// re-exported so the existing imports (and the pinned tests) keep working.
export { formatPercent } from '@/utils/format'
