// =============================================================================
// VELO Frontend -- shapes shared by the dashboard and analytics blocks (FE-268)
// =============================================================================
//
// In a .ts file, not exported from the .vue files that use them: the
// type-aware lint cannot read a type out of a single-file component.
// =============================================================================

import type { Component } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import type {
  CheckinMetricResponse,
  FeedbackMetricResponse,
  ReturnMetricResponse,
} from '@/api/types'

/** The engagement metrics, in the order the screens show them. */
export const ENGAGEMENT_METRICS = ['checkin', 'feedback', 'return'] as const

/** One engagement metric: the key of its card, its row, its endpoint and its text. */
export type EngagementMetricKey = (typeof ENGAGEMENT_METRICS)[number]

/** The answer of each metric's endpoint (`GET /admin/metrics/<metric>`). */
export interface EngagementMetricAnswers {
  checkin: CheckinMetricResponse
  feedback: FeedbackMetricResponse
  return: ReturnMetricResponse
}

/** The metric the analytics breakdown shows with its answer: one value, so a template narrows by `kind`. */
export type MetricDetailProps = {
  [K in EngagementMetricKey]: { kind: K; data: EngagementMetricAnswers[K] }
}[EngagementMetricKey]

/** One queue tile of the dashboard (AttentionQueues). */
export interface AttentionQueue {
  /** Stable key (test id, v-for key). */
  key: string
  /** Queue name. */
  label: string
  /** Icon of the queue. */
  icon: Component
  /** Items waiting; null -- not known. */
  count: number | null
  /** More than `count` wait (the count stopped at a page). */
  more?: boolean
  /** Where the queue is worked. */
  to: RouteLocationRaw
  /**
   * The queue's own request failed and nothing is held: the tile offers
   * `retry` instead of the way into the module. Not set for the queues the
   * shared counters feed (the screen's banner retries those).
   */
  failed?: boolean
  /** Ask this queue's count again. */
  retry?: () => void
}

/** One engagement row of the dashboard (EngagementCard). */
export interface EngagementRow {
  /** The metric. */
  key: EngagementMetricKey
  /** Metric name. */
  label: string
  /** The rate, percent; null -- not known. */
  rate: number | null
  /** Change against the period before, percentage points. */
  delta: number | null | undefined
  /** The metric in the analytics module. */
  to: RouteLocationRaw
}
