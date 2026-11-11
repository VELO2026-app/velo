// =============================================================================
// VELO Frontend -- Bookings Store (Phase F4.1, fixed F5 review)
// =============================================================================
//
// Pinia store for the current user's bookings. Uses usePagination
// composable for load-more pattern (same as practices store).
//
// Cancelling a booking is a Pinia Colada mutation since FE-157 4F
// (composables/queries/bookings.ts, useCancelBooking): it refreshes this
// store's list and calls invalidateUpcoming() below.
// =============================================================================

import { defineStore } from 'pinia'
import { useQueryCache } from '@pinia/colada'
import { invalidateAfter } from '@/composables/queries/invalidation'
import { replaceEqualDeep } from '@/utils/structuralShare'
import { ref } from 'vue'
import {
  getMyBookings,
  getUpcomingBookings,
  getBooking,
  joinBooking as apiJoinBooking,
  skipCheckin as apiSkipCheckin,
} from '@/api/bookings'
import { usePagination } from '@/composables/usePagination'
import { ApiResponseError } from '@/api/client'
import i18n from '@/locales'

const { t } = i18n.global
import { extractApiError } from '@/composables/useApiError'
import { readPersisted, removePersisted, writePersisted } from '@/composables/persistedCache'
import type { BookingWithPracticeResponse, BookingDetailResponse, BookingStatus } from '@/api/types'

/** Result of join/skip-checkin actions: ok plus a user-facing error string. */
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

