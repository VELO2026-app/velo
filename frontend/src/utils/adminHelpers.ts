// =============================================================================
// VELO Frontend -- Admin Helper Utilities (F8-fix W-5)
// =============================================================================
//
// Shared pure functions used across admin views:
//   AdminMastersView, AdminMasterReviewView,
//   AdminReportsView, AdminReportDetailView.
//
// Extracted to eliminate copy-paste of statusVariant / statusLabel /
// targetLabel / displayName between views.
// =============================================================================

import type { AdminMasterListItem } from '@/api/admin'
import { dayKeyOf } from '@/utils/format'

// ============================================================================
// Master helpers
// ============================================================================

/**
 * Build display name from AdminMasterListItem first_name + last_name.
 * Falls back to 'Пользователь' when both are null.
 */
export function masterDisplayName(
  item: Pick<AdminMasterListItem, 'first_name' | 'last_name'>,
): string {
  const parts = [item.first_name, item.last_name].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : 'Пользователь'
}

/**
 * Map master_status to VBadge variant.
 */
export function masterStatusVariant(status: string): 'warning' | 'success' | 'error' | 'info' {
  if (status === 'pending') return 'warning'
  if (status === 'verified') return 'success'
  if (status === 'rejected') return 'error'
  if (status === 'suspended') return 'error'
  return 'info'
}

/**
 * Map master_status to Russian label.
 *
 * F3 (2026-07-07): `suspended` shows «Заблокирован» (the masters status filter
 * groups A1's soft-freeze under «Заблокированы»; the revoke ACTION stays
 * «Отозвать мастера»). `cancelled_by_user` → «Аккаунт удалён» (F4-ready; no
 * flow writes it yet, so it renders only once F4 ships).
 */
export function masterStatusLabel(status: string): string {
  if (status === 'pending') return 'Ожидает'
  if (status === 'verified') return 'Верифицирован'
  if (status === 'rejected') return 'Отклонён'
  if (status === 'suspended') return 'Заблокирован'
  if (status === 'cancelled_by_user') return 'Аккаунт удалён'
  return status
}

// ============================================================================
// Report helpers
// ============================================================================

/**
 * Map report status to VBadge variant.
 */
export function reportStatusVariant(status: string): 'warning' | 'success' | 'error' | 'info' {
  if (status === 'pending') return 'warning'
  if (status === 'resolved') return 'success'
  if (status === 'dismissed') return 'info'
  return 'info'
}

/**
 * Map report status to Russian label.
 */
export function reportStatusLabel(status: string): string {
  if (status === 'pending') return 'Ожидает'
  if (status === 'resolved') return 'Решена'
  if (status === 'dismissed') return 'Отклонена'
  return status
}

/**
 * Map report target_type to a Russian label.
 */
export function reportTargetLabel(type: string): string {
  if (type === 'user') return 'Юзер'
  if (type === 'master') return 'Мастер'
  if (type === 'practice') return 'Практика'
  return type
}

// ============================================================================
// Date helpers
// ============================================================================

/**
 * Format ISO date string to Russian locale datetime.
 *
 * SW10: pinned to UTC (like every other date function in the codebase --
 * see utils/format.ts) so two admins, or the same admin on two devices,
 * see the same absolute time for the same event.
 */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  })
}

/**
 * Relative "time ago" label for report/moderation cards (operator SVG
 * «1 Moderation»): «только что» / «N мин назад» / «N ч назад» / «Вчера», then
 * the absolute «DD MMM» for older items. Abbreviated units sidestep Russian
 * plural forms while staying readable.
 *
 * SW10: the day comparisons are pinned to UTC via dayKeyOf (utils/format.ts)
 * instead of the device's own local calendar fields -- otherwise "Вчера"
 * itself could misfire (or fail to fire) depending on which machine renders
 * the page, not just the displayed string's format.
 */
export function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  const diffMin = Math.floor((Date.now() - then) / 60000)
  if (diffMin < 1) return 'только что'
  if (diffMin < 60) return `${diffMin} мин назад`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH} ч назад`
  const yesterdayKey = dayKeyOf(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), 'UTC')
  if (dayKeyOf(iso, 'UTC') === yesterdayKey) return 'Вчера'
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}
