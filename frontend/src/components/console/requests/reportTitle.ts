// =============================================================================
// VELO Frontend -- the title of a complaint in the console (FE-262, slice 2)
// =============================================================================
//
// The report carries the target's type and id, not a name (the API has no
// names for the reporter or the target), so a complaint is titled by what it
// is about: "Complaint about a master". An unknown type shows itself.
// =============================================================================

import { t } from '@/locales'
import type { ReportResponse } from '@/api/admin'

/**
 * The one-line title of a complaint: who or what it is about.
 *
 * @param report - the complaint (only `target_type` is read)
 */
export function reportTitle(report: Pick<ReportResponse, 'target_type'>): string {
  const type = report.target_type
  if (type === 'user') return t('console.moderation.about.user')
  if (type === 'master') return t('console.moderation.about.master')
  if (type === 'practice') return t('console.moderation.about.practice')
  return t('console.moderation.about.other', { target: type })
}
