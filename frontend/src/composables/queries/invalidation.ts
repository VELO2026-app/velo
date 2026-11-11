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
// stores and the in-house cache. Each mutation composable refreshes those
// holders next to its `invalidateAfter()` call, marked as legacy; a line
// leaves when its store moves to Colada and its key joins the row here.
// =============================================================================

import type { EntryKey, QueryCache } from '@pinia/colada'
import { keys } from '@/composables/queries/keys'

/** Each mutation and the query-key prefixes it makes stale. */
export const INVALIDATES = {
  /**
   * `DELETE /bookings/{id}`: the booking turns cancelled, and its practice
   * frees a seat and loses is_booked / is_paid -- in every list that shows it
   * (school feeds, the calendar week) and in its detail.
   */
  cancelBooking: [keys.bookings.root(), keys.practices.root()],
} as const satisfies Record<string, readonly EntryKey[]>

/** Name of a mutation that has a row in `INVALIDATES`. */
export type MutationName = keyof typeof INVALIDATES

/**
 * Mark every entry under the mutation's prefixes stale; the active ones refetch now.
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
  await Promise.allSettled(
    INVALIDATES[mutation].map((key) => queryCache.invalidateQueries({ key })),
  )
}
