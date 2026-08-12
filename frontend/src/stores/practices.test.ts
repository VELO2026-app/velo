// =============================================================================
// VELO Frontend -- stores/practices.ts Unit Tests (probekit sweep #17)
// =============================================================================
//
// Covers fetchPractice (single-practice detail for PracticeDetailView) and
// its F-01 race guard: a slow response for an EARLIER id must not overwrite
// `selected` once the user has already navigated to a later id, whether that
// stale response arrives as a success OR as a failure. Also covers
// clearSelected().
//
// Mocked at the @/api/practices wrapper boundary -- the store's only network
// dependency.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { usePracticesStore } from '@/stores/practices'
import { ApiResponseError } from '@/api/client'
import * as practicesApi from '@/api/practices'
import type { PracticeResponse } from '@/api/types'

vi.mock('@/api/practices')

function fakePractice(overrides: Partial<PracticeResponse> = {}): PracticeResponse {
  return {
    id: 'practice_1',
    title: 'Morning meditation',
    scheduled_at: '2026-06-15T12:00:00Z',
    ...overrides,
  } as PracticeResponse
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(practicesApi.getPractice).mockReset()
})

describe('usePracticesStore', () => {
  describe('fetchPractice', () => {
    it('on success: stores the practice and clears loading/error', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(fakePractice({ id: 'p1' }))
      const store = usePracticesStore()

      await store.fetchPractice('p1')

      expect(practicesApi.getPractice).toHaveBeenCalledWith('p1')
      expect(store.selected).toEqual(fakePractice({ id: 'p1' }))
      expect(store.selectedLoading).toBe(false)
      expect(store.selectedError).toBeNull()
    })

    it('on failure: records the backend detail, clears selected', async () => {
      vi.mocked(practicesApi.getPractice).mockRejectedValue(
        new ApiResponseError(404, 'Практика не найдена', 'not_found'),
      )
      const store = usePracticesStore()
      store.selected = fakePractice({ id: 'stale' })

      await store.fetchPractice('missing')

      expect(store.selectedError).toBe('Практика не найдена')
      expect(store.selected).toBeNull()
      expect(store.selectedLoading).toBe(false)
    })

    it('falls back to the generic message for a non-ApiResponseError failure', async () => {
      vi.mocked(practicesApi.getPractice).mockRejectedValue(new Error('boom'))
      const store = usePracticesStore()

      await store.fetchPractice('p1')

      expect(store.selectedError).toBe('Не удалось загрузить практику')
    })

    describe('F-01 race guard', () => {
      it('a late SUCCESS for a superseded id does not overwrite the newer selection', async () => {
        let resolveA: (v: PracticeResponse) => void = () => {}
        const pendingA = new Promise<PracticeResponse>((resolve) => {
          resolveA = resolve
        })
        vi.mocked(practicesApi.getPractice).mockImplementation((id: string) =>
          id === 'A' ? pendingA : Promise.resolve(fakePractice({ id: 'B' })),
        )
        const store = usePracticesStore()

        const fetchA = store.fetchPractice('A') // starts, stays in flight
        await store.fetchPractice('B') // user navigates to B before A resolves

        expect(store.selected?.id).toBe('B')

        resolveA(fakePractice({ id: 'A' })) // A's stale response finally lands
        await fetchA

        expect(store.selected?.id).toBe('B')
        expect(store.selectedLoading).toBe(false)
      })

      it('a late FAILURE for a superseded id does not clobber the newer successful selection', async () => {
        let rejectA: (e: unknown) => void = () => {}
        const pendingA = new Promise<PracticeResponse>((_resolve, reject) => {
          rejectA = reject
        })
        vi.mocked(practicesApi.getPractice).mockImplementation((id: string) =>
          id === 'A' ? pendingA : Promise.resolve(fakePractice({ id: 'B' })),
        )
        const store = usePracticesStore()

        const fetchA = store.fetchPractice('A')
        await store.fetchPractice('B')
        expect(store.selected?.id).toBe('B')

        rejectA(new ApiResponseError(500, 'stale server error', 'server_error'))
        await fetchA // fetchPractice catches internally -- never rejects the caller

        expect(store.selected?.id).toBe('B')
        expect(store.selectedError).toBeNull()
      })
    })
  })

  describe('clearSelected', () => {
    it('clears the selected practice and its error, independent of loading', () => {
      const store = usePracticesStore()
      store.selected = fakePractice()
      store.selectedError = 'some previous error'

      store.clearSelected()

      expect(store.selected).toBeNull()
      expect(store.selectedError).toBeNull()
    })
  })
})
