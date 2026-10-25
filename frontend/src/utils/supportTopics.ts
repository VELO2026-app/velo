// =============================================================================
// VELO Frontend -- support topic and status labels (FE-104)
// =============================================================================
//
// THE ONE TABLE "topic code -> label" on the front: the catalog section
// `supportTopics.<code>` (owner ruling FE-104: one label per code, the same on
// both forms and in the admin list). The backend stores and returns codes
// only (models.TOPICS); its own labels serve the admin Telegram signal alone.
//
// Which form offers which topic is the form's business (its own list of
// codes); this module only names them.
// =============================================================================

import { t } from '@/locales'
import type { SupportTicketStatus, SupportTopicCode } from '@/api/support'

export function supportTopicLabel(code: SupportTopicCode): string {
  return t(`supportTopics.${code}`)
}

export function supportStatusLabel(status: SupportTicketStatus): string {
  return t(`adminScreens.adminSupport.statuses.${status}`)
}

/** The badge colour of a status -- one map for the admin list and the card. */
export type SupportStatusBadge = 'warning' | 'success' | 'muted' | 'info' | 'error'

const STATUS_BADGES: Record<SupportTicketStatus, SupportStatusBadge> = {
  open: 'warning',
  resolved: 'success',
  rejected: 'muted',
  duplicate: 'info',
  spam: 'error',
}

export function supportStatusBadge(status: SupportTicketStatus): SupportStatusBadge {
  return STATUS_BADGES[status]
}
