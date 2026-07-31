// =============================================================================
// VELO Frontend -- Diary Store Tests (W27, PROMPT №438)
// =============================================================================
//
// The diary store had NO tests. This file exists because W27 changed its
// behaviour: refreshAfterDiaryMutation() used to call
// useBookingsStore().refreshBookings() -- the diary->bookings half of a circular
// store dependency -- and that call is now gone. Changing an untested store and
// walking away is precisely the silent-failure shape this session has spent the
// day removing, so the change gets a guard rather than a promise.
//
// Scope is deliberately W27's blast radius, not the whole store: the two actions
// that reach refreshAfterDiaryMutation (submitCheckin, submitFeedback), what they
// refresh, and -- the point of the change -- what they must NOT touch.
//
// THE KEY TEST is «does not touch the bookings store». It is negative space, the
// same shape guards.test.ts uses (a guard must not touch stores it has no
// business touching). @/stores/bookings is mocked here NOT because the diary
// store needs it, but so that any re-introduced import would light this up
// instead of quietly restoring the cycle.
//
// Real Pinia, mocked API seam (velo-idiom §4/§5): the store is the thing under
// test, so only the network boundary is faked.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useDiaryStore } from '@/stores/diary'
import * as diaryApi from '@/api/diary'
import { ApiResponseError } from '@/api/client'
import type { CheckinRequest, FeedbackRequest } from '@/api/types'

vi.mock('@/api/diary')

// The bookings store must stay UNREACHED. If someone re-adds the import and the
// call, refreshBookings starts getting hit and the negative-space test below
// fails -- which is the whole point of mocking a store the diary does not use.
const refreshBookings = vi.fn()
vi.mock('@/stores/bookings', () => ({
  useBookingsStore: () => ({ refreshBookings }),
}))

const CHECKIN: CheckinRequest = { mood: 4, energy: 3, comment: null } as CheckinRequest
const FEEDBACK: FeedbackRequest = { rating: 5, comment: null } as FeedbackRequest

function feedPage(items: unknown[] = []) {
  return { items, next_cursor: null } as Awaited<ReturnType<typeof diaryApi.listDiaryFeed>>
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(diaryApi.upsertCheckin)
    .mockReset()
    .mockResolvedValue({} as never)
  vi.mocked(diaryApi.upsertFeedback)
    .mockReset()
    .mockResolvedValue({} as never)
  vi.mocked(diaryApi.listDiaryFeed).mockReset().mockResolvedValue(feedPage())
  refreshBookings.mockReset()
})

