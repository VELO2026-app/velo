// =============================================================================
// VELO Frontend -- instance options the console screens read (FE-275)
// =============================================================================
//
// One place that answers "does this instance have payments" for the console:
// the menu hides Finance by the module's `option` (modules.ts); the screens
// that stay -- the dashboard, the masters -- hide the money on them with this.
// A screen reads it once at setup: the option is fixed for the life of the
// page (the instance config is applied before the app starts).
// =============================================================================

import { isOptionEnabled } from '@/platform/instance'

/**
 * Whether the instance has the payments option: its revenue figure, the
 * payout balance of a master, the payout queue. Without it none of them is
 * shown and nothing asks the API for them.
 *
 * @returns true when payments are on
 */
export function consoleHasPayments(): boolean {
  return isOptionEnabled('payments')
}
