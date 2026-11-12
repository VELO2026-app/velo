// =============================================================================
// VELO Frontend -- the user's bookings on Pinia Colada (FE-157 4F, FE-166)
// =============================================================================
//
// Queries (FE-166 step 3): the bookings list, page by page
// (`useMyBookings`), and the dashboard's upcoming slice
// (`upcomingBookingsQuery`). The bookings store keeps only client state (the
// check-ins skipped this session).
//
// Mutations: cancel (the pilot), purchase and waitlist confirmation (step 1),
// join and skip check-in (step 3). The diary's submits (check-in, feedback,
// reflection) live in the diary store and call `invalidateAfter()` there;
// every row is in ./invalidation.ts. A booking made or cancelled is an event
// on the diary timeline too: its first page is reloaded through
// `diaryFeedChanged()` (./diary.ts) -- not an invalidation, which would
// refetch every page the reader scrolled through.
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

import { computed } from 'vue'
import {
  defineInfiniteQueryOptions,
  defineQueryOptions,
  useInfiniteQuery,
  useMutation,
  useQueryCache,
} from '@pinia/colada'
import {
  cancelBooking,
  createBooking,
  getMyBookings,
  getUpcomingBookings,
  joinBooking,
  purchasePractice,
  skipCheckin,
} from '@/api/bookings'
import { confirmWaitlist } from '@/api/waitlist'
import { diaryFeedChanged } from '@/composables/queries/diary'
import { invalidateAfter } from '@/composables/queries/invalidation'
import { keys } from '@/composables/queries/keys'
import { screenQueryState } from '@/composables/queries/screenState'
import { useQueryScopeStore } from '@/composables/queries/setup'
import { useBalanceStore } from '@/stores/balance'
import { useDiaryStore } from '@/stores/diary'
import { usePracticesStore } from '@/stores/practices'

// =============================================================================
// Queries
// =============================================================================

/** Bookings per page of `GET /bookings/me`. */
export const BOOKINGS_PAGE_SIZE = 20

/**
 * An upcoming list answered this recently is not asked for again: the
 * first-screen gate, the idle prefetch and the dashboard's mount share it.
 */
export const UPCOMING_STALE_MS = 10_000

/**
 * Infinite query options for every booking of mine (`GET /bookings/me`, no
 * status filter), newest booked first, BOOKINGS_PAGE_SIZE per page.
 *
 * @remarks
 * Window focus refetches it: a booking's status moves outside this app (the
 * attendance report turns `confirmed` into `attended` / `no_show` after the
 * practice), and the screens show that verdict. A refetch reloads every page
 * loaded so far (Colada infinite queries) -- usually one.
 */
export const myBookingsQuery = defineInfiniteQueryOptions(() => ({
  key: keys.bookings.list(),
  query: ({ pageParam }: { pageParam: number }) =>
    getMyBookings(undefined, BOOKINGS_PAGE_SIZE, pageParam),
  initialPageParam: 0,
  getNextPageParam: (last: Awaited<ReturnType<typeof getMyBookings>>) => {
    const next = last.offset + last.items.length
    return next < last.total ? next : null
  },
  refetchOnWindowFocus: true,
}))

/**
 * The bookings list for a screen: the loaded bookings flattened, and its
 * loading / error state (queries/screenState.ts).
 *
 * @remarks
 * `error` is the raw error of the last request (ADR: the screen turns it into
 * text); `failed` is true only when there is nothing to show. `loadMore()`
 * rejects with the error of a failed next page and keeps the list.
 */
export function useMyBookings() {
  const query = useInfiniteQuery(() => myBookingsQuery())
  const bookings = computed(() => query.data.value?.pages.flatMap((page) => page.items) ?? [])
  const { loading, failed } = screenQueryState(query)
  return {
    bookings,
    /** The first page has answered (with the list, or an error): a gate keyed on the list may decide. */
    settled: computed(() => query.status.value !== 'pending'),
    loading,
    failed,
    error: query.error,
    /** Any request of the list in flight (first page, next page, refetch). */
    fetching: computed(() => query.asyncStatus.value === 'loading'),
    hasMore: query.hasNextPage,
    loadMore: () => query.loadNextPage({ throwOnError: true }),
    /** Refetch now, keeping the list on screen (a status may have moved with time). */
    refetch: () => query.refetch(),
  }
}

/**
 * Query options for the dashboard's live-or-upcoming bookings
 * (`GET /bookings/me/upcoming`). Persisted: a reload paints the last known
 * list at once, then revalidates.
 *
 * @remarks
 * Window focus refetches it: the list is cut by the clock (a practice that
 * ended drops out) and its flags move with the user's own actions elsewhere.
 */
export const upcomingBookingsQuery = defineQueryOptions(() => ({
  key: keys.bookings.upcoming(),
  query: () => getUpcomingBookings(),
  staleTime: UPCOMING_STALE_MS,
  refetchOnWindowFocus: true,
  meta: { persist: true },
}))

