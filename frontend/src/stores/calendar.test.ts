// =============================================================================
// VELO Frontend -- stores/calendar.ts Unit Tests (probekit sweep #17)
// =============================================================================
//
// Covers loadWeek (the +-1 day widened UTC query window, per the W-2 comment
// in the store itself), selectDay/shiftWindow via next/prevWeek, canGoPrev,
// applyFilters (including the "explicit undefined clears a facet" subtlety),
// init()'s first-entry-only snap-to-today guard, and the two client-side
// derived views (daysWithPractices / selectedDayPractices) -- specifically
// their F5 viewer-timezone bucketing and their "already started" exclusion.
//
// Mocked at the @/api/practices wrapper boundary (the store's only network
// dependency). @/stores/auth is NOT mocked: useViewerTimezone reads a real
// authStore.user.timezone, and since Pinia here is real (not @pinia/testing),
// setting that field directly on a real useAuthStore() instance is simpler
// and more honest than mocking a store the calendar store doesn't call any
// action on.
//
// Time is pinned everywhere below: `now.value` inside the store is set once,
// at store-creation time, from Date.now() (a setInterval nudges it every 60s,
// which these tests never advance, so it stays pinned for the test's
// duration). TZ is stubbed to 'UTC' so the store's LOCAL-timezone date math
// (weekAnchor, weekDays, localDateKey) lines up 1:1 with the UTC instants
// used in fixtures and assertions below -- this is the same technique
// format.test.ts uses (vi.stubEnv('TZ', ...)) to make local-time-dependent
// code deterministic across whatever timezone the test runner itself is in.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCalendarStore } from '@/stores/calendar'
import { useAuthStore } from '@/stores/auth'
import * as practicesApi from '@/api/practices'
import type { PracticeResponse, UserResponse } from '@/api/types'

vi.mock('@/api/practices')

const NOW_ISO = '2026-06-15T12:00:00.000Z' // mid-day UTC -- today's local midnight is 06-15T00:00Z under the TZ=UTC stub below

function fakePractice(overrides: Partial<PracticeResponse> = {}): PracticeResponse {
  return {
    id: 'practice_1',
    scheduled_at: NOW_ISO,
    ...overrides,
  } as PracticeResponse
}

function emptyPage() {
  return { items: [], total: 0, limit: 100, offset: 0 }
}

function fakeUser(overrides: Partial<UserResponse> = {}): UserResponse {
  return {
    id: 'user_1',
    role: 'user',
    first_name: 'Test',
    last_name: null,
    onboarding_completed: true,
    ...overrides,
  } as UserResponse
}

