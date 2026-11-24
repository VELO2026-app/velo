// =============================================================================
// VELO Frontend -- the status of a promo code in the console table
// =============================================================================
//
// The API carries one flag (`is_active`) and the facts that end a promo by
// themselves: its use limit and its end date. The table says which of them
// applies, in this order: deactivated by hand, used up, past its end date.
// =============================================================================

/** What the table says about a promo. */
export type PromoStatus = 'active' | 'exhausted' | 'expired' | 'inactive'

/** The fields of a promo the status reads. */
export interface PromoFacts {
  is_active: boolean
  max_uses: number | null
  used_count: number
  valid_until: string | null
}

/**
 * The status of a promo at a moment.
 *
 * @param promo - the promo's own facts
 * @param now - the moment, ms since the epoch
 */
export function promoStatus(promo: PromoFacts, now: number): PromoStatus {
  if (!promo.is_active) return 'inactive'
  if (promo.max_uses !== null && promo.used_count >= promo.max_uses) return 'exhausted'
  if (promo.valid_until !== null && Date.parse(promo.valid_until) <= now) return 'expired'
  return 'active'
}
