// =============================================================================
// VELO Frontend -- the title of a complaint in the console (FE-262, slice 2)
// =============================================================================
//
// The report carries the target's type and id, not a name (the API has no
// names for the reporter or the target), so a complaint is titled by what it
// is about: the type label of the admin helpers, as written there.
// =============================================================================

import { t } from '@/locales'
import type { ReportResponse } from '@/api/admin'
import { reportTargetLabel } from '@/utils/adminHelpers'

/**
 * The one-line title of a complaint: who or what it is about.
 *
 * @param report - the complaint (only `target_type` is read)
 */
export function reportTitle(report: Pick<ReportResponse, 'target_type'>): string {
  return t('console.moderation.about', { target: reportTargetLabel(report.target_type) })
}