/** The user's bookings: paginated list, the dashboard's upcoming slice, join and skip-checkin actions. */
export const useBookingsStore = defineStore('bookings', () => {
  // Colada entries of the booking data go stale with each mutation below
  // (composables/queries/invalidation.ts holds the map).
  const queryCache = useQueryCache()
  // -- Status filter --
  const statusFilter = ref<BookingStatus | undefined>(undefined)

  // -- Paginated list --
  const pagination = usePagination<BookingWithPracticeResponse>((limit, offset) =>
    getMyBookings(statusFilter.value, limit, offset),
  )

  // -- Live-or-upcoming set for the dashboard's nearest-practices widget
  // (i18n:user.screens.userDashboard.sections.upcoming) --
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
  /** When the list was last answered by the server (0 = never / restored). */
  let upcomingAt = 0
  /** Bumped by $reset and invalidateUpcoming: an in-flight answer belongs to
   * the previous account, or predates a change, and is dropped when it lands
   * (usePagination's requestId, W17). */
  let upcomingGeneration = 0
  const upcomingError = ref('')

  // -- Single booking detail (screen 18) --
  const selectedBooking = ref<BookingDetailResponse | null>(null)
  const selectedLoading = ref(false)
  const selectedError = ref('')

  // Practices whose check-in the user SKIPPED this session — used to hide the
  // dashboard check-in banner (i18n:user.screens.userDashboard.checkinBanner.title)
  // immediately. Session-only: there is no
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
  function fetchUpcoming({ maxAgeMs = 0 }: { maxAgeMs?: number } = {}): Promise<void> {
    // Fresh enough (e.g. the first-screen gate loaded it a moment ago): the
    // screen's own mount does not ask again.
    if (upcomingInFlight === null && upcomingAt > 0 && Date.now() - upcomingAt < maxAgeMs) {
      return Promise.resolve()
    }
    if (upcomingInFlight !== null) return upcomingInFlight
    const p = loadUpcoming().finally(() => {
      // Only our own slot: a request superseded by invalidateUpcoming settles
      // AFTER its successor started, and must not orphan it (the next caller
      // would fire a duplicate GET instead of joining).
      if (upcomingInFlight === p) upcomingInFlight = null
    })
    upcomingInFlight = p
    return p
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
    const generation = upcomingGeneration
    try {
      // Structural sharing: an unchanged answer is a no-op for the screen.
      const fresh = await getUpcomingBookings()
      if (generation !== upcomingGeneration) return // superseded by $reset
      upcoming.value = replaceEqualDeep(upcoming.value, fresh)
      upcomingAt = Date.now()
      upcomingLoaded.value = true
      writePersisted(UPCOMING_PERSIST, upcoming.value)
    } catch (e) {
      // W15 fix (PROMPT №409): used to swallow the error entirely (empty array
      // looks identical to "genuinely nothing upcoming") -- record the error so
      // the caller can surface it. A failed REFRESH keeps the list already on
      // screen (a network blip must not empty the dashboard); a failed first
      // load stays the empty initial list, as before.
      if (generation !== upcomingGeneration) return // superseded by $reset
      upcomingError.value = extractApiError(e, t('storeErrors.bookings.upcoming'))
    } finally {
      if (generation === upcomingGeneration) upcomingLoading.value = false
    }
  }

  /**
   * Change status filter and reload from scratch.
   *
   * @remarks The reload lives HERE, not in a watcher on statusFilter: $reset
   * clears the filter at the end of a session, and a watcher would then fire
   * an anonymous GET whose 401 lands in the freshly reset store (FE-157).
   */
  function setStatusFilter(status: BookingStatus | undefined): void {
    if (statusFilter.value === status) return
    statusFilter.value = status
    // Fire-and-forget: refresh manages its own loading/error state.
    void pagination.refresh()
  }

  /**
   * A booking of this user changed on the server (cancelled -- see
   * useCancelBooking): the upcoming list no longer holds.
   *
   * @remarks An answer still in flight predates the change and is dropped; a
   * list already known (on the dashboard, or restored from the last session)
   * reloads now, so a return to the dashboard does not show the cancelled
   * booking. A list never loaded is left for its first reader -- but its copy
   * saved from the last session is dropped, so that reader does not flash the
   * cancelled booking before its own request answers.
   */
  function invalidateUpcoming(): void {
    upcomingAt = 0
    if (!upcomingLoaded.value && upcomingInFlight === null) {
      removePersisted(UPCOMING_PERSIST)
      return
    }
    upcomingGeneration += 1
    upcomingInFlight = null
    void fetchUpcoming()
  }

  /**
   * Check in to a practice (sets joined_at on the backend).
   * Refreshes the list so joined_at is reflected locally.
   *
   * @returns `{ ok, error }` -- caller decides how to surface errors
   *   (e.g. 409 "Already joined" can be treated as a no-op success).
   */
  async function joinBooking(bookingId: string): Promise<ActionResult> {
    try {
      await apiJoinBooking(bookingId)
      void invalidateAfter(queryCache, 'joinBooking')
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
   * Persist the user's choice to skip their PRE check-in for a booking (B2).
   * Refreshes the list so the persisted `checkin_skipped` flag is reflected,
   * keeping the dashboard banner hidden across reloads (not just this session).
   */
  async function skipCheckin(bookingId: string): Promise<ActionResult> {
    try {
      await apiSkipCheckin(bookingId)
      void invalidateAfter(queryCache, 'skipCheckin')
      await pagination.refreshInPlace()
      return { ok: true, error: '' }
    } catch (e) {
      const message = extractApiError(e, t('storeErrors.bookings.skipCheckin'))
      return { ok: false, error: message }
    }
  }

  // =========================================================================
  // Reset (on the account boundary -- W-1, same reasoning as master.ts)
  // =========================================================================

  /** A different account in the same tab starts fresh: the upcoming list,
   * its freshness marker and the detail slot are the previous account's data
   * (auth._clearSession calls this alongside queryCache/clearPersisted). */
  function $reset(): void {
    upcomingGeneration += 1
    upcomingInFlight = null
    upcomingAt = 0
    upcoming.value = []
    upcomingLoading.value = false
    upcomingLoaded.value = false
    upcomingError.value = ''
    selectedBooking.value = null
    selectedLoading.value = false
    selectedError.value = ''
    dismissedCheckins.value = []
    statusFilter.value = undefined
    pagination.reset()
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
    invalidateUpcoming,
    $reset,

    // Single booking detail (screen 18)
    selectedBooking,
    selectedLoading,
    selectedError,
    fetchBooking,

    // Filter
    statusFilter,
    setStatusFilter,

    // Actions
    joinBooking,
    skipCheckin,

    // Session-only check-in skip tracking
    dismissedCheckins,
    dismissCheckin,
  }
})
