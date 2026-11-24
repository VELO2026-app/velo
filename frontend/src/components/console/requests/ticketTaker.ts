// =============================================================================
// VELO Frontend -- who holds a ticket, as a line (FE-262, slice 2)
// =============================================================================

import { t } from '@/locales'
import type { SupportPerson } from '@/api/support'

/**
 * The line that says who holds a ticket: nobody, the viewer, or another admin
 * by name (i18n:adminScreens.adminSupport.claimedBy.none, `.mine`, `.other`).
 *
 * @param claimedBy - the ticket's holder, null while nobody holds it
 * @param myId - the viewing admin's id
 */
export function takerLabel(claimedBy: SupportPerson | null, myId: string): string {
  if (!claimedBy) return t('adminScreens.adminSupport.claimedBy.none')
  if (claimedBy.user_id === myId) return t('adminScreens.adminSupport.claimedBy.mine')
  const name = claimedBy.name ?? t('adminScreens.adminSupport.claimedBy.adminFallback')
  return t('adminScreens.adminSupport.claimedBy.other', { name })
}
