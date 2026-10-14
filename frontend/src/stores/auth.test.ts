// =============================================================================
// VELO Frontend -- stores/auth.ts Unit Tests (T1 stage 2 -- harness + stores)
// =============================================================================
//
// Covers loginViaTelegram, restoreSession, logout -- per the ranked T1 plan,
// sequenced after stores/bookings.ts since this store carries the most
// incidental complexity relative to its money-criticality: a dynamic
// @/composables/useAuth import inside logout(), a dynamic @/stores/master
// import, and storage side effects.
//
// Standalone phase 3: the token's carrier is the PLATFORM's call
// (platform/session-token.ts) -- sessionStorage in Telegram, localStorage
// outside. The @/platform mock below wires the REAL sessionTokenStore to
// each carrier by platformName, so these tests assert the actual storage a
// platform writes, not a stand-in.
//
// @/composables/useAuth is mocked WHOLESALE (not partially) specifically so
// the real module -- which imports useAuthStore from @/stores/auth at module
// scope, and owns the module-level `isReady` singleton behind
// waitUntilReady() -- is never evaluated. That singleton/seam is the stage-3
// blocker (router guards); mocking the whole module here sidesteps it
// entirely rather than working around it, so nothing from stage 3 leaks in.
//
// loginViaTelegram calls `api.post` directly (no api/*.ts wrapper), so it is
// mocked at the @/api/client seam, same pattern as the stage-1 wrapper tests.
// restoreSession/fetchMe go through @/api/users -- mocked there instead.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { api, ApiNetworkError, ApiResponseError } from '@/api/client'
import * as usersApi from '@/api/users'
import type { AuthResponse, UserResponse } from '@/api/types'

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>()
  return {
    ...actual,
    api: {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  }
})

vi.mock('@/api/users')

const masterReset = vi.fn()
vi.mock('@/stores/master', () => ({
  useMasterStore: () => ({ $reset: masterReset }),
}))

const beginLogout = vi.fn()
vi.mock('@/composables/useAuth', () => ({ beginLogout }))

const platformClose = vi.fn()
let platformName: 'telegram' | 'standalone' = 'standalone'
vi.mock('@/platform', async () => {
  const { sessionTokenStore } = await import('@/platform/session-token')
  const carriers = {
    telegram: sessionTokenStore(() => sessionStorage),
    standalone: sessionTokenStore(() => localStorage),
  }
  return {
    get platform() {
      return {
        name: platformName,
        close: platformClose,
        readSessionToken: () => carriers[platformName].read(),
        writeSessionToken: (token: string | null) => carriers[platformName].write(token),
      }
    },
  }
})

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

