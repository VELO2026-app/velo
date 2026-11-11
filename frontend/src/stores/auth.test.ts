// =============================================================================
// VELO Frontend -- stores/auth.ts Unit Tests (T1 stage 2 -- harness + stores)
// =============================================================================
//
// Covers loginViaTelegram, restoreSession, logout -- per the ranked T1 plan,
// sequenced after stores/bookings.ts since this store carries the most
// incidental complexity relative to its money-criticality: storage side
// effects and the session-end announcement (platform/session.ts).
//
// FE-157: the end of a session resets the other stores through the account
// scope (platform/session.ts), so the Pinia here is installed in an app with
// accountScopePlugin -- the way app.ts installs it -- and the resets are
// asserted on the REAL stores. Every store against the contract, over the
// real client's 401, lives in stores/session-reset.test.ts.
//
// Standalone phase 3: the token's carrier is the PLATFORM's call
// (platform/session-token.ts) -- sessionStorage in Telegram, localStorage
// outside. The @/platform mock below wires the REAL sessionTokenStore to
// each carrier by platformName, so these tests assert the actual storage a
// platform writes, not a stand-in.
//
// The composables that react to the session ending (the Telegram logout gate,
// the role-freshness poll) subscribe through onSessionEnd; their half is in
// composables/session-end.test.ts.
//
// loginViaTelegram calls `api.post` directly (no api/*.ts wrapper), so it is
// mocked at the @/api/client seam, same pattern as the stage-1 wrapper tests.
// restoreSession/fetchMe go through @/api/users -- mocked there instead.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { useMasterStore } from '@/stores/master'
import { useBookingsStore } from '@/stores/bookings'
import { accountScopePlugin } from '@/platform/session'
import { flushPersisted, readPersisted, writePersisted } from '@/composables/persistedCache'
import { api, ApiNetworkError, ApiResponseError } from '@/api/client'
import * as usersApi from '@/api/users'
import type { AuthResponse, MasterProfileResponse, UserResponse } from '@/api/types'

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

/** Put account data into the stores the old hand-kept reset lists covered. */
function fillAccountStores(): void {
  const master = useMasterStore()
  master.profile = { id: 'master_1' } as unknown as MasterProfileResponse
  master.profileLoaded = true
  const bookings = useBookingsStore()
  bookings.dismissCheckin('practice_1')
}

