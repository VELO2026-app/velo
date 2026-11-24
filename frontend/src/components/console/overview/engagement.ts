// =============================================================================
// VELO Frontend -- reading the engagement metrics (FE-268)
// =============================================================================
//
// What the dashboard and the analytics both do with the three metrics: name
// them, take a metric's rate and change out of the period overview, write a
// rate. One place, so the two screens cannot say it two ways.
// =============================================================================

import type { Component } from 'vue'
import { t } from '@/locales'
import type { AdminStatsOverviewResponse, ScoreZoneCounts } from '@/api/types'
import type { EngagementMetricKey } from '@/components/console/overview/types'
import { MOOD_SCALE_FILLS } from '@/utils/displayHelpers'
import { MOOD_SCALE_KEYS, MOOD_SCALE_LABELS, zoneTotal, type MoodScaleKey } from '@/utils/moodScale'
import { MOOD_SCALE_ICON } from '@/utils/ratingIcons'

/** The overview fields that carry each metric's rate and its change. */
const OVERVIEW_FIELDS = {
  checkin: { rate: 'checkin_rate_pct', delta: 'checkin_rate_delta' },
  feedback: { rate: 'feedback_rate_pct', delta: 'feedback_rate_delta' },
  return: { rate: 'return_rate_pct', delta: 'return_rate_delta' },
} as const satisfies Record<
  EngagementMetricKey,
  { rate: keyof AdminStatsOverviewResponse; delta: keyof AdminStatsOverviewResponse }
>

/** The name of a metric (i18n:console.metrics.<key>). */
export function engagementLabel(key: EngagementMetricKey): string {
  return t(`console.metrics.${key}`)
}

/**
 * A metric's rate and its change against the period before, from the overview
 * of one window. Both are empty until the overview answers; the change is null
 * when the period before had nothing to compare with.
 */
export function overviewRateOf(
  overview: AdminStatsOverviewResponse | null | undefined,
  key: EngagementMetricKey,
): { rate: number | null; delta: number | null | undefined } {
  if (!overview) return { rate: null, delta: undefined }
  const fields = OVERVIEW_FIELDS[key]
  return { rate: overview[fields.rate], delta: overview[fields.delta] }
}

/** A rate as "78%"; a dash for one that is not known. */
export function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate)}%`
}

/** One bar of the rating distribution: a zone of the 1..10 scale. */
export interface RatingRow {
  /** The zone. */
  key: MoodScaleKey
  /** Its name. */
  label: string
  /** Its face. */
  icon: Component
  /** Its bar colour (a token). */
  barColor: string
  /** Its share of the reviews left, percent; null -- no review at all. */
  rate: number | null
}

/**
 * The rating distribution as bars, the best zone first: each zone's count as
 * a share of the reviews left (null for every zone while there are none).
 */
export function ratingRowsOf(counts: ScoreZoneCounts): RatingRow[] {
  const total = zoneTotal(counts)
  return [...MOOD_SCALE_KEYS].reverse().map((key) => ({
    key,
    label: MOOD_SCALE_LABELS[key],
    icon: MOOD_SCALE_ICON[key],
    barColor: MOOD_SCALE_FILLS[key],
    rate: total === 0 ? null : Math.round((counts[key] / total) * 100),
  }))
}