describe('useAuthStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStorage.clear()
    localStorage.clear()
    vi.mocked(api.post).mockReset()
    vi.mocked(usersApi.getMe).mockReset()
    masterReset.mockReset()
    beginLogout.mockReset()
    platformClose.mockReset()
    platformName = 'standalone'
  })

  // initData sign-in runs only inside Telegram, so these run on the telegram
  // platform. They ran on the default (standalone) before Standalone phase 3,
  // when one carrier (sessionStorage) served both platforms; the assertions
  // on sessionStorage were right then and are right now for Telegram.
  describe('loginViaTelegram', () => {
    beforeEach(() => {
      platformName = 'telegram'
    })

    it('on success: sets token + user, persists the token, returns true', async () => {
      const response: AuthResponse = { session_token: 'tok_1', user: fakeUser() }
      vi.mocked(api.post).mockResolvedValue(response)
      const store = useAuthStore()

      const result = await store.loginViaTelegram('init_data_payload')

      expect(result).toBe(true)
      expect(api.post).toHaveBeenCalledWith('/api/v1/auth/telegram', {
        init_data: 'init_data_payload',
      })
      expect(store.token).toBe('tok_1')
      expect(store.user).toEqual(fakeUser())
      expect(sessionStorage.getItem('velo_token')).toBe('tok_1')
      // Telegram never writes the persistent carrier (session-token.ts).
      expect(localStorage.getItem('velo_token')).toBeNull()
      expect(store.isAuthenticated).toBe(true)
    })

    it('on failure: clears session and returns false', async () => {
      vi.mocked(api.post).mockRejectedValue(new Error('expired initData'))
      const store = useAuthStore()

      const result = await store.loginViaTelegram('stale_init_data')

      expect(result).toBe(false)
      expect(store.token).toBeNull()
      expect(store.user).toBeNull()
      expect(sessionStorage.getItem('velo_token')).toBeNull()
    })
  })

  // Standalone phase 3 (gate R6): restoreSession reports HOW it ended instead
  // of a boolean. The old "getMe fails -> clears session, false" was right
  // for any failure when a token lived one Mini App run; with a 30-day token
  // in localStorage it would throw the sign-in away on a network blip. It is
  // now split: 401/403 still clear (rejected), no answer keeps the token
  // (unreachable).
  describe('restoreSession', () => {
    it('no saved token: none, without calling getMe', async () => {
      const store = useAuthStore()

      const result = await store.restoreSession()

      expect(result).toBe('none')
      expect(usersApi.getMe).not.toHaveBeenCalled()
    })

    it('saved token + getMe succeeds: restores token + user', async () => {
      localStorage.setItem('velo_token', 'saved_tok')
      vi.mocked(usersApi.getMe).mockResolvedValue(fakeUser({ id: 'user_2' }))
      const store = useAuthStore()

      const result = await store.restoreSession()

      expect(result).toBe('restored')
      expect(store.token).toBe('saved_tok')
      expect(store.user).toEqual(fakeUser({ id: 'user_2' }))
    })

    it('saved token + 401: rejected, session cleared, token removed from storage', async () => {
      localStorage.setItem('velo_token', 'stale_tok')
      vi.mocked(usersApi.getMe).mockRejectedValue(new ApiResponseError(401, 'Session expired', 'unauthorized'))
      const store = useAuthStore()

      const result = await store.restoreSession()

      expect(result).toBe('rejected')
      expect(store.token).toBeNull()
      expect(localStorage.getItem('velo_token')).toBeNull()
    })

    it('saved token + 403 (deactivated account): rejected, token removed', async () => {
      localStorage.setItem('velo_token', 'tok_of_disabled')
      vi.mocked(usersApi.getMe).mockRejectedValue(new ApiResponseError(403, 'Account is deactivated', 'account_deactivated'))
      const store = useAuthStore()

      expect(await store.restoreSession()).toBe('rejected')
      expect(localStorage.getItem('velo_token')).toBeNull()
    })

    it('saved token + no answer: unreachable, NOT signed in, token KEPT for the next launch', async () => {
      localStorage.setItem('velo_token', 'good_tok')
      vi.mocked(usersApi.getMe).mockRejectedValue(new ApiNetworkError())
      const store = useAuthStore()

      const result = await store.restoreSession()

      expect(result).toBe('unreachable')
      expect(store.isAuthenticated).toBe(false)
      expect(store.token).toBeNull()
      expect(localStorage.getItem('velo_token')).toBe('good_tok')
    })

    it('saved token + 5xx: unreachable, token kept', async () => {
      localStorage.setItem('velo_token', 'good_tok')
      vi.mocked(usersApi.getMe).mockRejectedValue(new ApiResponseError(502, 'Bad gateway', 'bad_gateway'))
      const store = useAuthStore()

      expect(await store.restoreSession()).toBe('unreachable')
      expect(localStorage.getItem('velo_token')).toBe('good_tok')
    })

    it('Telegram reads its own carrier, never the persistent one', async () => {
      platformName = 'telegram'
      localStorage.setItem('velo_token', 'browser_tok')
      const store = useAuthStore()

      expect(await store.restoreSession()).toBe('none')
      expect(usersApi.getMe).not.toHaveBeenCalled()
    })
  })

  describe('logout', () => {
    it('standalone: resets master store, posts logout, clears session, does NOT touch the Telegram gate', async () => {
      platformName = 'standalone'
      vi.mocked(api.post).mockResolvedValue(undefined)
      localStorage.setItem('velo_token', 'tok')
      const store = useAuthStore()
      store.token = 'tok'
      store.user = fakeUser()

      await store.logout()

      expect(masterReset).toHaveBeenCalledTimes(1)
      expect(api.post).toHaveBeenCalledWith('/api/v1/auth/logout')
      expect(store.token).toBeNull()
      expect(store.user).toBeNull()
      // Standalone phase 3, item 6: the persistent token is gone too.
      expect(localStorage.getItem('velo_token')).toBeNull()
      expect(beginLogout).not.toHaveBeenCalled()
      expect(platformClose).not.toHaveBeenCalled()
    })

    it('Telegram: arms the logout gate BEFORE clearing session, then closes the Mini App', async () => {
      platformName = 'telegram'
      vi.mocked(api.post).mockResolvedValue(undefined)
      const store = useAuthStore()
      store.token = 'tok'
      store.user = fakeUser()

      await store.logout()

      expect(beginLogout).toHaveBeenCalledTimes(1)
      expect(masterReset).toHaveBeenCalledTimes(1)
      expect(store.token).toBeNull()
      expect(platformClose).toHaveBeenCalledTimes(1)
    })

    it('clears session even when the logout POST fails (best-effort)', async () => {
      platformName = 'standalone'
      vi.mocked(api.post).mockRejectedValue(new Error('network error'))
      const store = useAuthStore()
      store.token = 'tok'
      store.user = fakeUser()

      await store.logout()

      expect(store.token).toBeNull()
      expect(store.user).toBeNull()
    })
  })

  // -- PROMPT №550: logout race (PROMPT №549 adversarial finding) --------------
  // fetchMe() now runs routinely (useRoleFreshness.ts -- every navigation,
  // every 30s foregrounded), not just at boot, so a call already in flight
  // when logout() fires is a real, not theoretical, timing window. Before
  // this fix, fetchMe() checked the token only at entry and wrote
  // unconditionally on success -- a stale response landing after
  // _clearSession() would resurrect a cleared session's user.
  describe('fetchMe', () => {
    it('discards a response that resolves AFTER logout -- does not repopulate the store', async () => {
      const store = useAuthStore()
      store.token = 'tok_1'
      store.user = fakeUser()

      // getMe() is deliberately left unresolved -- simulates a request still
      // in flight at the moment logout() runs.
      let resolveGetMe: (user: UserResponse) => void = () => {}
      vi.mocked(usersApi.getMe).mockImplementation(
        () =>
          new Promise<UserResponse>((resolve) => {
            resolveGetMe = resolve
          }),
      )
      const fetchPromise = store.fetchMe()

      // Logout completes WHILE the fetch above is still pending.
      vi.mocked(api.post).mockResolvedValue(undefined)
      await store.logout()
      expect(store.token).toBeNull()
      expect(store.user).toBeNull()

      // NOW the stale request resolves, with a user for a session that no
      // longer exists.
      resolveGetMe(fakeUser({ id: 'resurrected_user' }))
      await fetchPromise

      // If fetchMe() still wrote unconditionally (the reverted behavior),
      // user/token would be resurrected here even though logout cleared them.
      expect(store.user).toBeNull()
      expect(store.token).toBeNull()
    })

    it('still writes the result for a request that resolves BEFORE anything else changes the session', async () => {
      const store = useAuthStore()
      store.token = 'tok_1'
      store.user = fakeUser()
      vi.mocked(usersApi.getMe).mockResolvedValue(fakeUser({ id: 'refreshed_user' }))

      await store.fetchMe()

      expect(store.user).toEqual(fakeUser({ id: 'refreshed_user' }))
      expect(store.token).toBe('tok_1')
    })
  })
})
