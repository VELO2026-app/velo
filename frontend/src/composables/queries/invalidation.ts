// =============================================================================
// VELO Frontend -- mutation -> invalidated query keys, the one map (FE-157 4F)
// =============================================================================
//
// A mutation changes server data that other screens hold. Which ones is a
// fact about the server, not about the screen that ran the mutation, so it is
// written down here, once per mutation, instead of in each caller's success
// handler. A row lists key PREFIXES (./keys.ts); every Colada entry under a
// prefix goes stale, and the ones on screen refetch at once.
//
// While the migration runs, some of the same data still lives in Pinia
// stores. Each mutation composable refreshes those
// holders next to its `invalidateAfter()` call, marked as legacy; a line
// leaves when its store moves to Colada and its key joins the row here.
// =============================================================================

import { toValue } from 'vue'
import type { EntryKey, QueryCache, UseQueryEntry } from '@pinia/colada'
import { keys } from '@/composables/queries/keys'
import { forgetPersisted } from '@/composables/queries/persist'

/** Each mutation and the query-key prefixes it makes stale. */
export const INVALIDATES = {
  /**
   * `DELETE /bookings/{id}`: the booking turns cancelled, and its practice
   * frees a seat and loses is_booked / is_paid -- in every list that shows it
   * (school feeds, the calendar week) and in its detail.
   */
  cancelBooking: [keys.bookings.root(), keys.practices.root()],
  /**
   * `POST /practices/{id}/purchase` or `POST /bookings`: a new booking takes a
   * seat -- every list and the detail of its practice change is_booked /
   * is_paid / seats. Not the school page: a booking makes nobody a member
   * (SchoolMember comes only from an invite, a join or a transfer).
   */
  purchaseBooking: [keys.bookings.root(), keys.practices.root()],
  /** `POST /waitlist/{id}/confirm`: the waitlist spot becomes a booking, taking a seat. */
  confirmWaitlist: [keys.bookings.root(), keys.practices.root()],
  /** `POST /bookings/{id}/join`: sets `joined_at` on the booking. */
  joinBooking: [keys.bookings.root()],
  /** `POST /bookings/{id}/skip-checkin`: sets `checkin_skipped` on the booking. */
  skipCheckin: [keys.bookings.root()],
  /** `POST /practices/{id}/checkin`: flips `has_checkin` on the booking. */
  submitCheckin: [keys.bookings.root()],
  /** `POST /practices/{id}/feedback`: flips `has_feedback` on the booking. */
  submitFeedback: [keys.bookings.root()],
  /** `POST /practices/{id}/reflection`: flips `has_reflection` on the booking. */
  submitReflection: [keys.bookings.root()],
  /**
   * The master's own practice changed: created, edited, published, cancelled
   * or deleted (stores/master.ts, refreshMyPractices). Every list that shows
   * it -- a school feed included -- and its detail.
   */
  changePractice: [keys.practices.root()],
  /**
   * `POST /schools/join/{token}`: a new membership -- every school list and
   * the hub (the dock's Schools tab), the school page's relation, and the
   * practice feeds the membership opens.
   */
  joinSchool: [keys.schools.root(), keys.practices.root()],
} as const satisfies Record<string, readonly EntryKey[]>

/** Name of a mutation that has a row in `INVALIDATES`. */
export type MutationName = keyof typeof INVALIDATES

/**
 * Mark every entry under the mutation's prefixes stale and refetch the ones
 * that matter now: those on screen, and the persisted ones off screen (small,
 * and their copy must not outlive the change). A persisted copy of an entry
 * not on screen is dropped first (./persist.ts, forgetPersisted).
 *
 * @remarks
 * Resolves when EVERY refetch settled -- each awaited on its own, so one that
 * fails early cannot release a caller still waiting for another (the cancel
 * control waits for the bookings list). Never rejects: a failed refetch is
 * already recorded on its entry (its screen shows it), and a mutation that
 * succeeded on the server must not turn into an error because a follow-up
 * read failed. Entries off screen and not persisted only go stale: their next
 * reader refetches them.
 */
export async function invalidateAfter(
  queryCache: QueryCache,
  mutation: MutationName,
): Promise<void> {
  const entries = new Set<UseQueryEntry>()
  for (const key of INVALIDATES[mutation]) {
    forgetPersisted(queryCache, key)
    for (const entry of queryCache.getEntries({ key })) entries.add(entry)
  }
  const refetches: Promise<unknown>[] = []
  for (const entry of entries) {
    queryCache.invalidate(entry)
    if (!entry.options || !toValue(entry.options.enabled)) continue
    if (entry.active || entry.meta.persist === true) refetches.push(queryCache.fetch(entry))
  }
  await Promise.allSettled(refetches)
}
