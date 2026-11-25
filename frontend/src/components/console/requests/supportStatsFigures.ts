// =============================================================================
// VELO Frontend -- support statistics figures for the console (FE-262, slice 2)
// =============================================================================
//
// The statistics endpoint gives ratings per category (rated count, average to
// hundredths, share of 4-5 stars to thousandths; both null when nothing was
// rated). The console tiles show one figure for the whole month, so the
// categories are folded here: the average and the share are weighted by how
// many tickets each category rated. No rating is not a zero -- a month with
// no rated ticket has no average and no share (null), never 0.
// =============================================================================

import type { SupportStatsCategory, SupportStatsFigures } from '@/api/support'

/** The rating figures of the whole period. */
export interface RatingTotals {
  /** Rated tickets over all categories. */
  rated: number
  /** Weighted average stars (0..5), null when nothing was rated. */
  average: number | null
  /** Weighted share of 4-5 star ratings (0..1), null when nothing was rated. */
  share: number | null
}

/**
 * Fold the per-category rating figures into the period's.
 *
 * @param categories - the statistics rows (all six categories, zeros included)
 */
export function ratingTotals(categories: readonly SupportStatsFigures[]): RatingTotals {
  const rated = categories.reduce((sum, c) => sum + c.rated, 0)
  if (rated === 0) return { rated: 0, average: null, share: null }
  const weighted = (pick: (c: SupportStatsFigures) => number | null): number =>
    categories.reduce((sum, c) => sum + (pick(c) ?? 0) * c.rated, 0) / rated
  return { rated, average: weighted((c) => c.average), share: weighted((c) => c.share_4_5) }
}

/**
 * A category's share of all tickets of the period, in whole percent.
 *
 * @returns null when the period has no tickets (an empty bar, "-").
 */
export function categoryShare(
  category: Pick<SupportStatsCategory, 'tickets'>,
  total: number,
): number | null {
  return total > 0 ? Math.round((category.tickets / total) * 100) : null
}

/** The change against the previous period as a signed string ("+12", "0", "-3"). */
export function signedDelta(current: number, previous: number): string {
  const diff = current - previous
  return diff > 0 ? `+${diff}` : String(diff)
}
