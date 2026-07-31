// =============================================================================
// VELO Frontend -- Practice card meta helpers (shared)
// =============================================================================
// Inline meta rendered under a practice card's title: check-in count, series
// recurrence, remaining sessions. Extracted from MasterPracticesView so the
// master dashboard's «Ближайшие практики» card renders identical meta (DB-2,
// 2026-06-30) WITHOUT duplicating the formatting logic.
//
// E12 swap (PROMPT №419, operator 2026-07-15): checkinLabel used to read the
// anonymous-insights mood tally (checkins.high/mid/low) as a stand-in check-in
// count. That number answers "how many diary entries were written" -- it
// double-counts a person who checks in AND writes again later, so a card
// could read more attendees than were actually coming. checkin_count
// (practices/schemas.py, owner-only) answers the real question -- distinct
// PRE check-ins -- so it replaces the insights source entirely. No more
// InsightsCache param: this file no longer touches diaryStore data.
// =============================================================================

import { recurrenceDaysLabel } from './displayHelpers'
import type { PracticeResponse } from '@/api/types'

/** Check-in count "N/M" (distinct PRE check-ins / capacity), owner-only.
 *
 * checkin_count is null for a non-owner (public feed, someone else's
 * detail) -- there is nothing honest to show there, so this returns null
 * and the caller omits the badge entirely (same v-if idiom as
 * recurrenceLabel/remainingSessionsLabel below). It must NOT render "0/M"
 * for null: that would fabricate a count for a viewer who isn't entitled to
 * one. A real 0 (owner, nobody checked in yet) DOES render as "0/M" -- the
 * operator's fraction rule holds whenever the number is real.
 */
export function checkinLabel(p: PracticeResponse): string | null {
  if (p.checkin_count == null) return null
  const denom = p.max_participants ?? p.current_participants
  return `${p.checkin_count}/${denom}`
}

/** Series recurrence: weekday list / «Ежедневно» from recurrence_days, falling
 * back to «Регулярная» for a series with no day list. null when not a series. */
export function recurrenceLabel(p: PracticeResponse): string | null {
  if (p.practice_type !== 'series') return null
  return recurrenceDaysLabel(p.recurrence_days) ?? 'Регулярная'
}

/** «Осталось N из M занятий» for a series with a known session count; null otherwise. */
export function remainingSessionsLabel(p: PracticeResponse): string | null {
  const total = p.total_sessions
  if (total == null) return null
  const left = Math.max(0, total - (p.completed_sessions ?? 0))
  return `Осталось ${left} из ${total} занятий`
}
