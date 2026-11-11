// =============================================================================
// VELO Frontend -- stores/bookings.ts Unit Tests (T1 stage 2 -- harness + stores)
// =============================================================================
//
// Covers the money-adjacent actions joinBooking and skipCheckin, the
// upcoming list and its invalidation. Cancelling moved to a Pinia Colada
// mutation (FE-157 4F): composables/queries/bookings.test.ts covers it.
// Mocked at the wrapper layer (@/api/bookings) -- the store imports named
// functions directly, so this is the correct seam (no MSW needed).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useBookingsStore } from '@/stores/bookings'
import { ApiResponseError } from '@/api/client'
import { readPersisted, setPersistOwner, writePersisted } from '@/composables/persistedCache'
import * as bookingsApi from '@/api/bookings'
import type { BookingResponse } from '@/api/types'

vi.mock('@/api/bookings')

// The Colada side of each mutation (FE-166 step 1): which keys a row covers
// is composables/queries/invalidation.test.ts's business; here, that the
// action names its row on success and only then.
const invalidateAfter = vi.hoisted(() => vi.fn())
vi.mock('@/composables/queries/invalidation', () => ({ invalidateAfter }))

function emptyPage() {
  return { items: [], total: 0, limit: 20, offset: 0 }
}

describe('useBookingsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(bookingsApi.getMyBookings).mockReset().mockResolvedValue(emptyPage())
    invalidateAfter.mockReset().mockResolvedValue(undefined)
    vi.mocked(bookingsApi.joinBooking).mockReset()
    vi.mocked(bookingsApi.skipCheckin).mockReset()
  })

  describe('fetchUpcoming', () => {
    it('a failed refresh keeps the list already on screen and records the error', async () => {
      const store = useBookingsStore()
      const shown = [{ id: 'b1' }] as unknown as Awaited<
        ReturnType<typeof bookingsApi.getUpcomingBookings>
      >
      vi.mocked(bookingsApi.getUpcomingBookings).mockResolvedValueOnce(shown)
      await store.fetchUpcoming()
      expect(store.upcoming).toEqual(shown)

      vi.mocked(bookingsApi.getUpcomingBookings).mockRejectedValueOnce(new Error('offline'))
      await store.fetchUpcoming()

      expect(store.upcoming).toEqual(shown)
      expect(store.upcomingError).not.toBe('')
      expect(store.upcomingLoading).toBe(false)
    })
  })

  describe('fetchUpcoming -- an answer is known', () => {
    it('an EMPTY answer counts as loaded (the screen shows no skeleton for it)', async () => {
      const store = useBookingsStore()
      vi.mocked(bookingsApi.getUpcomingBookings).mockResolvedValueOnce([])
      expect(store.upcomingLoaded).toBe(false)
      await store.fetchUpcoming()
      expect(store.upcoming).toEqual([])
      expect(store.upcomingLoaded).toBe(true)
    })

    it('concurrent callers (prefetch, finger-down, mount) share one request', async () => {
      const store = useBookingsStore()
      vi.mocked(bookingsApi.getUpcomingBookings).mockClear().mockResolvedValue([])
      await Promise.all([store.fetchUpcoming(), store.fetchUpcoming(), store.fetchUpcoming()])
      expect(bookingsApi.getUpcomingBookings).toHaveBeenCalledTimes(1)
      await store.fetchUpcoming()
      expect(bookingsApi.getUpcomingBookings).toHaveBeenCalledTimes(2)
    })
  })

  describe('$reset (account boundary, W-1)', () => {
    const shown = [{ id: 'b1' }] as unknown as Awaited<
      ReturnType<typeof bookingsApi.getUpcomingBookings>
    >

    it('takes the freshness marker with it: the next ask fetches again', async () => {
      const store = useBookingsStore()
      vi.mocked(bookingsApi.getUpcomingBookings).mockResolvedValueOnce(shown)
      await store.fetchUpcoming()
      expect(store.upcoming).toEqual(shown)

      // Within the freshness window a re-ask is skipped (the first-screen
      // gate already loaded it)...
      vi.mocked(bookingsApi.getUpcomingBookings).mockClear()
      await store.fetchUpcoming({ maxAgeMs: 10_000 })
      expect(bookingsApi.getUpcomingBookings).not.toHaveBeenCalled()

      // ...and the reset must take that skip with it, or the NEXT account's
      // first dashboard mount would be served THIS account's list.
      store.$reset()
      expect(store.upcoming).toEqual([])
      expect(store.upcomingLoaded).toBe(false)

      vi.mocked(bookingsApi.getUpcomingBookings).mockResolvedValueOnce([])
      await store.fetchUpcoming({ maxAgeMs: 10_000 })
      expect(bookingsApi.getUpcomingBookings).toHaveBeenCalledTimes(1)
    })

    it('an in-flight answer landing after $reset does not repopulate the list', async () => {
      let resolveFetch!: (
        value: Awaited<ReturnType<typeof bookingsApi.getUpcomingBookings>>,
      ) => void
      vi.mocked(bookingsApi.getUpcomingBookings).mockReturnValue(
        new Promise<Awaited<ReturnType<typeof bookingsApi.getUpcomingBookings>>>((resolve) => {
          resolveFetch = resolve
        }),
      )
      const store = useBookingsStore()
      const pending = store.fetchUpcoming()
      store.$reset()
      resolveFetch(shown)
      await pending
      expect(store.upcoming).toEqual([])
      expect(store.upcomingLoaded).toBe(false)
    })
  })

  describe('invalidateUpcoming (a booking changed, FE-157 4F)', () => {
    type Upcoming = Awaited<ReturnType<typeof bookingsApi.getUpcomingBookings>>
    const before = [{ id: 'b1' }, { id: 'b2' }] as unknown as Upcoming
    const after = [{ id: 'b2' }] as unknown as Upcoming

    beforeEach(() => {
      vi.mocked(bookingsApi.getUpcomingBookings).mockReset()
    })

    it('a known list reloads at once, and the freshness skip goes with it', async () => {
      const store = useBookingsStore()
      vi.mocked(bookingsApi.getUpcomingBookings).mockResolvedValueOnce(before)
      await store.fetchUpcoming()

      vi.mocked(bookingsApi.getUpcomingBookings).mockClear().mockResolvedValue(after)
      store.invalidateUpcoming()
      await vi.waitFor(() => expect(store.upcoming).toEqual(after))
      expect(bookingsApi.getUpcomingBookings).toHaveBeenCalledTimes(1)

      // The dashboard's mount inside the freshness window asks again only
      // because the reload above answered -- not because the skip survived.
      await store.fetchUpcoming({ maxAgeMs: 10_000 })
      expect(bookingsApi.getUpcomingBookings).toHaveBeenCalledTimes(1)
    })

    it('an answer in flight from before the change is dropped', async () => {
      let resolveOld!: (value: Upcoming) => void
      vi.mocked(bookingsApi.getUpcomingBookings)
        .mockReturnValueOnce(
          new Promise<Upcoming>((resolve) => {
            resolveOld = resolve
          }),
        )
        .mockResolvedValueOnce(after)
      const store = useBookingsStore()
      const old = store.fetchUpcoming()

      store.invalidateUpcoming()
      await vi.waitFor(() => expect(store.upcoming).toEqual(after))
      resolveOld(before)
      await old

      expect(store.upcoming).toEqual(after)
      expect(store.upcomingLoading).toBe(false)
    })

    it('a list never loaded is left for its first reader', () => {
      const store = useBookingsStore()
      store.invalidateUpcoming()
      expect(bookingsApi.getUpcomingBookings).not.toHaveBeenCalled()
    })

    it("a list never loaded drops the last session's saved copy: its first reader does not flash it", async () => {
      setPersistOwner('u-invalidate')
      writePersisted('bookings.upcoming', before)
      const store = useBookingsStore()

      store.invalidateUpcoming()
      expect(readPersisted('bookings.upcoming')).toBeUndefined()

      let resolveFirst!: (value: Upcoming) => void
      vi.mocked(bookingsApi.getUpcomingBookings).mockReturnValueOnce(
        new Promise<Upcoming>((resolve) => {
          resolveFirst = resolve
        }),
      )
      const first = store.fetchUpcoming()
      // While the first request is in flight nothing stale is on screen.
      expect(store.upcoming).toEqual([])
      expect(store.upcomingLoaded).toBe(false)
      resolveFirst(after)
      await first
      expect(store.upcoming).toEqual(after)
      setPersistOwner(null)
    })

    it('the superseded request settling late does not orphan its successor (no duplicate GET)', async () => {
      let resolveOld!: (value: Upcoming) => void
      let resolveNew!: (value: Upcoming) => void
      vi.mocked(bookingsApi.getUpcomingBookings)
        .mockReturnValueOnce(
          new Promise<Upcoming>((resolve) => {
            resolveOld = resolve
          }),
        )
        .mockReturnValueOnce(
          new Promise<Upcoming>((resolve) => {
            resolveNew = resolve
          }),
        )
        .mockResolvedValue(after)
      const store = useBookingsStore()
      const old = store.fetchUpcoming()
      store.invalidateUpcoming() // starts the successor

      resolveOld(before)
      await old
      // The successor is still in flight: a new reader joins it.
      void store.fetchUpcoming()
      expect(bookingsApi.getUpcomingBookings).toHaveBeenCalledTimes(2)

      resolveNew(after)
      await vi.waitFor(() => expect(store.upcoming).toEqual(after))
    })
  })

  describe('joinBooking', () => {
    it('on success: calls the API and refreshes the list', async () => {
      vi.mocked(bookingsApi.joinBooking).mockResolvedValue({
        id: 'booking_1',
      } as BookingResponse)
      const store = useBookingsStore()

      const result = await store.joinBooking('booking_1')

      expect(result).toEqual({ ok: true, error: '' })
      expect(bookingsApi.joinBooking).toHaveBeenCalledWith('booking_1')
      expect(bookingsApi.getMyBookings).toHaveBeenCalled()
      expect(invalidateAfter).toHaveBeenCalledWith(expect.anything(), 'joinBooking')
    })

    it('on failure (e.g. 409 already joined): falls back to the generic message and carries the machine status (FE-78.2)', async () => {
      // B8 (PROMPT №747): 'already_joined' is not a real backend code --
      // unmapped, lands on the call site's own fallback (bookings.ts:202).
      // FE-78.2: the result also carries the HTTP status, so a caller can
      // branch on it (the join endpoint's only 409 IS "already joined")
      // instead of matching the human-readable text.
      vi.mocked(bookingsApi.joinBooking).mockRejectedValue(
        new ApiResponseError(409, 'Already joined', 'already_joined'),
      )
      const store = useBookingsStore()

      const result = await store.joinBooking('booking_1')

      expect(result).toEqual({
        ok: false,
        error: 'Не удалось войти в практику',
        status: 409,
      })
      expect(invalidateAfter).not.toHaveBeenCalled()
    })
  })

  // FE-49 (product decision 2026-11-02): the leave button is removed from
  // the UI wholesale, the store action leaveBooking is deleted;
  // api/bookings.ts::leaveBooking stays with a comment (the backend
  // endpoint is alive, the UI no longer calls it).

  describe('skipCheckin', () => {
    it('on success: calls the API and refreshes the list', async () => {
      vi.mocked(bookingsApi.skipCheckin).mockResolvedValue({
        id: 'booking_1',
      } as BookingResponse)
      const store = useBookingsStore()

      const result = await store.skipCheckin('booking_1')

      expect(result).toEqual({ ok: true, error: '' })
      expect(bookingsApi.skipCheckin).toHaveBeenCalledWith('booking_1')
      expect(invalidateAfter).toHaveBeenCalledWith(expect.anything(), 'skipCheckin')
    })

    it('on failure: returns the mapped table phrase for a real backend code', async () => {
      // B8 (PROMPT №747): 'not_found' IS a real backend code (VeloError base
      // default, errorMessages.ts) -- extractApiError now returns its table
      // phrase regardless of the mocked detail text.
      vi.mocked(bookingsApi.skipCheckin).mockRejectedValue(
        new ApiResponseError(404, 'Booking not found', 'not_found'),
      )
      const store = useBookingsStore()

      const result = await store.skipCheckin('booking_1')

      expect(result).toEqual({ ok: false, error: 'Запрошенный ресурс не найден' })
      expect(invalidateAfter).not.toHaveBeenCalled()
    })
  })
})
