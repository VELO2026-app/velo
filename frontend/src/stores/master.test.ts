// =============================================================================
// VELO Frontend -- stores/master.ts Unit Tests (probekit sweep #17)
// =============================================================================
//
// Covers fetchMyProfile (the profileMissing gate -- keyed on the machine
// error code, not on profile===null, per the store's own №257 comment), the
// two INDEPENDENT upcoming/past pagination cursors (T22-3/T22-5) including
// their `*Loaded` re-fetch guards, the combined fetchMyPractices/practices
// view, the force-reload refreshMyPractices, and $reset (profile + both
// cursors + the sessionStorage applicant marker).
//
// Mocked at the @/api/masters wrapper boundary -- the store's only network
// dependency (usePagination itself is not a network seam, it just wraps
// getMyPractices, so mocking the API function is sufficient and is the same
// seam bookings.test.ts/diary.test.ts use).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useMasterStore } from '@/stores/master'
import { ApiResponseError } from '@/api/client'
import * as mastersApi from '@/api/masters'
import { MASTER_APPLIED_KEY } from '@/utils/constants'
import type { MasterProfileResponse, PracticeResponse } from '@/api/types'

vi.mock('@/api/masters')

function fakeProfile(overrides: Partial<MasterProfileResponse> = {}): MasterProfileResponse {
  return {
    user_id: 'master_1',
    status: 'verified',
    display_name: 'Test Master',
    frozen_cents: 0,
    available_cents: 10000,
    min_withdrawal_cents: 5000,
    withdrawal_fee_cents: 0,
    created_at: '2026-01-01T00:00:00Z',
    rejection_reason: null,
    ...overrides,
  }
}

function fakePractice(id: string): PracticeResponse {
  return { id, scheduled_at: '2026-06-15T12:00:00Z' } as PracticeResponse
}

function fakePracticesPage(items: PracticeResponse[], total = items.length) {
  return { items, total, limit: 20, offset: 0 }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(mastersApi.getMyMasterProfile).mockReset()
  vi.mocked(mastersApi.getMyPractices).mockReset().mockResolvedValue(fakePracticesPage([]))
  sessionStorage.clear()
})

describe('useMasterStore', () => {
  describe('fetchMyProfile', () => {
    it('on success: stores the profile, marks loaded, clears the missing/error flags', async () => {
      vi.mocked(mastersApi.getMyMasterProfile).mockResolvedValue(fakeProfile())
      const store = useMasterStore()

      await store.fetchMyProfile()

      expect(store.profile).toEqual(fakeProfile())
      expect(store.profileLoaded).toBe(true)
      expect(store.profileMissing).toBe(false)
      expect(store.profileError).toBeNull()
    })

    it('403 master_profile_not_found sets profileMissing true (routes to the apply wizard)', async () => {
      vi.mocked(mastersApi.getMyMasterProfile).mockRejectedValue(
        new ApiResponseError(403, 'Профиль мастера не найден', 'master_profile_not_found'),
      )
      const store = useMasterStore()

      await store.fetchMyProfile()

      expect(store.profileMissing).toBe(true)
      expect(store.profileError).toBe('Профиль мастера не найден')
      expect(store.profileLoaded).toBe(false)
    })

    it('403 master_profile_not_verified (pending application) does NOT set profileMissing', async () => {
      vi.mocked(mastersApi.getMyMasterProfile).mockRejectedValue(
        new ApiResponseError(403, 'Профиль ожидает проверки', 'master_profile_not_verified'),
      )
      const store = useMasterStore()

      await store.fetchMyProfile()

      expect(store.profileMissing).toBe(false)
    })

    it('a transient/network failure does NOT set profileMissing -- only the specific 403 code does', async () => {
      vi.mocked(mastersApi.getMyMasterProfile).mockRejectedValue(new Error('network down'))
      const store = useMasterStore()

      await store.fetchMyProfile()

      expect(store.profileMissing).toBe(false)
      expect(store.profileError).toBe('Не удалось загрузить профиль мастера')
    })

    it('skips the network call when already loaded and force is not passed', async () => {
      vi.mocked(mastersApi.getMyMasterProfile).mockResolvedValue(fakeProfile())
      const store = useMasterStore()

      await store.fetchMyProfile()
      await store.fetchMyProfile()

      expect(mastersApi.getMyMasterProfile).toHaveBeenCalledTimes(1)
    })

    it('force=true refetches even when already loaded', async () => {
      vi.mocked(mastersApi.getMyMasterProfile).mockResolvedValue(fakeProfile())
      const store = useMasterStore()

      await store.fetchMyProfile()
      await store.fetchMyProfile(true)

      expect(mastersApi.getMyMasterProfile).toHaveBeenCalledTimes(2)
    })
  })

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
  })

  describe('$reset', () => {
    it('clears the profile, both cursors, both *Loaded flags, and the applicant sessionStorage marker', async () => {
      vi.mocked(mastersApi.getMyMasterProfile).mockResolvedValue(fakeProfile())
      vi.mocked(mastersApi.getMyPractices).mockResolvedValue(
        fakePracticesPage([fakePractice('x')], 1),
      )
      sessionStorage.setItem(MASTER_APPLIED_KEY, '1')
      const store = useMasterStore()
      await store.fetchMyProfile()
      await store.fetchMyPractices()
      store.onboardingShownThisSession = true

      store.$reset()

      expect(store.profile).toBeNull()
      expect(store.profileLoaded).toBe(false)
      expect(store.profileMissing).toBe(false)
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
