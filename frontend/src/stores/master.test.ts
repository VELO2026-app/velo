// =============================================================================
// VELO Frontend -- stores/master.ts Unit Tests (probekit sweep #17)
// =============================================================================
//
// Covers the two INDEPENDENT upcoming/past pagination cursors (T22-3/T22-5) including
// their `*Loaded` re-fetch guards, the combined fetchMyPractices/practices
// view, the force-reloads refreshMyPractices/refreshUpcomingPractices, and
// $reset (both cursors + the sessionStorage applicant marker). The master
// profile moved to Colada: composables/queries/master.test.ts.
//
// Mocked at the @/api/masters wrapper boundary -- the store's only network
// dependency (usePagination itself is not a network seam, it just wraps
// getMyPractices, so mocking the API function is sufficient and is the same
// seam bookings.test.ts/diary.test.ts use).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useMasterStore } from '@/stores/master'
import * as mastersApi from '@/api/masters'
import { MASTER_APPLIED_KEY } from '@/utils/constants'
import type { PracticeResponse } from '@/api/types'

vi.mock('@/api/masters')

// The Colada side of a practice change (FE-166 step 1): which keys the row
// covers is composables/queries/invalidation.test.ts's business.
const invalidateAfter = vi.hoisted(() => vi.fn())
vi.mock('@/composables/queries/invalidation', () => ({ invalidateAfter }))

function fakePractice(id: string): PracticeResponse {
  return { id, scheduled_at: '2026-06-15T12:00:00Z' } as PracticeResponse
}

function fakePracticesPage(items: PracticeResponse[], total = items.length) {
  return { items, total, limit: 20, offset: 0 }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(mastersApi.getMyPractices).mockReset().mockResolvedValue(fakePracticesPage([]))
  invalidateAfter.mockReset().mockResolvedValue(undefined)
  sessionStorage.clear()
})

