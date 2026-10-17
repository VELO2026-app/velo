// =============================================================================
// VELO Frontend -- Practice status helpers (master-facing, shared)
// =============================================================================
//
// Single source for the MASTER practice-status badge, used by MasterPracticesView,
// MasterDashboardView and EditPracticeView (was 3 duplicated STATUS_LABEL /
// statusVariant copies). Role-status unification 2026-06-09:
//
//   Master shows a badge ONLY for operational/terminal states. The active phase
//   (scheduled / live, and ended-but-not-finalized) carries NO badge — the master
//   reads it from the date + the action buttons («Начать эфир» / «Завершить»).
//   So: draft → Черновик, completed → Завершена, cancelled → Отменена; everything
//   else (scheduled / live / deleted) → null (no badge).
//
// The practice-level time helpers mirror utils/bookingStatus.ts (which operates on
// a booking's embedded practice) for callers that hold a practice directly.
// =============================================================================

import i18n from '@/locales'
import type { PracticeStatus } from '@/api/types'

const { t } = i18n.global

export interface PracticeStatusBadge {
  label: string
  variant: 'success' | 'warning' | 'error'
}

/**
 * Master card badge for a practice status. Returns null for the active phase
 * (scheduled / live / deleted) — those get no badge.
 */
export function masterPracticeBadge(status: PracticeStatus): PracticeStatusBadge | null {
  switch (status) {
    case 'draft':
      return { label: t('practice.status.draft'), variant: 'warning' }
    case 'completed':
      return { label: t('practice.status.completed'), variant: 'success' }
    case 'cancelled':
      return { label: t('practice.status.cancelled'), variant: 'error' }
    default:
      // scheduled / live / deleted → no badge (date + buttons convey the phase)
      return null
  }
}

/** Practice end (start + duration) as epoch ms. Mirrors bookingStatus. */
export function practiceEndMs(p: { scheduled_at: string; duration_minutes: number }): number {
  return new Date(p.scheduled_at).getTime() + (p.duration_minutes ?? 0) * 60_000
}

/** Practice has ended (now past start + duration). Client time. */
export function practiceHasEnded(
  p: { scheduled_at: string; duration_minutes: number },
  nowMs: number,
): boolean {
  return nowMs >= practiceEndMs(p)
}
