// =============================================================================
// VELO Frontend -- Bookings Store (Phase F4.1, fixed F5 review)
// =============================================================================
//
// Pinia store for the current user's bookings. Uses usePagination
// composable for load-more pattern (same as practices store).
//
// F5 review fix:
//   W-25: cancelBooking returns { ok, error } instead of boolean,
//         so caller gets specific error message for toast.
// =============================================================================

import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import {
  getMyBookings,
  getUpcomingBookings,
  getBooking,
  cancelBooking as apiCancelBooking,
  joinBooking as apiJoinBooking,
  leaveBooking as apiLeaveBooking,
  skipCheckin as apiSkipCheckin,
} from '@/api/bookings'
import { usePagination } from '@/composables/usePagination'
import { ApiResponseError } from '@/api/client'
import i18n from '@/locales'

const { t } = i18n.global
import { extractApiError } from '@/composables/useApiError'
import { readPersisted, writePersisted } from '@/composables/persistedCache'
// One-way dependency: bookings -> diary. Used only inside actions, never at
// module scope or in the store's setup body -- keep it that way.
//
// W27 (PROMPT №438): this comment used to read «mirrors diary.ts using
// useBookingsStore(); avoids a top-level circular evaluation» -- true when
// written, false now. diary.ts no longer imports this store (its
// refreshBookings() call was redundant; the views already do it), so there is no
// cycle left to avoid and nothing to mirror.
import { useDiaryStore } from '@/stores/diary'
import type { BookingWithPracticeResponse, BookingDetailResponse, BookingStatus } from '@/api/types'

export interface CancelResult {
  ok: boolean
  error: string
}

/** Result of join/leave actions (same shape as CancelResult). */
export interface ActionResult {
  ok: boolean
  error: string
  /** HTTP status of an API failure, when one reached the store (FE-78.2:
   * callers key on this machine value, never on the human-readable text --
   * the only 409 on join is "already joined"). */
  status?: number
}

/** persistedCache slot of the dashboard's upcoming bookings. */
const UPCOMING_PERSIST = 'bookings.upcoming'

