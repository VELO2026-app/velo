import type { PracticeResponse } from '@/api/types'
import { MOOD_SCALE_KEYS, moodKeyFromScore, type MoodScaleKey } from '@/utils/moodScale'

export type MoodCounts = Record<MoodScaleKey, number>

// UI-контракт: полный список, одна запись на ученика; null — нет ответа.
// Это НЕ текущий PracticeInsightsResponse, который содержит лишь три группы.
export interface PracticeAnswer {
  userId: string
  name: string
  before: number | null
  after: number | null
  comment: string | null
}

export interface PracticeAnalyticsData {
  practice: PracticeResponse
  participants: number
  answers: PracticeAnswer[]
}

export function isScore(value: number | null): value is number {
  return value !== null && Number.isInteger(value) && value >= 1 && value <= 10
}

export function countMoods(answers: PracticeAnswer[], stage: 'before' | 'after'): MoodCounts {
  const counts: MoodCounts = { bad: 0, low: 0, neutral: 0, good: 0, fire: 0 }
  for (const answer of answers) {
    const score = answer[stage]
    if (isScore(score)) counts[moodKeyFromScore(score)] += 1
  }
  return counts
}

export function moodTotal(counts: MoodCounts): number {
  return MOOD_SCALE_KEYS.reduce((total, key) => total + counts[key], 0)
}

// Moved to @/utils/format (DistributionCard owns the strip rendering now);
// re-exported so the existing imports (and the pinned tests) keep working.
export { formatPercent } from '@/utils/format'