beforeEach(() => {
  vi.stubEnv('TZ', 'UTC')
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOW_ISO))
  setActivePinia(createPinia())
  vi.mocked(practicesApi.getPractices).mockReset().mockResolvedValue(emptyPage())
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('useCalendarStore', () => {
  describe('loadWeek', () => {
    it('requests the week +-1 day (UTC boundaries), sorted ascending', async () => {
      const store = useCalendarStore()

      await store.loadWeek()

      expect(practicesApi.getPractices).toHaveBeenCalledWith(
        expect.objectContaining({
          date_from: '2026-06-14T00:00:00.000Z',
          date_to: '2026-06-22T23:59:59.999Z',
          sort_by: 'scheduled_at',
          sort_order: 'asc',
        }),
        100,
        0,
      )
    })

    it('on success: stores the returned practices', async () => {
      const items = [fakePractice({ id: 'a' }), fakePractice({ id: 'b' })]
      vi.mocked(practicesApi.getPractices).mockResolvedValue({
        items,
        total: 2,
        limit: 100,
        offset: 0,
      })
      const store = useCalendarStore()

      await store.loadWeek()

      expect(store.weekPractices).toEqual(items)
      expect(store.loading).toBe(false)
      expect(store.error).toBeNull()
    })

    it('on failure: records the error and clears any previously loaded practices', async () => {
      vi.mocked(practicesApi.getPractices).mockRejectedValue(new Error('network down'))
      const store = useCalendarStore()
      store.weekPractices = [fakePractice()]

      await store.loadWeek()

      expect(store.error).toBe('Не удалось загрузить календарь')
      expect(store.weekPractices).toEqual([])
      expect(store.loading).toBe(false)
    })
  })

  describe('selectDay', () => {
    it('updates selectedDate without reloading the week', async () => {
      const store = useCalendarStore()
      await store.loadWeek()
      vi.mocked(practicesApi.getPractices).mockClear()

      store.selectDay('2026-06-17')

      expect(store.selectedDate).toBe('2026-06-17')
      expect(practicesApi.getPractices).not.toHaveBeenCalled()
    })
  })

  describe('canGoPrev / nextWeek / prevWeek', () => {
    it('canGoPrev is false while the window starts at today', () => {
      const store = useCalendarStore()
      expect(store.canGoPrev).toBe(false)
    })

    it('prevWeek is a no-op at today: no state change, no reload', async () => {
      const store = useCalendarStore()
      const anchorBefore = store.weekAnchor.getTime()

      await store.prevWeek()

      expect(store.weekAnchor.getTime()).toBe(anchorBefore)
      expect(practicesApi.getPractices).not.toHaveBeenCalled()
    })

    it('nextWeek shifts the anchor AND the selected day by +7, then reloads', async () => {
      const store = useCalendarStore()

      await store.nextWeek()

      expect(store.weekAnchor.toISOString()).toBe('2026-06-22T00:00:00.000Z')
      expect(store.selectedDate).toBe('2026-06-22')
      expect(practicesApi.getPractices).toHaveBeenCalledTimes(1)
    })

    it('after nextWeek, canGoPrev flips true and prevWeek returns to today', async () => {
      const store = useCalendarStore()

      await store.nextWeek()
      expect(store.canGoPrev).toBe(true)

      await store.prevWeek()

      expect(store.canGoPrev).toBe(false)
      expect(store.weekAnchor.toISOString()).toBe('2026-06-15T00:00:00.000Z')
      expect(store.selectedDate).toBe('2026-06-15')
      // nextWeek's reload + prevWeek's reload.
      expect(practicesApi.getPractices).toHaveBeenCalledTimes(2)
    })
  })

  describe('shiftDays (ribbon scroll)', () => {
    it('scroll is ONLY scroll: the window moves, the SELECTED day never does', async () => {
      const store = useCalendarStore()
      await store.init()
      const before = store.selectedDate // today, = window start (the default state)

      await store.shiftDays(3)
      expect(store.selectedDate).toBe(before) // <-- the invariant
      // The window itself moved.
      const expectedAnchor = new Date(NOW_ISO)
      expectedAnchor.setUTCDate(expectedAnchor.getUTCDate() + 3)
      expect(store.localDateKey(store.days[0]!)).toBe(expectedAnchor.toISOString().slice(0, 10))

      // Back to today: still no selection change, clamped at the today limit.
      await store.shiftDays(-10)
      expect(store.selectedDate).toBe(before)
      expect(store.localDateKey(store.days[0]!)).toBe(NOW_ISO.slice(0, 10))
    })

    it('the fetch range is widened to cover the out-of-window selected day', async () => {
      const store = useCalendarStore()
      await store.init()
      await store.shiftDays(9) // selection (today) is now 9 days behind the window

      const query = vi.mocked(practicesApi.getPractices).mock.calls.at(-1)![0]!
      const from = new Date(query.date_from!).toISOString().slice(0, 10)
      // date_from must reach BACK to the selected day (today) - 1 day buffer.
      const selMinus1 = new Date(NOW_ISO)
      selMinus1.setUTCDate(selMinus1.getUTCDate() - 1)
      expect(from).toBe(selMinus1.toISOString().slice(0, 10))
    })

    it('a zero (clamped) shift is a no-op: no reload', async () => {
      const store = useCalendarStore()
      await store.init()
      const calls = vi.mocked(practicesApi.getPractices).mock.calls.length
      await store.shiftDays(-5) // at today: clamps to 0
      expect(vi.mocked(practicesApi.getPractices).mock.calls.length).toBe(calls)
    })
  })

  describe('applyFilters', () => {
    it('applies a facet filter and reloads with it in the query', async () => {
      const store = useCalendarStore()

      await store.applyFilters({ direction: ['meditation'], difficulty: ['beginner'] })

      expect(store.filters.direction).toEqual(['meditation'])
      const lastCall = vi.mocked(practicesApi.getPractices).mock.calls.at(-1)!
      expect(lastCall[0]).toMatchObject({ direction: ['meditation'], difficulty: ['beginner'] })
    })

    it('explicitly clears a previously-set facet instead of merging over it', async () => {
      const store = useCalendarStore()
      await store.applyFilters({ direction: ['meditation'] })
      expect(store.filters.direction).toEqual(['meditation'])

      await store.applyFilters({})

      expect(store.filters.direction).toBeUndefined()
    })
  })

  describe('init', () => {
    it("re-entry (initialized already true) preserves the user's shifted window instead of snapping back to today", async () => {
      const store = useCalendarStore()

      await store.init() // first entry: snaps to today (no visible change) + loads
      await store.nextWeek() // user navigates forward
      const shiftedAnchor = store.weekAnchor.toISOString()

      await store.init() // re-entry: must NOT reset to today

      expect(store.weekAnchor.toISOString()).toBe(shiftedAnchor)
      expect(store.weekAnchor.toISOString()).not.toBe('2026-06-15T00:00:00.000Z')
      // init() -> nextWeek()'s loadWeek -> init()'s own loadWeek = 3 calls.
      expect(practicesApi.getPractices).toHaveBeenCalledTimes(3)
    })
  })

  describe('daysWithPractices (F5 viewer-timezone bucketing + started-practice exclusion)', () => {
    it('falls back to UTC when the viewer has no profile timezone', () => {
      const store = useCalendarStore()
      // 21:30 UTC on the 15th stays the 15th under a UTC bucket.
      store.weekPractices = [fakePractice({ id: 'p1', scheduled_at: '2026-06-15T21:30:00Z' })]

      expect(store.daysWithPractices).toEqual(new Set(['2026-06-15']))
    })

    it("buckets by the VIEWER'S profile timezone, not UTC, and drops already-started practices", () => {
      const auth = useAuthStore()
      auth.user = fakeUser({ timezone: 'Europe/Moscow' } as Partial<UserResponse>)
      const store = useCalendarStore()
      store.weekPractices = [
        // 21:30 UTC (future: now is 12:00 UTC) = 00:30 the NEXT day in Moscow (UTC+3).
        fakePractice({ id: 'future', scheduled_at: '2026-06-15T21:30:00Z' }),
        // 10:00 UTC is BEFORE "now" (12:00 UTC) -- already started, must be excluded
        // even though it would otherwise bucket onto the 15th.
        fakePractice({ id: 'started', scheduled_at: '2026-06-15T10:00:00Z' }),
      ]

      expect(store.daysWithPractices).toEqual(new Set(['2026-06-16']))
    })
  })

  describe('selectedDayPractices', () => {
    it('filters to the selected day, excludes already-started practices, and sorts ascending', () => {
      const store = useCalendarStore()
      store.selectedDate = '2026-06-15'
      store.weekPractices = [
        fakePractice({ id: 'late', scheduled_at: '2026-06-15T18:00:00Z' }),
        fakePractice({ id: 'early', scheduled_at: '2026-06-15T14:00:00Z' }),
        fakePractice({ id: 'started', scheduled_at: '2026-06-15T09:00:00Z' }), // before "now" (12:00)
        fakePractice({ id: 'other-day', scheduled_at: '2026-06-16T14:00:00Z' }),
      ]

      expect(store.selectedDayPractices.map((p) => p.id)).toEqual(['early', 'late'])
    })

    it('returns an empty list when nothing matches the selected day', () => {
      const store = useCalendarStore()
      store.selectedDate = '2026-06-19'
      store.weekPractices = [fakePractice({ scheduled_at: '2026-06-15T14:00:00Z' })]

      expect(store.selectedDayPractices).toEqual([])
    })
  })
})
