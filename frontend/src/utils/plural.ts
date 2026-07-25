// =============================================================================
// VELO Frontend -- Russian Plural Forms (SW14)
// =============================================================================
//
// The ONE canonical implementation. Previously reimplemented independently in
// MasterPublicView.vue, AdminDashboardView.vue, and MasterPracticesView.vue --
// all three agreed at every boundary case when audited, but with no shared
// source a future tweak to one would silently drift from the others.
// =============================================================================

/**
 * Pick the correct Russian plural form for a count.
 *
 * Standard mod-10/mod-100 agreement: 1, 21, 31... -> one; 2-4, 22-24... -> few;
 * 0, 5-20, 25-30... -> many (the 11-14 range is always "many" regardless of
 * the last digit, e.g. 11, 12, 111, 112).
 *
 * Examples:
 *   plural(1, 'год', 'года', 'лет')   -> 'год'
 *   plural(2, 'год', 'года', 'лет')   -> 'года'
 *   plural(5, 'год', 'года', 'лет')   -> 'лет'
 *   plural(11, 'год', 'года', 'лет')  -> 'лет'
 *   plural(21, 'год', 'года', 'лет')  -> 'год'
 */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 14) return many
  if (mod10 === 1) return one
  if (mod10 >= 2 && mod10 <= 4) return few
  return many
}
