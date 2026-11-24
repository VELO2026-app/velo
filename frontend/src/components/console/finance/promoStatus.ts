// =============================================================================
// VELO Frontend -- the status of a promo code in the console table
// =============================================================================
//
// The API carries one flag (`is_active`) and the facts that end a promo by
// themselves: its use limit and its end date. The table says which of them
// applies, in this order: deactivated by hand, used up, past its end date.
// =============================================================================

import type { AdminPromoResponse } from '@/api/admin'

/** What the table says about a promo. */
export type PromoStatus = 'active' | 'exhausted' | 'expired' | 'inactive'

/** The fields of a promo the status reads. */
export type PromoFacts = Pick<
  AdminPromoResponse,
  'is_active' | 'max_uses' | 'used_count' | 'valid_until'
>

/**
 * The status of a promo at a moment.
 *
 * @param now - the moment, in milliseconds since the epoch
 */
export function promoStatus(promo: PromoFacts, now: number): PromoStatus {
  if (!promo.is_active) return 'inactive'
  if (promo.max_uses !== null && promo.used_count >= promo.max_uses) return 'exhausted'
  if (promo.valid_until !== null && Date.parse(promo.valid_until) <= now) return 'expired'
  return 'active'
}