describe('useMasterStore', () => {
  describe('upcoming / past practice cursors (independent, T22-3/T22-5)', () => {
    it('fetchUpcomingPractices calls the "upcoming" bucket and populates its own list/total', async () => {
      const items = [fakePractice('u1'), fakePractice('u2')]
      vi.mocked(mastersApi.getMyPractices).mockImplementation((bucket) =>
        Promise.resolve(fakePracticesPage(bucket === 'upcoming' ? items : [])),
      )
      const store = useMasterStore()

      await store.fetchUpcomingPractices()

      expect(mastersApi.getMyPractices).toHaveBeenCalledWith('upcoming', 20, 0)
      expect(store.practicesUpcoming).toEqual(items)
      expect(store.practicesUpcomingTotal).toBe(2)
      expect(store.practicesPast).toEqual([]) // the past cursor was never touched
    })

    it('does not re-fetch "upcoming" once loaded (W-4: a real flag, not items.length > 0)', async () => {
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(fakePracticesPage([])) // zero practices
      const store = useMasterStore()

      await store.fetchUpcomingPractices()
      await store.fetchUpcomingPractices()

      // Would re-fetch forever under an items.length>0 guard for a master with
      // zero upcoming practices -- W-4 fixed exactly this.
      expect(mastersApi.getMyPractices).toHaveBeenCalledTimes(1)
    })

    it('fetchPastPractices calls the "past" bucket independently of "upcoming"', async () => {
      const items = [fakePractice('p1')]
      vi.mocked(mastersApi.getMyPractices).mockImplementation((bucket) =>
        Promise.resolve(fakePracticesPage(bucket === 'past' ? items : [])),
      )
      const store = useMasterStore()

      await store.fetchPastPractices()

      expect(mastersApi.getMyPractices).toHaveBeenCalledWith('past', 20, 0)
      expect(store.practicesPast).toEqual(items)
      expect(store.practicesUpcoming).toEqual([])
    })

    it('fetchMyPractices loads BOTH buckets concurrently', async () => {
      vi.mocked(mastersApi.getMyPractices).mockImplementation((bucket) =>
        Promise.resolve(fakePracticesPage([fakePractice(bucket)])),
      )
      const store = useMasterStore()

      await store.fetchMyPractices()

      expect(mastersApi.getMyPractices).toHaveBeenCalledWith('upcoming', 20, 0)
      expect(mastersApi.getMyPractices).toHaveBeenCalledWith('past', 20, 0)
      // Combined view: upcoming first, then past (order not meaningful per the
      // store's own comment, but the concatenation itself is observable).
      expect(store.practices.map((p) => p.id)).toEqual(['upcoming', 'past'])
      expect(store.practicesTotal).toBe(2)
    })

    it('refreshMyPractices force-reloads BOTH buckets even when already loaded', async () => {
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(fakePracticesPage([]))
      const store = useMasterStore()
      await store.fetchMyPractices()
      expect(mastersApi.getMyPractices).toHaveBeenCalledTimes(2) // upcoming + past

      await store.refreshMyPractices()

      expect(mastersApi.getMyPractices).toHaveBeenCalledTimes(4)
      expect(store.practicesUpcomingLoading).toBe(false)
      expect(store.practicesPastLoading).toBe(false)
    })

    it('refreshUpcomingPractices force-reloads ONLY the upcoming bucket (FE-53)', async () => {
      const items = [fakePractice('fresh')]
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(fakePracticesPage([]))
      const store = useMasterStore()
      await store.fetchMyPractices()
      expect(mastersApi.getMyPractices).toHaveBeenCalledTimes(2) // upcoming + past

      // The dashboard mounts again after a student booked / checked in: the
      // upcoming bucket must hit the network even though its lazy guard is
      // already satisfied, and the past bucket must not pay for it.
      vi.mocked(mastersApi.getMyPractices).mockImplementation((bucket) =>
        Promise.resolve(fakePracticesPage(bucket === 'upcoming' ? items : [])),
      )
      await store.refreshUpcomingPractices()

      expect(mastersApi.getMyPractices).toHaveBeenCalledTimes(3)
      expect(mastersApi.getMyPractices).toHaveBeenLastCalledWith('upcoming', 20, 0)
      expect(store.practicesUpcoming.map((p) => p.id)).toEqual(['fresh'])
      expect(store.practicesPast).toEqual([])
      expect(store.practicesUpcomingLoading).toBe(false)
    })
  })

  describe('$reset', () => {
    it('clears both cursors, both *Loaded flags, the onboarding flag and the applicant sessionStorage marker', async () => {
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(
        fakePracticesPage([fakePractice('x')], 1),
      )
      sessionStorage.setItem(MASTER_APPLIED_KEY, '1')
      const store = useMasterStore()
      await store.fetchMyPractices()
      store.onboardingShownThisSession = true

      store.$reset()

      expect(store.onboardingShownThisSession).toBe(false)
      expect(store.practicesUpcoming).toEqual([])
      expect(store.practicesPast).toEqual([])
      expect(store.practicesUpcomingTotal).toBe(0)
      expect(store.practicesPastTotal).toBe(0)
      expect(sessionStorage.getItem(MASTER_APPLIED_KEY)).toBeNull()

      // A subsequent fetch must be treated as fresh, not skipped by a stale guard
      // left over from before $reset().
      vi.mocked(mastersApi.getMyPractices).mockClear()
      await store.fetchUpcomingPractices()
      expect(mastersApi.getMyPractices).toHaveBeenCalledTimes(1)
      expect(mastersApi.getMyPractices).toHaveBeenCalledWith('upcoming', 20, 0)
    })
  })
})

describe('refreshMyPractices -- the Colada practice entries (FE-166 step 1)', () => {
  it('marks every practice list and detail stale: a school feed shows the changed practice', async () => {
    await useMasterStore().refreshMyPractices()

    expect(invalidateAfter).toHaveBeenCalledWith(expect.anything(), 'changePractice')
  })
})
