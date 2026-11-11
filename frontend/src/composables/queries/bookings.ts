// =============================================================================
// VELO Frontend -- booking mutations for Pinia Colada (FE-157 4F, FE-166)
// =============================================================================
//
// Screen-level booking mutations: cancel (the pilot), purchase and waitlist
// confirmation (FE-166 step 1). The mutations that live in store actions
// (join, skip check-in, check-in, feedback, reflection) call
// `invalidateAfter()` from the store; their rows are in ./invalidation.ts too.
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
import { cancelBooking, createBooking, purchasePractice } from '@/api/bookings'
import { confirmWaitlist } from '@/api/waitlist'
import { invalidateAfter } from '@/composables/queries/invalidation'
import { useQueryScopeStore } from '@/composables/queries/setup'
import { queryCache as legacyQueryCache } from '@/composables/useQuery'
import { queryKeys as legacyKeys } from '@/composables/queryKeys'
import { useBalanceStore } from '@/stores/balance'
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
 * until their stores move to Colada, the legacy holders below. That includes
 * the balance: a cancellation can refund the booking, and the balance is the
 * auth profile (`GET /users/me`), so it is re-read at once (balance store).
 */
export function useCancelBooking() {
  const queryCache = useQueryCache()
  const scope = useQueryScopeStore()
  const bookings = useBookingsStore()
  const practices = usePracticesStore()
  const calendar = useCalendarStore()
  const diary = useDiaryStore()
  const balance = useBalanceStore()

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
    // The refund (if the cancellation earned one) changed the balance, which
    // is the auth profile. fetchMe() never rejects and drops an answer that
    // lands after the session changed.
    void balance.refresh()
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

/** Variables of the purchase mutation: the practice, and the promo code when one is applied. */
export interface PurchaseBookingVars {
  practiceId: string
  promoCode?: string
  /** `false` when the instance has the payments option off: book through `POST /bookings` (FE-151). */
  viaPurchase: boolean
}

/**
 * Refresh the legacy holders of one practice's data after a booking appeared
 * (purchase, waitlist confirmation): the dashboard's upcoming list, the
 * practice detail (cache entry and the one on screen), the calendar week and
 * the bookings list. Each line leaves with its store's migration.
 */
function refreshPracticeHolders(practiceId: string): Promise<void> {
  const bookings = useBookingsStore()
  const practices = usePracticesStore()
  const calendar = useCalendarStore()
  bookings.invalidateUpcoming()
  legacyQueryCache.invalidate(legacyKeys.practice(practiceId))
  if (practices.selected?.id === practiceId) void practices.fetchPractice(practiceId)
  if (calendar.weekPractices.some((p) => p.id === practiceId)) void calendar.loadWeek(true)
  return bookings.refreshMyBookings()
}

/**
 * Mutation that books a practice (purchase, or plain booking when payments
 * are off) and refreshes everything that showed its seats.
 *
 * @remarks
 * Rejects with the raw API error (the popup maps `practice_full`, 409 and the
 * rest); nothing is refreshed then. The balance is NOT refreshed here: the
 * popup re-reads it after success and failure alike (a concurrent operation
 * may have changed it).
 */
export function usePurchaseBooking() {
  const queryCache = useQueryCache()
  const scope = useQueryScopeStore()
  return useMutation({
    onMutate: () => ({ sessionGeneration: scope.generation() }),
    // Resolves with nothing: the two endpoints answer different shapes, and
    // every reader of the new booking reads it from the refreshed holders.
    async mutation({ practiceId, promoCode, viaPurchase }: PurchaseBookingVars): Promise<void> {
      if (viaPurchase) await purchasePractice(practiceId, promoCode)
      else await createBooking(practiceId)
    },
    async onSuccess(_data, { practiceId }, { sessionGeneration }) {
      if (sessionGeneration !== scope.generation()) return
      void invalidateAfter(queryCache, 'purchaseBooking')
      await refreshPracticeHolders(practiceId)
    },
  })
}

/** Variables of the waitlist-confirmation mutation. */
export interface ConfirmWaitlistVars {
  waitlistId: string
  practiceId: string
}

/**
 * Mutation that confirms a notified waitlist spot, which becomes a booking.
 * Rejects with the raw API error (400 expired / taken, 404 not mine).
 */
export function useConfirmWaitlist() {
  const queryCache = useQueryCache()
  const scope = useQueryScopeStore()
  return useMutation({
    onMutate: () => ({ sessionGeneration: scope.generation() }),
    mutation: ({ waitlistId }: ConfirmWaitlistVars) => confirmWaitlist(waitlistId),
    async onSuccess(_data, { practiceId }, { sessionGeneration }) {
      if (sessionGeneration !== scope.generation()) return
      void invalidateAfter(queryCache, 'confirmWaitlist')
      await refreshPracticeHolders(practiceId)
    },
  })
}
