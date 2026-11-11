// =============================================================================
// VELO Frontend -- the cancel-booking mutation (FE-157 4F pilot)
// =============================================================================
//
// The review finding this pins: cancelling refreshed only the bookings list,
// so the dashboard's upcoming list, the practice's seats and the calendar week
// went on showing the cancelled booking. useCancelBooking now refreshes every
// holder of that data: the Colada keys of INVALIDATES.cancelBooking and,
// until they move to Colada, the legacy stores and the in-house cache.
//
// The legacy stores are mocked (their own refresh logic has its own tests);
// Colada and the in-house cache are real, so "stale" and "refetched" are
// observed on the caches themselves. Covered from the old store test
// (stores/bookings.test.ts, cancelBooking): the API call, the list refresh,
// the diary refresh, no side effects on failure.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createPinia } from 'pinia'
import { PiniaColada, useQuery, useQueryCache, type QueryCache } from '@pinia/colada'
import { coladaOptions, useQueryScopeStore } from '@/composables/queries/setup'
import { keys } from '@/composables/queries/keys'
import { schoolFeedQuery } from '@/composables/queries/schools'
import { useCancelBooking, type CancelBookingVars } from '@/composables/queries/bookings'
import { queryCache as legacyQueryCache } from '@/composables/useQuery'
import { queryKeys as legacyKeys } from '@/composables/queryKeys'
import { ApiResponseError } from '@/api/client'
import * as bookingsApi from '@/api/bookings'
import * as schoolsApi from '@/api/schools'
import type { PracticeResponse } from '@/api/types'

vi.mock('@/api/bookings')
vi.mock('@/api/schools')

const stores = vi.hoisted(() => ({
  bookings: { refreshMyBookings: vi.fn(), invalidateUpcoming: vi.fn() },
  practices: { selected: null as { id: string } | null, fetchPractice: vi.fn() },
  calendar: { weekPractices: [] as Array<{ id: string }>, loadWeek: vi.fn() },
  diary: { refreshFeed: vi.fn() },
  balance: { refresh: vi.fn() },
}))
vi.mock('@/stores/bookings', () => ({ useBookingsStore: () => stores.bookings }))
vi.mock('@/stores/practices', () => ({ usePracticesStore: () => stores.practices }))
vi.mock('@/stores/calendar', () => ({ useCalendarStore: () => stores.calendar }))
vi.mock('@/stores/diary', () => ({ useDiaryStore: () => stores.diary }))
vi.mock('@/stores/balance', () => ({ useBalanceStore: () => stores.balance }))

const VARS: CancelBookingVars = { bookingId: 'b7', practiceId: 'p1' }
const practice = { id: 'p1' } as PracticeResponse

let app: App | null = null
let cancel: (vars: CancelBookingVars) => Promise<unknown>
let queryCache: QueryCache

/** A screen holding the school feed on screen and the cancel mutation. */
const Screen = defineComponent({
  setup() {
    useQuery(() => schoolFeedQuery({ schoolId: 'g1', limit: 5 }))
    cancel = useCancelBooking().mutateAsync
    queryCache = useQueryCache()
    return () => h('div')
  },
})

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** `when` of an entry: 0 once invalidated (entries written by setQueryData carry no staleTime). */
function when(key: readonly unknown[]): number | undefined {
  return queryCache.get(key as Parameters<QueryCache['get']>[0])?.when
}

beforeEach(async () => {
  vi.mocked(bookingsApi.cancelBooking).mockReset().mockResolvedValue(undefined)
  vi.mocked(schoolsApi.getSchoolPractices)
    .mockReset()
    .mockResolvedValue({ items: [practice], total: 1, limit: 5, offset: 0 })
  stores.bookings.refreshMyBookings.mockReset().mockResolvedValue(undefined)
  stores.bookings.invalidateUpcoming.mockReset()
  stores.practices.selected = { id: 'p1' }
  stores.practices.fetchPractice.mockReset().mockResolvedValue(undefined)
  stores.calendar.weekPractices = [{ id: 'p0' }, { id: 'p1' }]
  stores.calendar.loadWeek.mockReset().mockResolvedValue(undefined)
  stores.diary.refreshFeed.mockReset().mockResolvedValue(undefined)
  stores.balance.refresh.mockReset().mockResolvedValue(undefined)

  app = createApp(Screen).use(createPinia()).use(PiniaColada, coladaOptions)
  app.mount(document.createElement('div'))
  await flush()
  // Off screen: another school's feed, a bookings entry, and the school page
  // (a cancellation does not change it).
  queryCache.setQueryData(keys.practices.schoolFeed('g2', 5), [practice])
  queryCache.setQueryData([...keys.bookings.root(), 'list'], [])
  queryCache.setQueryData(keys.schools.detail('g1'), { name: 'School' })
  legacyQueryCache.setData(legacyKeys.practice('p1'), () => practice)
})

afterEach(() => {
  app?.unmount()
  app = null
})

