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
}

/** One engagement row of the dashboard (EngagementCard). */
export interface EngagementRow {
  /** Metric key (test id, v-for key). */
  key: string
  /** Metric name. */
  label: string
  /** The rate, percent; null -- not known. */
  rate: number | null
  /** Change against the period before, percentage points. */
  delta: number | null | undefined
  /** The metric in the analytics module. */
  to: RouteLocationRaw
}

/** The metric the analytics breakdown shows with its answer: one value, so a template narrows by `kind`. */
export type MetricDetailProps =
  | { kind: 'checkin'; data: CheckinMetricResponse }
  | { kind: 'feedback'; data: FeedbackMetricResponse }
  | { kind: 'return'; data: ReturnMetricResponse }
