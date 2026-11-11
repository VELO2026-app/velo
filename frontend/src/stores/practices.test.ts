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
import { PiniaColada, useQueryCache } from '@pinia/colada'
import { createApp } from 'vue'
import { coladaOptions } from '@/composables/queries/setup'
import { prefetchPractice, seedPractices, usePracticesStore } from '@/stores/practices'
import { keys } from '@/composables/queries/keys'
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
  // Colada installed as in app.ts: its query defaults (gcTime) are provided by the plugin.
  const pinia = createPinia()
  createApp({}).use(pinia).use(PiniaColada, coladaOptions)
  setActivePinia(pinia)
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

    it('on failure: records the mapped table phrase for a real backend code, clears selected', async () => {
      // B8 (PROMPT №747): 'not_found' IS a real backend code -- extractApiError
      // now returns its table phrase regardless of the mocked detail text.
      vi.mocked(practicesApi.getPractice).mockRejectedValue(
        new ApiResponseError(404, 'Практика не найдена', 'not_found'),
      )
      const store = usePracticesStore()
      store.selected = fakePractice({ id: 'stale' })

      await store.fetchPractice('missing')

      expect(store.selectedError).toBe('Запрошенный ресурс не найден')
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

  describe('stale-while-revalidate', () => {
    it('a practice seen before renders at once (no loading state) and refreshes silently', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValueOnce(
        fakePractice({ id: 'p1', title: 'Old' }),
      )
      const store = usePracticesStore()
      await store.fetchPractice('p1')
      store.clearSelected()

      let resolve: (v: PracticeResponse) => void = () => {}
      vi.mocked(practicesApi.getPractice).mockReturnValueOnce(
        new Promise<PracticeResponse>((r) => {
          resolve = r
        }),
      )
      const refresh = store.fetchPractice('p1')

      expect(store.selected?.title).toBe('Old')
      expect(store.selectedLoading).toBe(false)

      resolve(fakePractice({ id: 'p1', title: 'New' }))
      await refresh
      expect(store.selected?.title).toBe('New')
    })

    it('a list seed is shown until the response lands', async () => {
      vi.mocked(practicesApi.getPractice).mockReturnValueOnce(new Promise(() => {}))
      const store = usePracticesStore()

      void store.fetchPractice('p2', fakePractice({ id: 'p2', title: 'From list' }))

      expect(store.selected?.title).toBe('From list')
      expect(store.selectedLoading).toBe(false)
    })

    it('a failed refresh keeps the practice on screen', async () => {
      const store = usePracticesStore()
      vi.mocked(practicesApi.getPractice).mockResolvedValueOnce(fakePractice({ id: 'p1' }))
      await store.fetchPractice('p1')

      vi.mocked(practicesApi.getPractice).mockRejectedValueOnce(new Error('offline'))
      await store.fetchPractice('p1')

      expect(store.selected?.id).toBe('p1')
      expect(store.selectedError).toBeNull()
    })

    it('a refresh that says the practice is gone (404) clears it, even when it was shown', async () => {
      const store = usePracticesStore()
      vi.mocked(practicesApi.getPractice).mockResolvedValueOnce(fakePractice({ id: 'p1' }))
      await store.fetchPractice('p1')

      vi.mocked(practicesApi.getPractice).mockRejectedValueOnce(
        new ApiResponseError(404, 'gone', 'not_found'),
      )
      await store.fetchPractice('p1')

      expect(store.selected).toBeNull()
      expect(store.selectedError).not.toBeNull()
    })
  })

  describe('the Colada cache entry (FE-166 step 2)', () => {
    it('a list seed is left stale and never replaces a loaded practice', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValueOnce(
        fakePractice({ id: 'p1', title: 'Loaded' }),
      )
      await usePracticesStore().fetchPractice('p1')

      seedPractices([
        fakePractice({ id: 'p1', title: 'From list' }),
        fakePractice({ id: 'p2', title: 'Seed' }),
      ])

      const cache = useQueryCache()
      expect(cache.getQueryData<PracticeResponse>(keys.practices.detail('p1'))?.title).toBe(
        'Loaded',
      )
      expect(cache.get(keys.practices.detail('p2'))?.when).toBe(0)
    })

    it('every entry carries the query options, so Colada can garbage-collect it', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(fakePractice({ id: 'p1' }))
      await usePracticesStore().fetchPractice('p1')
      seedPractices([fakePractice({ id: 'p2' })])

      const cache = useQueryCache()
      for (const id of ['p1', 'p2']) {
        expect(cache.get(keys.practices.detail(id))?.options?.gcTime, id).toBeGreaterThan(0)
      }
    })

    it('the route preload shares an answer already on its way and is reused by the screen', async () => {
      let resolve: (v: PracticeResponse) => void = () => {}
      vi.mocked(practicesApi.getPractice).mockReturnValueOnce(
        new Promise<PracticeResponse>((r) => {
          resolve = r
        }),
      )
      const first = prefetchPractice('p1')
      const second = prefetchPractice('p1')
      resolve(fakePractice({ id: 'p1', title: 'Preloaded' }))
      await Promise.all([first, second])
      expect(practicesApi.getPractice).toHaveBeenCalledTimes(1)

      const store = usePracticesStore()
      await store.openPractice('p1')
      expect(store.selected?.title).toBe('Preloaded')
      expect(practicesApi.getPractice).toHaveBeenCalledTimes(1)
    })

    it('an answer landing after the session ended is not written to the cache', async () => {
      let resolve: (v: PracticeResponse) => void = () => {}
      vi.mocked(practicesApi.getPractice).mockReturnValueOnce(
        new Promise<PracticeResponse>((r) => {
          resolve = r
        }),
      )
      const store = usePracticesStore()
      const pending = store.fetchPractice('p1')
      store.$reset()
      resolve(fakePractice({ id: 'p1' }))
      await pending

      expect(useQueryCache().getQueryData(keys.practices.detail('p1'))).toBeUndefined()
      expect(store.selected).toBeNull()
    })

    it('a practice detail outlives the Colada default of 5 min in memory (30 min gcTime)', async () => {
      vi.mocked(practicesApi.getPractice).mockResolvedValue(fakePractice({ id: 'p1' }))
      await usePracticesStore().fetchPractice('p1')

      expect(useQueryCache().get(keys.practices.detail('p1'))?.options?.gcTime).toBe(30 * 60_000)
    })

    it('a failed preload never rejects', async () => {
      vi.mocked(practicesApi.getPractice).mockRejectedValueOnce(new Error('offline'))
      await expect(prefetchPractice('p1')).resolves.toBeUndefined()
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