describe('useCancelBooking -- success', () => {
  it('cancels the booking, then refreshes the bookings list before it resolves', async () => {
    let releaseList!: () => void
    stores.bookings.refreshMyBookings.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseList = resolve
      }),
    )
    let settled = false
    const done = cancel(VARS).then(() => {
      settled = true
    })
    await flush()

    expect(bookingsApi.cancelBooking).toHaveBeenCalledWith('b7')
    expect(stores.bookings.refreshMyBookings).toHaveBeenCalledTimes(1)
    // The screen's cancel control derives from that list: no second tap.
    expect(settled).toBe(false)
    releaseList()
    await done
    expect(settled).toBe(true)
  })

  it('invalidates every Colada key of the map: the feed on screen refetches, the rest go stale', async () => {
    const feedOnScreen = keys.practices.schoolFeed('g1', 5)
    expect(schoolsApi.getSchoolPractices).toHaveBeenCalledTimes(1)
    const pageAt = when(keys.schools.detail('g1'))

    await cancel(VARS)
    await flush()

    // keys.practices.root(): the active feed refetched...
    expect(schoolsApi.getSchoolPractices).toHaveBeenCalledTimes(2)
    expect(queryCache.get(feedOnScreen)?.state.value.status).toBe('success')
    // ...the feed off screen is stale until its screen reads it.
    expect(when(keys.practices.schoolFeed('g2', 5))).toBe(0)
    // keys.bookings.root()
    expect(when([...keys.bookings.root(), 'list'])).toBe(0)
    // Not in the map: untouched.
    expect(when(keys.schools.detail('g1'))).toBe(pageAt)
  })

  it('refreshes the legacy holders: upcoming, practice detail, calendar week, diary', async () => {
    await cancel(VARS)

    expect(stores.bookings.invalidateUpcoming).toHaveBeenCalledTimes(1)
    expect(stores.practices.fetchPractice).toHaveBeenCalledWith('p1')
    expect(legacyQueryCache.isFresh(legacyKeys.practice('p1'), 60_000)).toBe(false)
    expect(stores.calendar.loadWeek).toHaveBeenCalledWith(true)
    expect(stores.diary.refreshFeed).toHaveBeenCalledTimes(1)
  })

  it('re-reads the profile at once, so a refund shows in the balance', async () => {
    await cancel(VARS)

    expect(stores.balance.refresh).toHaveBeenCalledTimes(1)
  })

  it('leaves the practice detail and the calendar alone when they show another practice', async () => {
    stores.practices.selected = { id: 'p9' }
    stores.calendar.weekPractices = [{ id: 'p9' }]

    await cancel(VARS)

    expect(stores.practices.fetchPractice).not.toHaveBeenCalled()
    expect(stores.calendar.loadWeek).not.toHaveBeenCalled()
    // The cached detail still goes stale: the next open refetches it.
    expect(legacyQueryCache.isFresh(legacyKeys.practice('p1'), 60_000)).toBe(false)
  })
})

describe('useCancelBooking -- the session ends while the DELETE is in flight', () => {
  it('refreshes nothing on the reset stores, and still resolves', async () => {
    let answer!: () => void
    vi.mocked(bookingsApi.cancelBooking).mockReturnValue(
      new Promise<undefined>((resolve) => {
        answer = () => resolve(undefined)
      }),
    )
    const done = cancel(VARS)
    await flush()

    // Logout / 401: resetAccountScope calls every member's $reset.
    useQueryScopeStore(app!.config.globalProperties.$pinia).$reset()
    answer()
    await done
    await flush()

    expect(stores.bookings.refreshMyBookings).not.toHaveBeenCalled()
    expect(stores.bookings.invalidateUpcoming).not.toHaveBeenCalled()
    expect(stores.practices.fetchPractice).not.toHaveBeenCalled()
    expect(stores.calendar.loadWeek).not.toHaveBeenCalled()
    expect(stores.diary.refreshFeed).not.toHaveBeenCalled()
    expect(stores.balance.refresh).not.toHaveBeenCalled()
    expect(legacyQueryCache.isFresh(legacyKeys.practice('p1'), 60_000)).toBe(true)
  })
})

describe('useCancelBooking -- failure', () => {
  it('rejects with the API error and refreshes nothing', async () => {
    const error = new ApiResponseError(400, 'practice completed', 'practice_completed')
    vi.mocked(bookingsApi.cancelBooking).mockRejectedValue(error)

    await expect(cancel(VARS)).rejects.toBe(error)
    await flush()

    expect(stores.bookings.refreshMyBookings).not.toHaveBeenCalled()
    expect(stores.bookings.invalidateUpcoming).not.toHaveBeenCalled()
    expect(stores.practices.fetchPractice).not.toHaveBeenCalled()
    expect(stores.calendar.loadWeek).not.toHaveBeenCalled()
    expect(stores.diary.refreshFeed).not.toHaveBeenCalled()
    expect(stores.balance.refresh).not.toHaveBeenCalled()
    expect(schoolsApi.getSchoolPractices).toHaveBeenCalledTimes(1)
    expect(when(keys.practices.schoolFeed('g2', 5))).not.toBe(0)
    expect(legacyQueryCache.isFresh(legacyKeys.practice('p1'), 60_000)).toBe(true)
  })
})
