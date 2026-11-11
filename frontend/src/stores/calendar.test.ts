// =============================================================================
// VELO Frontend -- stores/calendar.ts Unit Tests (probekit sweep #17)
// =============================================================================
//
// Since FE-166 step 4 the store holds only the client state that decides
// WHICH week the calendar shows; the week itself is a Colada query
// (composables/queries/calendar.test.ts covers loading, the day markers and
// the selected-day list). Covered here: weekParams (the +-1 day widened UTC
// range, per the W-2 note in the store, and its widening to the selected
// day), selectDay / next / prevWeek, canGoPrev, the ribbon's shiftDays (quiet,
// selection never moves), applyFilters (including the "explicit undefined
// clears a facet" subtlety), init()'s first-entry-only snap-to-today guard,
// and the school scope's snap to the nearest practice.
//
// Time is pinned everywhere below. TZ is stubbed to 'UTC' so the store's LOCAL-timezone date math
// (weekAnchor, weekDays, localDateKey) lines up 1:1 with the UTC instants
// used in fixtures and assertions below -- this is the same technique
// format.test.ts uses (vi.stubEnv('TZ', ...)) to make local-time-dependent
// code deterministic across whatever timezone the test runner itself is in.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCalendarStore } from '@/stores/calendar'
import type { PracticeResponse } from '@/api/types'

const NOW_ISO = '2026-06-15T12:00:00.000Z' // mid-day UTC -- today's local midnight is 06-15T00:00Z under the TZ=UTC stub below

function fakePractice(overrides: Partial<PracticeResponse> = {}): PracticeResponse {
  return {
    id: 'practice_1',
    scheduled_at: NOW_ISO,
    ...overrides,
  } as PracticeResponse
}

