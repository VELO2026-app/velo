// =============================================================================
// VELO Frontend -- useRoleFreshness Unit Tests (T21-4/T21-5, ПРОМТ №546)
// =============================================================================
//
// Module-level singleton state (lastFetchAt, pollHandle, visibilityHandler),
// same shape as useAuth.ts's isReady -- reset via __resetRoleFreshnessForTest
// in beforeEach, mirroring useAuth.ts's resetAuthState() seam.
//
// authStore.fetchMe is spied on the REAL Pinia store (not a wholesale store
// mock) so refreshRoleIfStale's own debounce logic is what's under test, not
// a re-implementation of it.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import {
  refreshRoleIfStale,
  startRoleFreshnessPoll,
  stopRoleFreshnessPoll,
  __resetRoleFreshnessForTest,
} from '@/composables/useRoleFreshness'

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    configurable: true,
  })
}

describe('useRoleFreshness', () => {
  let fetchMe: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    setActivePinia(createPinia())
    fetchMe = vi.spyOn(useAuthStore(), 'fetchMe').mockResolvedValue(undefined)
    __resetRoleFreshnessForTest()
    setVisibility('visible')
  })

  afterEach(() => {
    __resetRoleFreshnessForTest()
    vi.useRealTimers()
    fetchMe.mockRestore()
  })

  describe('refreshRoleIfStale (debounce)', () => {
    it('fetches on the first call', async () => {
      await refreshRoleIfStale()
      expect(fetchMe).toHaveBeenCalledTimes(1)
    })

    it('a second call immediately after does NOT fetch again (still within the debounce window)', async () => {
      await refreshRoleIfStale()
      await refreshRoleIfStale()
      await refreshRoleIfStale()
      expect(fetchMe).toHaveBeenCalledTimes(1)
    })

    it('fetches again once the debounce window has passed', async () => {
      vi.useFakeTimers()
      await refreshRoleIfStale()
      expect(fetchMe).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(15_001) // NAV_REFRESH_DEBOUNCE_MS + 1
      await refreshRoleIfStale()
      expect(fetchMe).toHaveBeenCalledTimes(2)
    })

    it('does not fetch again one millisecond before the window elapses', async () => {
      vi.useFakeTimers()
      await refreshRoleIfStale()
      vi.advanceTimersByTime(14_999)
      await refreshRoleIfStale()
      expect(fetchMe).toHaveBeenCalledTimes(1)
    })
  })

  describe('foreground poll', () => {
    it('ticks fetchMe on the poll interval while visible', () => {
      vi.useFakeTimers()
      startRoleFreshnessPoll()
      expect(fetchMe).toHaveBeenCalledTimes(0) // starting the poll itself does not fetch immediately

      vi.advanceTimersByTime(30_000) // FOREGROUND_POLL_INTERVAL_MS
      expect(fetchMe).toHaveBeenCalledTimes(1)
    })

    it('stops ticking once backgrounded (visibilitychange -> hidden)', () => {
      vi.useFakeTimers()
      startRoleFreshnessPoll()
      vi.advanceTimersByTime(30_000)
      expect(fetchMe).toHaveBeenCalledTimes(1)

      setVisibility('hidden')
      document.dispatchEvent(new Event('visibilitychange'))

      // Advance well past several would-be intervals -- must stay flat.
      vi.advanceTimersByTime(120_000)
      expect(fetchMe).toHaveBeenCalledTimes(1)
    })

    it('refetches immediately on resuming to the foreground, then resumes ticking', () => {
      vi.useFakeTimers()
      startRoleFreshnessPoll()
      setVisibility('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
      expect(fetchMe).toHaveBeenCalledTimes(0)

      setVisibility('visible')
      document.dispatchEvent(new Event('visibilitychange'))
      expect(fetchMe).toHaveBeenCalledTimes(1) // the resume-check itself fetched

      // The poll interval (30s) is longer than the nav-debounce window (15s),
      // so the next scheduled tick fetches again rather than being absorbed.
      vi.advanceTimersByTime(30_000)
      expect(fetchMe).toHaveBeenCalledTimes(2)
    })

    it('does not start ticking at all if the app is already backgrounded when started', () => {
      vi.useFakeTimers()
      setVisibility('hidden')
      startRoleFreshnessPoll()
      vi.advanceTimersByTime(60_000)
      expect(fetchMe).toHaveBeenCalledTimes(0)
    })

    it('stopRoleFreshnessPoll (logout) stops the interval without needing a visibilitychange', () => {
      vi.useFakeTimers()
      startRoleFreshnessPoll()
      stopRoleFreshnessPoll()
      vi.advanceTimersByTime(120_000)
      expect(fetchMe).toHaveBeenCalledTimes(0)
    })

    it('calling startRoleFreshnessPoll twice does not double the interval (idempotent)', () => {
      vi.useFakeTimers()
      startRoleFreshnessPoll()
      startRoleFreshnessPoll()
      vi.advanceTimersByTime(30_000)
      expect(fetchMe).toHaveBeenCalledTimes(1) // one tick, not two
    })
  })
})