// =============================================================================
// Mutations
// =============================================================================

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
 * cancelled AND the bookings on screen were refetched (the invalidation
 * awaits the active entries) -- the screen's cancel control is derived from
 * the bookings list, so it is gone by then and cannot be tapped twice. It
 * rejects with the API error; nothing is refreshed then (a failed DELETE
 * changed nothing on the server).
 *
 * Refreshed on success: the Colada keys of `INVALIDATES.cancelBooking`, plus,
 * until their stores move to Colada, the legacy holders below. That includes
 * the balance: a cancellation can refund the booking, and the balance is the
 * auth profile (`GET /users/me`), so it is re-read at once (balance store).
 */
export function useCancelBooking() {
  const queryCache = useQueryCache()
  const scope = useQueryScopeStore()
  // The filters the diary screen reads with: that feed is kept and reloaded.
  const diary = useDiaryStore()
  const practices = usePracticesStore()
  const balance = useBalanceStore()

  /** Legacy holders of the same server data (each line leaves with its store's migration). */
  function refreshLegacyHolders(practiceId: string): void {
    // The practice on screen (PracticeDetailView) -- refreshed quietly, it is
    // already shown. Its cache entry is a Colada key (practices.root()).
    if (practices.selected?.id === practiceId) void practices.fetchPractice(practiceId)
    // The calendar week is a Colada key (practices.root(), FE-166 step 4).
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
      // The cancellation projects a "booking_cancelled_by_user" event onto
      // the diary timeline.
      void diaryFeedChanged(queryCache, diary.feedFilters)
      await invalidateAfter(queryCache, 'cancelBooking')
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
  // The filters the diary screen reads with: that feed is kept and reloaded.
  const diary = useDiaryStore()
  return useMutation({
    onMutate: () => ({ sessionGeneration: scope.generation() }),
    // Resolves with nothing: the two endpoints answer different shapes, and
    // every reader of the new booking reads it from the refreshed holders.
    async mutation({ practiceId, promoCode, viaPurchase }: PurchaseBookingVars): Promise<void> {
      if (viaPurchase) await purchasePractice(practiceId, promoCode)
      else await createBooking(practiceId)
    },
    onSuccess(_data, _vars, { sessionGeneration }) {
      if (sessionGeneration !== scope.generation()) return
      void invalidateAfter(queryCache, 'purchaseBooking')
      // The booking projects a "booking_confirmed" event onto the diary
      // timeline. Not awaited: the screen's toast and navigation do not wait
      // for it (the popup's double tap is closed by its own flag).
      void diaryFeedChanged(queryCache, diary.feedFilters)
    },
  })
}

/** Variables of the waitlist-confirmation mutation. */
export interface ConfirmWaitlistVars {
  waitlistId: string
}

/**
 * Mutation that confirms a notified waitlist spot, which becomes a booking.
 * Rejects with the raw API error (400 expired / taken, 404 not mine).
 *
 * @remarks
 * The confirmation charges the balance (the backend creates the purchase for
 * the booking), so the profile is re-read too, as after a cancellation.
 */
export function useConfirmWaitlist() {
  const queryCache = useQueryCache()
  const scope = useQueryScopeStore()
  // The filters the diary screen reads with: that feed is kept and reloaded.
  const diary = useDiaryStore()
  const balance = useBalanceStore()
  return useMutation({
    onMutate: () => ({ sessionGeneration: scope.generation() }),
    mutation: ({ waitlistId }: ConfirmWaitlistVars) => confirmWaitlist(waitlistId),
    onSuccess(_data, _vars, { sessionGeneration }) {
      if (sessionGeneration !== scope.generation()) return
      void invalidateAfter(queryCache, 'confirmWaitlist')
      void diaryFeedChanged(queryCache, diary.feedFilters) // a booking now: see usePurchaseBooking
      void balance.refresh()
    },
  })
}

/**
 * Mutation that checks the user in to a practice (`POST /bookings/{id}/join`,
 * sets `joined_at`). Rejects with the raw API error -- a 409 means "already
 * joined", which the screen treats as success.
 */
export function useJoinBooking() {
  return useBookingFlagMutation('joinBooking', joinBooking)
}

/**
 * Mutation that persists the user's choice to skip the PRE check-in
 * (`POST /bookings/{id}/skip-checkin`, sets `checkin_skipped`, B2).
 * Rejects with the raw API error.
 */
export function useSkipCheckin() {
  return useBookingFlagMutation('skipCheckin', skipCheckin)
}

/** A mutation that flips one flag of a booking: the booking keys go stale on success. */
function useBookingFlagMutation(
  name: 'joinBooking' | 'skipCheckin',
  call: (bookingId: string) => Promise<unknown>,
) {
  const queryCache = useQueryCache()
  const scope = useQueryScopeStore()
  return useMutation({
    onMutate: () => ({ sessionGeneration: scope.generation() }),
    mutation: (bookingId: string) => call(bookingId),
    onSuccess(_data, _bookingId, { sessionGeneration }) {
      if (sessionGeneration !== scope.generation()) return
      void invalidateAfter(queryCache, name)
    },
  })
}