beforeEach(() => {
  vi.stubEnv('TZ', 'UTC')
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOW_ISO))
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('useCalendarStore', () => {
  describe('weekParams (the week query key)', () => {
    it('the range is the window +-1 day (UTC boundaries), no scope, no filters', () => {
      const store = useCalendarStore()

      expect(store.weekParams).toEqual({
        from: '2026-06-14T00:00:00.000Z',
        to: '2026-06-22T23:59:59.999Z',
        filters: {},
        master: null,
        schoolFilter: null,
        school: null,
      })
    })

    it('selecting a day inside the window leaves the key alone (no reload)', () => {
      const store = useCalendarStore()
      const before = JSON.stringify(store.weekParams)

      store.selectDay('2026-06-17')

      expect(store.selectedDate).toBe('2026-06-17')
      expect(JSON.stringify(store.weekParams)).toBe(before)
    })

    it('the scopes reach the key', () => {
      const store = useCalendarStore()
      store.setMasterScope('master_1', 'g1')
      expect(store.weekParams).toMatchObject({ master: 'master_1', schoolFilter: 'g1' })

      store.setMasterScope(null)
      store.setSchoolScope('g7')
      expect(store.weekParams).toMatchObject({ master: null, schoolFilter: null, school: 'g7' })
    })
  })

  describe('canGoPrev / nextWeek / prevWeek', () => {
    it('canGoPrev is false while the window starts at today', () => {
      const store = useCalendarStore()
      expect(store.canGoPrev).toBe(false)
    })

    it('prevWeek is a no-op at today: no state change', () => {
      const store = useCalendarStore()
      const anchorBefore = store.weekAnchor.getTime()

      store.prevWeek()

      expect(store.weekAnchor.getTime()).toBe(anchorBefore)
    })

    it('nextWeek shifts the anchor AND the selected day by +7 -- a real (not quiet) reload', () => {
      const store = useCalendarStore()
      store.shiftDays(1) // a ribbon scroll first: quiet
      expect(store.quietWindow).toBe(true)

      store.nextWeek()

      expect(store.weekAnchor.toISOString()).toBe('2026-06-23T00:00:00.000Z')
      expect(store.selectedDate).toBe('2026-06-22')
      expect(store.quietWindow).toBe(false)
    })

    it('after nextWeek, canGoPrev flips true and prevWeek returns to today', () => {
      const store = useCalendarStore()

      store.nextWeek()
      expect(store.canGoPrev).toBe(true)

      store.prevWeek()

      expect(store.canGoPrev).toBe(false)
      expect(store.weekAnchor.toISOString()).toBe('2026-06-15T00:00:00.000Z')
      expect(store.selectedDate).toBe('2026-06-15')
    })
  })

  describe('shiftDays (ribbon scroll)', () => {
    it('scroll is ONLY scroll: the window moves, the SELECTED day never does -- and quietly', () => {
      const store = useCalendarStore()
      store.init()
      const before = store.selectedDate // today, = window start (the default state)

      store.shiftDays(3)
      expect(store.selectedDate).toBe(before) // <-- the invariant
      expect(store.quietWindow).toBe(true)
      // The window itself moved.
      const expectedAnchor = new Date(NOW_ISO)
      expectedAnchor.setUTCDate(expectedAnchor.getUTCDate() + 3)
      expect(store.localDateKey(store.days[0]!)).toBe(expectedAnchor.toISOString().slice(0, 10))

      // Back to today: still no selection change, clamped at the today limit.
      store.shiftDays(-10)
      expect(store.selectedDate).toBe(before)
      expect(store.localDateKey(store.days[0]!)).toBe(NOW_ISO.slice(0, 10))
    })

    it('the range is widened to cover the out-of-window selected day', () => {
      const store = useCalendarStore()
      store.init()
      store.shiftDays(9) // selection (today) is now 9 days behind the window

      const from = store.weekParams.from.slice(0, 10)
      // The range must reach BACK to the selected day (today) - 1 day buffer.
      const selMinus1 = new Date(NOW_ISO)
      selMinus1.setUTCDate(selMinus1.getUTCDate() - 1)
      expect(from).toBe(selMinus1.toISOString().slice(0, 10))
    })

    it('a zero (clamped) shift is a no-op: the key does not move', () => {
      const store = useCalendarStore()
      store.init()
      const before = JSON.stringify(store.weekParams)
      store.shiftDays(-5) // at today: clamps to 0
      expect(JSON.stringify(store.weekParams)).toBe(before)
      expect(store.quietWindow).toBe(false)
    })
  })

  describe('applyFilters', () => {
    it('applies a facet filter: it reaches the key, as a real reload', () => {
      const store = useCalendarStore()
      store.shiftDays(1)

      store.applyFilters({ direction: ['meditation'], difficulty: ['beginner'] })

      expect(store.filters.direction).toEqual(['meditation'])
      expect(store.weekParams.filters).toMatchObject({
        direction: ['meditation'],
        difficulty: ['beginner'],
      })
      expect(store.quietWindow).toBe(false)
    })

    it('explicitly clears a previously-set facet instead of merging over it', () => {
      const store = useCalendarStore()
      store.applyFilters({ direction: ['meditation'] })
      expect(store.filters.direction).toEqual(['meditation'])

      store.applyFilters({})

      expect(store.filters.direction).toBeUndefined()
    })
  })

  describe('init', () => {
    it("re-entry (initialized already true) preserves the user's shifted window instead of snapping back to today", () => {
      const store = useCalendarStore()

      store.init() // first entry: snaps to today (no visible change)
      store.nextWeek() // user navigates forward
      const shiftedAnchor = store.weekAnchor.toISOString()

      store.init() // re-entry: must NOT reset to today

      expect(store.weekAnchor.toISOString()).toBe(shiftedAnchor)
      expect(store.weekAnchor.toISOString()).not.toBe('2026-06-15T00:00:00.000Z')
    })
  })

  describe('snapToSchoolFeed (school scope opens ON the practices)', () => {
    it('moves the window and the selection to the nearest upcoming practice, once per mode entry', () => {
      const store = useCalendarStore()
      store.setSchoolScope('g7')
      const feed = [
        fakePractice({ id: 'far', scheduled_at: '2026-07-20T10:00:00Z' }),
        fakePractice({ id: 'near', scheduled_at: '2026-07-02T10:00:00Z' }),
        fakePractice({ id: 'past', scheduled_at: '2026-06-01T10:00:00Z' }),
      ]

      store.snapToSchoolFeed(feed, 'UTC')
      expect(store.selectedDate).toBe('2026-07-02')
      expect(store.localDateKey(store.weekAnchor)).toBe('2026-07-02')

      // In-mode navigation never re-snaps.
      store.nextWeek()
      store.snapToSchoolFeed(feed, 'UTC')
      expect(store.selectedDate).toBe('2026-07-09')

      // A new mode entry snaps again.
      store.setSchoolScope(null)
      store.setSchoolScope('g7')
      store.snapToSchoolFeed(feed, 'UTC')
      expect(store.selectedDate).toBe('2026-07-02')
    })

    it('outside the school scope it does nothing', () => {
      const store = useCalendarStore()
      store.snapToSchoolFeed([fakePractice({ scheduled_at: '2026-07-02T10:00:00Z' })], 'UTC')
      expect(store.selectedDate).toBe('2026-06-15')
    })
  })
})
