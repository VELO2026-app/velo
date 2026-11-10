// =============================================================================
// VELO Frontend -- booking mutations for Pinia Colada (FE-157 4F pilot)
// =============================================================================
//
// Cancel a booking: the first mutation on Colada. Before the pilot the
// bookings store cancelled and refreshed only its own list, so the dashboard's
// upcoming list, the practice's seats and the calendar week kept showing the
// cancelled booking until something else reloaded them.
//
// Error convention (the one ADR rule for every Colada screen): the mutation
// rejects with the raw error -- `ApiResponseError` or a network failure -- and
// the SCREEN turns it into text with `extractApiError(e, fallback)` where it
// shows it. Nothing here returns `{ ok, error }` or a translated string.
// =============================================================================

import { useMutation, useQueryCache } from '@pinia/colada'
import { cancelBooking } from '@/api/bookings'
import { invalidateAfter } from '@/composables/queries/invalidation'
import { useQueryScopeStore } from '@/composables/queries/setup'
import { queryCache as legacyQueryCache } from '@/composables/useQuery'
import { queryKeys as legacyKeys } from '@/composables/queryKeys'
import { useBookingsStore } from '@/stores/bookings'
import { useCalendarStore } from '@/stores/calendar'
import { useDiaryStore } from '@/stores/diary'
import { usePracticesStore } from '@/stores/practices'

/** Variables of the cancel-booking mutation: the booking, and the practice it holds a seat in. */
export interface CancelBookingVars {
  bookingId: string
  practiceId: string
}

/**
 * Mutation that cancels one of the user's bookings and refreshes everything
 * that showed it.
 *
 * @remarks
 * Call in a component's setup. `mutateAsync(vars)` resolves once the server
 * cancelled AND the bookings list holds the new status -- the screen's cancel
 * control is derived from that list, so it is gone by then and cannot be
 * tapped twice. It rejects with the API error; nothing is refreshed then (a
 * failed DELETE changed nothing on the server).
 *
 * Refreshed on success: the Colada keys of `INVALIDATES.cancelBooking`, plus,
 * until their stores move to Colada, the legacy holders below. The balance
 * (refund) is not: it is the auth profile, which its readers refresh on use
 * (the booking popup) and the role-freshness poll re-reads.
 */
export function useCancelBooking() {
  const queryCache = useQueryCache()
  const scope = useQueryScopeStore()
  const bookings = useBookingsStore()
  const practices = usePracticesStore()
  const calendar = useCalendarStore()
  const diary = useDiaryStore()

  /** Legacy holders of the same server data (each line leaves with its store's migration). */
  function refreshLegacyHolders(practiceId: string): void {
    // The dashboard's upcoming list (also its persisted copy).
    bookings.invalidateUpcoming()
    // The practice detail: the in-house cache entry, and the practice on
    // screen (PracticeDetailView) -- refreshed quietly, it is already shown.
    legacyQueryCache.invalidate(legacyKeys.practice(practiceId))
    if (practices.selected?.id === practiceId) void practices.fetchPractice(practiceId)
    // The calendar week, when it shows this practice (quiet reload).
    if (calendar.weekPractices.some((p) => p.id === practiceId)) void calendar.loadWeek(true)
    // The cancellation projects a "booking_cancelled_by_user" event onto the
    // diary timeline.
    void diary.refreshFeed()
  }

  return useMutation({
    // The session the cancel was started in (queries/setup.ts, useQueryScopeStore).
    onMutate: () => ({ sessionGeneration: scope.generation() }),
    mutation: ({ bookingId }: CancelBookingVars) => cancelBooking(bookingId),
    async onSuccess(_data, { practiceId }, { sessionGeneration }) {
      // The session ended while the DELETE was in flight (logout, a 401):
      // the stores and caches are already reset, and a refresh now would
      // load the next session's data on this session's behalf.
      if (sessionGeneration !== scope.generation()) return
      refreshLegacyHolders(practiceId)
      void invalidateAfter(queryCache, 'cancelBooking')
      await bookings.refreshMyBookings()
    },
  })
}
