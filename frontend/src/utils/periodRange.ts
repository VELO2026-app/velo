// =============================================================================
// VELO Frontend -- Admin period-range label (batch P, P1)
// =============================================================================
//
// Client-side label for the admin dashboard's navigated week/month, shifted by
// an offset (0 = current, -1 = previous …). Cosmetic mirror of the backend's UTC
// calendar bounds. Shared by AdminDashboardView (the stepper) and the Engagement
// drill-in detail views so both show the SAME week when the user drills in.
//
// SW17 (Батч 3, ПРОМТ №580): pinned to UTC throughout -- both the calendar
// math (which day is "today", which day a week starts on, which month an
// offset lands in) and the final render -- same decision as SW10's
// adminHelpers fix. Before this, every step used device-LOCAL Date getters/
// setters with no explicit timeZone, so two admins (or the same admin on two
// devices) navigating the same stepper offset could see different period
// labels, and near a day/month boundary could even land on a genuinely
// different absolute week/month than each other.
// =============================================================================

/** e.g. week → "29 июн - 5 июл"; month → "Июль 2026". */
export function formatPeriodRange(period: 'week' | 'month', offset: number): string {
  const now = new Date()
  if (period === 'week') {
    const dow = (now.getUTCDay() + 6) % 7 // Mon = 0, UTC calendar day
    const mon = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dow + offset * 7,
    ))
    const sun = new Date(Date.UTC(
      mon.getUTCFullYear(), mon.getUTCMonth(), mon.getUTCDate() + 6,
    ))
    const fmt = (d: Date): string =>
      d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).replace('.', '')
    return `${fmt(mon)} - ${fmt(sun)}`
  }
  const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1))
  return m.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}
