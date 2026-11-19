// =============================================================================
// VELO Frontend -- the conducted-practice card's data (FE-190)
// =============================================================================
//
// What ConductedPracticeCard reads. The school's row (SchoolConductedPracticeItem)
// reach it as ConductedPractice; the master's row (PracticeAnalyticsSummary,
// BE-222) goes through masterPracticeCard, which also yields the detail.
// =============================================================================

import { MOOD_SCALE_KEYS, MOOD_SCALE_LABELS, type MoodScaleKey } from '@/utils/moodScale'
import { MOOD_SCALE_FILLS } from '@/utils/displayHelpers'
import { MOOD_SCALE_ICON } from '@/utils/ratingIcons'
import type { PracticeAnalyticsSummary, ScoreZoneCounts } from '@/api/types'

/** The summary every conducted-practice card shows. */
export interface ConductedPractice {
  practice_id: string
  title: string
  direction: string | null
  scheduled_at: string
  timezone: string
  attendees_count: number
  reviews_count: number
  /** The reviews by the five zones: the card's strip. */
  rating: ScoreZoneCounts
  /** The school's rows name the practice's master; the master's own do not. */
  master_name?: string
  master_avatar_url?: string | null
}

/** The four blocks under the summary (master analytics). */
export interface ConductedPracticeDetail {
  attended: number
  before: ScoreZoneCounts
  after: ScoreZoneCounts
  pairs_total: number
  /** Reviews that carry text: the total of the practice's reviews list. */
  reviews_total: number
}

/** The five mood-scale bars of a distribution (zero counts included). */
export function moodStripBars(counts?: Partial<Record<MoodScaleKey, number>>) {
  return MOOD_SCALE_KEYS.map((key) => ({
    key,
    label: MOOD_SCALE_LABELS[key],
    count: counts?.[key] ?? 0,
    fill: MOOD_SCALE_FILLS[key],
    icon: MOOD_SCALE_ICON[key],
  }))
}

const sum = (c: ScoreZoneCounts): number => c.bad + c.low + c.neutral + c.good + c.fire

/**
 * The master's row (BE-222, PracticeAnalyticsSummary) as the card reads it. The
 * row carries the practice's own analytics, so the card's numbers come from it:
 * students = who came (`attended`), feedbacks = every review left (the sum of
 * `after`, one review per attendee) and the strip is `after` itself.
 */
export function masterPracticeCard(p: PracticeAnalyticsSummary): {
  practice: ConductedPractice
  detail: ConductedPracticeDetail
} {
  return {
    practice: {
      practice_id: p.practice_id,
      title: p.title,
      direction: p.direction,
      scheduled_at: p.scheduled_at,
      timezone: p.timezone,
      attendees_count: p.attended,
      reviews_count: sum(p.after),
      rating: p.after,
    },
    detail: {
      attended: p.attended,
      before: p.before,
      after: p.after,
      pairs_total: p.pairs_total,
      reviews_total: p.reviews_total,
    },
  }
}