describe('diary store', () => {
  describe('submitCheckin', () => {
    it('on success: posts the check-in and refreshes the feed', async () => {
      const store = useDiaryStore()

      const result = await store.submitCheckin('p1', CHECKIN)

      expect(diaryApi.upsertCheckin).toHaveBeenCalledWith('p1', CHECKIN)
      expect(result).toEqual({ ok: true, error: '' })
      // The check-in is projected onto the timeline, so the feed must re-read.
      expect(diaryApi.listDiaryFeed).toHaveBeenCalled()
    })

    it('surfaces the REAL backend message on failure and does NOT refresh', async () => {
      vi.mocked(diaryApi.upsertCheckin).mockRejectedValue(
        new ApiResponseError(409, 'Check-in уже отправлен', 'already_submitted'),
      )
      const store = useDiaryStore()

      const result = await store.submitCheckin('p1', CHECKIN)

      expect(result.ok).toBe(false)
      expect(result.error).toBe('Check-in уже отправлен')
      expect(diaryApi.listDiaryFeed).not.toHaveBeenCalled()
    })

    it('a feed-refresh failure does NOT fail the submit', async () => {
      // Promise.allSettled: the check-in is already persisted, so a refresh that
      // fails must not tell the user their check-in was rejected.
      vi.mocked(diaryApi.listDiaryFeed).mockRejectedValue(new Error('сеть отвалилась'))
      const store = useDiaryStore()

      const result = await store.submitCheckin('p1', CHECKIN)

      expect(result).toEqual({ ok: true, error: '' })
    })

    it('is re-entrant-guarded: a second submit while one is in flight is dropped', async () => {
      let resolve!: (v: unknown) => void
      vi.mocked(diaryApi.upsertCheckin).mockReturnValue(
        new Promise((r) => {
          resolve = r
        }) as never,
      )
      const store = useDiaryStore()

      const first = store.submitCheckin('p1', CHECKIN)
      const second = await store.submitCheckin('p1', CHECKIN)

      expect(second).toEqual({ ok: false, error: '' })
      expect(diaryApi.upsertCheckin).toHaveBeenCalledTimes(1)

      resolve({})
      await first
    })
  })

  describe('submitFeedback', () => {
    it('on success: posts the feedback and refreshes the feed', async () => {
      const store = useDiaryStore()

      const result = await store.submitFeedback('p1', FEEDBACK)

      expect(diaryApi.upsertFeedback).toHaveBeenCalledWith('p1', FEEDBACK)
      expect(result).toEqual({ ok: true, error: '' })
      expect(diaryApi.listDiaryFeed).toHaveBeenCalled()
    })

    it('surfaces the REAL backend message on failure', async () => {
      vi.mocked(diaryApi.upsertFeedback).mockRejectedValue(
        new ApiResponseError(400, 'Оценка обязательна', 'rating_required'),
      )
      const store = useDiaryStore()

      const result = await store.submitFeedback('p1', FEEDBACK)

      expect(result.ok).toBe(false)
      expect(result.error).toBe('Оценка обязательна')
    })
  })

  describe('W27: the diary store does NOT reach into the bookings store', () => {
    // The guard on the fix. Before PROMPT №438 both of these fired
    // useBookingsStore().refreshBookings() from inside the store, which was
    // (a) the diary->bookings half of a circular import and (b) redundant --
    // CheckinView.vue:155 and FeedbackView.vue:127 already call refreshBookings
    // themselves the moment the submit resolves, so every check-in and every
    // feedback issued TWO sequential GET /bookings.
    //
    // Keeping bookings fresh is the view's job, which is the convention this
    // codebase already follows. If either of these goes red, someone has put the
    // cycle back.

    it('submitCheckin does not refresh bookings', async () => {
      const store = useDiaryStore()

      await store.submitCheckin('p1', CHECKIN)

      expect(refreshBookings).not.toHaveBeenCalled()
    })

    it('submitFeedback does not refresh bookings', async () => {
      const store = useDiaryStore()

      await store.submitFeedback('p1', FEEDBACK)

      expect(refreshBookings).not.toHaveBeenCalled()
    })

    it('exactly ONE feed read per submit -- no duplicate refresh', async () => {
      const store = useDiaryStore()

      await store.submitCheckin('p1', CHECKIN)

      expect(vi.mocked(diaryApi.listDiaryFeed).mock.calls).toHaveLength(1)
    })
  })

  // ===========================================================================
  // $reset -- THE HABIT: three sibling refs, and one of them was forgotten.
  // ===========================================================================
  describe('$reset', () => {
    it('clears ALL THREE submitting refs, not just the two someone remembered', async () => {
      // Found by coverage in №445, fixed in №446. $reset cleared checkinSubmitting
      // (:387) and feedbackSubmitting (:388) and silently skipped
      // reflectionSubmitting (:117) -- three sibling refs declared together, two
      // reset, one forgotten. The same shape as MasterPracticesView :50 vs :57,
      // VInput's fix landing on one render path of three, and EntryView's onSave
      // vs onDelete twenty lines apart. It is a habit of this codebase.
      //
      // It was INERT when found -- the reflection endpoint is a stub that never
      // holds the ref across an await -- which is exactly why it was worth one line
      // now rather than a blind hunt the day TD-REFLECTION lands and a logout
      // leaves the reflection form permanently wedged.
      //
      // Asserted by SETTING all three first: reading three falses on a fresh store
      // would pass with $reset deleted entirely.
      const store = useDiaryStore()
      store.checkinSubmitting = true
      store.feedbackSubmitting = true
      store.reflectionSubmitting = true

      store.$reset()

      expect(store.checkinSubmitting).toBe(false)
      expect(store.feedbackSubmitting).toBe(false)
      expect(store.reflectionSubmitting).toBe(false)
    })
  })
})
