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

import type { EntryKey, QueryCache } from '@pinia/colada'
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
} as const satisfies Record<string, readonly EntryKey[]>

/** Name of a mutation that has a row in `INVALIDATES`. */
export type MutationName = keyof typeof INVALIDATES

/**
 * Mark every entry under the mutation's prefixes stale; the active ones refetch now.
 * A persisted copy under them that this session never loaded is dropped
 * (./persist.ts, forgetPersisted).
 *
 * @remarks
 * Resolves when those refetches settle and never rejects: a failed refetch is
 * already recorded on its entry (its screen shows it), and a mutation that
 * succeeded on the server must not turn into an error because a follow-up
 * read failed.
 */
export async function invalidateAfter(
  queryCache: QueryCache,
  mutation: MutationName,
): Promise<void> {
  for (const key of INVALIDATES[mutation]) forgetPersisted(queryCache, key)
  await Promise.allSettled(
    INVALIDATES[mutation].map((key) => queryCache.invalidateQueries({ key })),
  )
}