/** The same stores are back to their initial state. */
function expectAccountStoresReset(): void {
  const master = useMasterStore()
  expect(master.profile).toBeNull()
  expect(master.profileLoaded).toBe(false)
  const bookings = useBookingsStore()
  expect(bookings.dismissedCheckins).toEqual([])
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

describe('useAuthStore', () => {
  beforeEach(() => {
    // Pinia runs plugins only once installed in an app (as in app.ts).
    const pinia = createPinia().use(accountScopePlugin)
    createApp({}).use(pinia)
    setActivePinia(pinia)
    sessionStorage.clear()
    localStorage.clear()
    vi.mocked(api.post).mockReset()
    vi.mocked(usersApi.getMe).mockReset()
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
      vi.mocked(usersApi.getMe).mockRejectedValue(
        new ApiResponseError(401, 'Session expired', 'unauthorized'),
      )
      const store = useAuthStore()

      const result = await store.restoreSession()

      expect(result).toBe('rejected')
      expect(store.token).toBeNull()
      expect(localStorage.getItem('velo_token')).toBeNull()
    })

    it('saved token + 403 (deactivated account): rejected, token removed', async () => {
      localStorage.setItem('velo_token', 'tok_of_disabled')
      vi.mocked(usersApi.getMe).mockRejectedValue(
        new ApiResponseError(403, 'Account is deactivated', 'account_deactivated'),
      )
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
      vi.mocked(usersApi.getMe).mockRejectedValue(
        new ApiResponseError(502, 'Bad gateway', 'bad_gateway'),
      )
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

  describe('persisted screen data', () => {
    it('belongs to the signed-in account and is wiped on logout', async () => {
      platformName = 'telegram'
      vi.mocked(api.post).mockResolvedValue({ session_token: 'tok_1', user: fakeUser() })
      const store = useAuthStore()
      await store.loginViaTelegram('init')
      writePersisted('bookings.upcoming', [{ id: 'b1' }])
      flushPersisted()
      expect(readPersisted('bookings.upcoming')?.data).toEqual([{ id: 'b1' }])

      platformName = 'standalone'
      vi.mocked(api.post).mockResolvedValue(undefined)
      await store.logout()
      expect(readPersisted('bookings.upcoming')).toBeUndefined()
      expect(Object.keys(sessionStorage).some((k) => k.startsWith('velo:screen-cache:'))).toBe(
        false,
      )
    })

    it('a refused restore resets the other stores with the session (W-1)', async () => {
      // The 401 path into _clearSession, not logout: before FE-157 it reset
      // only the bookings store, and that one asynchronously.
      localStorage.setItem('velo_token', 'tok')
      const store = useAuthStore()
      fillAccountStores()
      vi.mocked(usersApi.getMe).mockRejectedValue(
        new ApiResponseError(401, 'Session expired', 'unauthorized'),
      )

      await expect(store.restoreSession()).resolves.toBe('rejected')

      expectAccountStoresReset()
    })
  })

  describe('logout', () => {
    it('standalone: posts logout, clears session and every store, does NOT touch the Telegram gate', async () => {
      platformName = 'standalone'
      vi.mocked(api.post).mockResolvedValue(undefined)
      localStorage.setItem('velo_token', 'tok')
      const store = useAuthStore()
      store.token = 'tok'
      store.user = fakeUser()
      fillAccountStores()

      await store.logout()

      expectAccountStoresReset()
      expect(api.post).toHaveBeenCalledWith('/api/v1/auth/logout')
      expect(store.token).toBeNull()
      expect(store.user).toBeNull()
      // Standalone phase 3, item 6: the persistent token is gone too.
      expect(localStorage.getItem('velo_token')).toBeNull()
      expect(platformClose).not.toHaveBeenCalled()
    })

    it('Telegram: clears the session, then closes the Mini App (the gate: composables/session-end.test.ts)', async () => {
      platformName = 'telegram'
      vi.mocked(api.post).mockResolvedValue(undefined)
      const store = useAuthStore()
      store.token = 'tok'
      store.user = fakeUser()
      fillAccountStores()

      await store.logout()

      expectAccountStoresReset()
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

    it('a 401 for a token replaced while in flight does not end the new session', async () => {
      const store = useAuthStore()
      store.token = 'tok_1'
      store.user = fakeUser()
      let rejectGetMe: (error: unknown) => void = () => {}
      vi.mocked(usersApi.getMe).mockImplementation(
        () =>
          new Promise<UserResponse>((_resolve, reject) => {
            rejectGetMe = reject
          }),
      )
      const fetchPromise = store.fetchMe()

      // A new session takes over while the old token's /me is in flight.
      store.token = 'tok_2'
      store.user = fakeUser({ id: 'user_2' })
      fillAccountStores()
      rejectGetMe(new ApiResponseError(401, 'Session expired', 'unauthorized'))

      await expect(fetchPromise).resolves.toBe(true)
      expect(store.token).toBe('tok_2')
      expect(store.user?.id).toBe('user_2')
      expect(useMasterStore().profileLoaded).toBe(true)
    })

    it('a 401 for the current token ends the session and resets the stores', async () => {
      const store = useAuthStore()
      store.token = 'tok_1'
      store.user = fakeUser()
      fillAccountStores()
      vi.mocked(usersApi.getMe).mockRejectedValue(
        new ApiResponseError(401, 'Session expired', 'unauthorized'),
      )

      await expect(store.fetchMe()).resolves.toBe(true)

      expect(store.token).toBeNull()
      expect(store.user).toBeNull()
      expectAccountStoresReset()
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