export const useBookingsStore = defineStore('bookings', () => {
  // -- Status filter --
  const statusFilter = ref<BookingStatus | undefined>(undefined)

  // -- Paginated list --
  const pagination = usePagination<BookingWithPracticeResponse>((limit, offset) =>
    getMyBookings(statusFilter.value, limit, offset),
  )

  // -- Live-or-upcoming set for the dashboard «Ближайшая практика» widget --
  // Separate from the paginated list: fetched from the dedicated
  // /bookings/me/upcoming endpoint (confirmed + not-ended, scheduled_at ASC) so
  // the nearest-selection is not capped/mis-sorted by the created_at page (B1).
  const upcoming = ref<BookingWithPracticeResponse[]>([])
  const upcomingLoading = ref(false)
  /** An answer is known (fetched, or restored from the last session) -- even
   * an EMPTY one. "Nothing upcoming" is data, not "not loaded yet": a screen
   * keys its skeleton on this, never on `upcoming.length === 0`. */
  const upcomingLoaded = ref(false)
  let upcomingInFlight: Promise<void> | null = null
  const upcomingError = ref('')

  // -- Single booking detail (screen 18) --
  const selectedBooking = ref<BookingDetailResponse | null>(null)
  const selectedLoading = ref(false)
  const selectedError = ref('')

  // Practices whose check-in the user SKIPPED this session — used to hide the
  // dashboard "Пора на check-in" banner immediately. Session-only: there is no
  // backend skip state yet (logged as a backend task), so it is lost on reload.
  const dismissedCheckins = ref<string[]>([])
  function dismissCheckin(practiceId: string): void {
    if (!dismissedCheckins.value.includes(practiceId)) {
      dismissedCheckins.value.push(practiceId)
    }
  }

  /**
   * Fetch a single booking with full practice details (screen 18).
   * Always refetches -- detail data (status, zoom) may change.
   */
  async function fetchBooking(bookingId: string): Promise<void> {
    selectedLoading.value = true
    selectedError.value = ''
    try {
      selectedBooking.value = await getBooking(bookingId)
    } catch (e) {
      selectedBooking.value = null
      selectedError.value = extractApiError(e, t('storeErrors.bookings.selected'))
    } finally {
      selectedLoading.value = false
    }
  }

  /**
   * Initial load. Called once from view onMounted.
   * Skips if already loaded (e.g. navigating back).
   */
  async function fetchMyBookings(): Promise<void> {
    if (pagination.items.value.length > 0) return
    await pagination.refresh()
  }

  /**
   * Load the live-or-upcoming set for the dashboard nearest widget.
   * Always refetches (cheap, bounded list; scheduled times shift with `now`).
   */
  /** One request at a time: the idle prefetch, the dock's finger-down warm
   * and the screen's own mount share it. */
  function fetchUpcoming(): Promise<void> {
    upcomingInFlight ??= loadUpcoming().finally(() => {
      upcomingInFlight = null
    })
    return upcomingInFlight
  }

  async function loadUpcoming(): Promise<void> {
    // First load after a (re)start: show the copy from the last session at
    // once (persistedCache), the request below replaces it silently.
    if (!upcomingLoaded.value) {
      const saved = readPersisted<BookingWithPracticeResponse[]>(UPCOMING_PERSIST)
      if (saved) {
        upcoming.value = saved.data
        upcomingLoaded.value = true
      }
    }
    upcomingLoading.value = true
    upcomingError.value = ''
    try {
      upcoming.value = await getUpcomingBookings()
      upcomingLoaded.value = true
      writePersisted(UPCOMING_PERSIST, upcoming.value)
    } catch (e) {
      // W15 fix (PROMPT №409): used to swallow the error entirely (empty array
      // looks identical to "genuinely nothing upcoming") -- record the error so
      // the caller can surface it. A failed REFRESH keeps the list already on
      // screen (a network blip must not empty the dashboard); a failed first
      // load stays the empty initial list, as before.
      upcomingError.value = extractApiError(e, t('storeErrors.bookings.upcoming'))
    } finally {
      upcomingLoading.value = false
    }
  }

  /**
   * Change status filter and reload from scratch.
   */
  function setStatusFilter(status: BookingStatus | undefined): void {
    statusFilter.value = status
  }

  // Auto-refresh when status filter changes.
  watch(statusFilter, () => {
    // Fire-and-forget: refresh manages its own loading/error state.
    void pagination.refresh()
  })

  /**
   * Cancel a booking by ID, then refresh the list.
   *
   * W-25: Returns { ok, error } with specific error message
   * instead of silent boolean. Caller shows toast with error detail.
   */
  async function cancelBooking(bookingId: string): Promise<CancelResult> {
    try {
      await apiCancelBooking(bookingId)
      // Refresh bookings list to reflect new status.
      await pagination.refreshInPlace()
      // A cancellation projects a "booking_cancelled_by_user" event onto the
      // diary timeline; refresh the feed (best-effort) so it shows up without
      // an app reload.
      void useDiaryStore().refreshFeed()
      return { ok: true, error: '' }
    } catch (e) {
      const message = extractApiError(e, t('storeErrors.bookings.cancel'))
      return { ok: false, error: message }
    }
  }

  /**
   * Check in to a practice (sets joined_at on the backend).
   * Refreshes the list so joined_at is reflected locally.
   * Returns { ok, error } -- caller decides how to surface errors
   * (e.g. 409 "Already joined" can be treated as a no-op success).
   */
  async function joinBooking(bookingId: string): Promise<ActionResult> {
    try {
      await apiJoinBooking(bookingId)
      await pagination.refreshInPlace()
      return { ok: true, error: '' }
    } catch (e) {
      const message = extractApiError(e, t('storeErrors.bookings.join'))
      return {
        ok: false,
        error: message,
        status: e instanceof ApiResponseError ? e.status : undefined,
      }
    }
  }

  /**
   * Check out from a practice (sets left_at on the backend).
   * Refreshes the list afterwards.
   */
  async function leaveBooking(bookingId: string): Promise<ActionResult> {
    try {
      await apiLeaveBooking(bookingId)
      await pagination.refreshInPlace()
      return { ok: true, error: '' }
    } catch (e) {
      const message = extractApiError(e, t('storeErrors.bookings.leave'))
      return { ok: false, error: message }
    }
  }

  /**
   * Persist the user's choice to skip their PRE check-in for a booking (B2).
   * Refreshes the list so the persisted `checkin_skipped` flag is reflected,
   * keeping the dashboard banner hidden across reloads (not just this session).
   */
  async function skipCheckin(bookingId: string): Promise<ActionResult> {
    try {
      await apiSkipCheckin(bookingId)
      await pagination.refreshInPlace()
      return { ok: true, error: '' }
    } catch (e) {
      const message = extractApiError(e, t('storeErrors.bookings.skipCheckin'))
      return { ok: false, error: message }
    }
  }

  return {
    // List
    bookings: pagination.items,
    total: pagination.total,
    loading: pagination.loading,
    error: pagination.error,
    loadMoreError: pagination.loadMoreError,
    hasMore: pagination.hasMore,
    fetchMyBookings,
    loadMore: pagination.loadMore,
    refreshBookings: pagination.refresh,
    // B30: like refreshBookings(), but never flashes the list empty -- for a
    // background freshness check on a screen that already shows data
    // (PracticeDetailView, MyBookingsView), so a practice that just ended
    // doesn't sit on a permanently-stale "counting attendance" badge.
    refreshMyBookings: pagination.refreshInPlace,

    // Live-or-upcoming set for the dashboard nearest widget (B1)
    upcoming,
    upcomingLoading,
    upcomingLoaded,
    upcomingError,
    fetchUpcoming,

    // Single booking detail (screen 18)
    selectedBooking,
    selectedLoading,
    selectedError,
    fetchBooking,

    // Filter
    statusFilter,
    setStatusFilter,

    // Actions
    cancelBooking,
    joinBooking,
    leaveBooking,
    skipCheckin,

    // Session-only check-in skip tracking
    dismissedCheckins,
    dismissCheckin,
  }
})
