// =============================================================================
// VELO Frontend -- Auth Store (Phase F1.3, fixed 10.2, QW-4, W-1)
// =============================================================================
//
// FIX 10.2: registers onUnauthorized callback with API client.
// QW-4: role returns null (not 'user') for unauthenticated users.
// W-1 / FE-157: the end of a session (_clearSession -- logout, a 401 for the
// current token, a refused restore) resets EVERY other store through the
// account scope (platform/session.ts), so no account's data outlives it.
//
// Standalone phase 3: the session token is kept where the PLATFORM says
// (platform/session-token.ts -- localStorage outside Telegram, sessionStorage
// inside). Outside Telegram the person signs in with "Log In With Telegram":
// startBrowserLogin() leaves for Telegram's page, completeBrowserLogin() runs
// on the return (composables/useAuth.ts, initAuth).
//
// Profile reads/writes go through api/users.ts wrappers (getMe / updateMe)
// instead of inline api.get/patch calls, so the endpoint path lives in one
// place. updateProfile() is used by the profile screen and by the welcome
// onboarding flow to persist { timezone, onboarding_completed }.
// =============================================================================

import { defineStore, getActivePinia } from 'pinia'
import { replaceEqualDeep } from '@/utils/structuralShare'
import { ref, computed } from 'vue'
import { api, setAuthToken, setOnUnauthorized, ApiResponseError } from '@/api/client'
import { getMe, updateMe, switchRole as apiSwitchRole } from '@/api/users'
import { platform } from '@/platform'
import { clearPersisted, setPersistOwner } from '@/composables/persistedCache'
import { host } from '@/platform/host'
import { newMark, rememberLoginMark } from '@/platform/browser-login'
import { notifySessionEnd, resetAccountScope, type SessionEndReason } from '@/platform/session'
import type {
  AuthResponse,
  BrowserLoginResponse,
  BrowserLoginStartResponse,
  MasterApplicationInfo,
  UserResponse,
  UserRole,
  UserUpdate,
} from '@/api/types'

/**
 * How restoring a saved session ended (Standalone phase 3, gate item R6).
 *   restored    -- the token is good, the user is loaded;
 *   none        -- nothing was saved;
 *   rejected    -- the server refused the token (401) or the account
 *                  (403): the token is removed;
 *   unreachable -- no answer (network, timeout, 5xx): the token is KEPT.
 *                  A launch of the installed app without network must not
 *                  throw away a 30-day sign-in.
 */
export type RestoreOutcome = 'restored' | 'none' | 'rejected' | 'unreachable'

/** Id of the session owner store: the account-scope reset skips it, `_clearSession` clears it. */
const AUTH_STORE_ID = 'auth'

/** Session state: the signed-in user, the platform-owned token, login/restore and profile writes. */
export const useAuthStore = defineStore(AUTH_STORE_ID, () => {
  // The Pinia this store lives in: its account scope is what _clearSession
  // resets. Set for the whole of setup (Pinia activates it before calling it).
  const pinia = getActivePinia()

  const user = ref<UserResponse | null>(null)
  const token = ref<string | null>(null)
  const loading = ref(false)

  const isAuthenticated = computed(() => !!token.value && !!user.value)

  // QW-4: null for unauthenticated users, not 'user'. Prevents false
  // positives in v-if="role === 'user'" guards for anonymous visitors.
  const role = computed(() => user.value?.role ?? null)

  // Self role-switch: the roles this account may switch into, surfaced by the
  // backend in UserResponse.role_switch (capability-derived since №256: null
  // for plain users, [user, master] for verified masters, all three for
  // admins — no feature flag). The settings UI shows a switch button per
  // allowed role except the current one.
  const allowedRoles = computed<UserRole[]>(() => user.value?.role_switch?.allowed_roles ?? [])

  // T5: the user's master-application state (status + rejection reason), so a
  // rejected/pending role='user' applicant can see the verdict without the
  // master-only /masters/me endpoint.
  const masterApplication = computed<MasterApplicationInfo | null>(
    () => user.value?.master_application ?? null,
  )

  function _setToken(newToken: string | null): void {
    token.value = newToken
    setAuthToken(newToken)
    platform.writeSessionToken(newToken)
  }

  function _setUser(newUser: UserResponse | null): void {
    // Structural sharing: a /me poll answering the same user re-renders nothing.
    user.value = replaceEqualDeep(user.value, newUser)
    // Persisted screen data is per account: another account's copy goes.
    if (newUser) setPersistOwner(newUser.id)
  }

  /**
   * End the session: tell the `onSessionEnd` subscribers (composables with
   * module state), clear the token and user, the cached screen data, and
   * every other store (used by the 401 handler, logout and failed sign-ins).
   *
   * @param reason - `logout` when the person signed out, `dropped` otherwise.
   */
  function _clearSession(reason: SessionEndReason = 'dropped'): void {
    // First, before anything is cleared: the Telegram logout gate (useAuth)
    // and the role-freshness poll (useRoleFreshness) hook in here.
    notifySessionEnd(reason)
    _setToken(null)
    _setUser(null)
    // Cached screen data belongs to the account that fetched it: the copy
    // that survives reloads goes here, the Colada caches with the account
    // scope below (composables/queries/setup.ts, useQueryScopeStore).
    clearPersisted()
    setPersistOwner(null)
    // W-1 / FE-157: every other store goes back to its initial state, and
    // answers still in flight for this account land nowhere. Synchronous:
    // on a 401 it runs before the failing request's own catch.
    if (pinia) resetAccountScope(pinia, AUTH_STORE_ID)
  }

  // FIX 10.2: register callback so API client delegates 401 handling here.
  setOnUnauthorized(() => _clearSession())

  async function loginViaTelegram(initData: string): Promise<boolean> {
    loading.value = true
    try {
      const response = await api.post<AuthResponse>('/api/v1/auth/telegram', {
        init_data: initData,
      })
      _setToken(response.session_token)
      _setUser(response.user)
      return true
    } catch {
      // NEW-8: no console.error -- auth failure is a normal flow in production
      // (expired initData, banned user). Caller gets false and handles it.
      _clearSession()
      return false
    } finally {
      loading.value = false
    }
  }

  async function restoreSession(): Promise<RestoreOutcome> {
    const savedToken = platform.readSessionToken()
    if (!savedToken) return 'none'

    _setToken(savedToken)
    loading.value = true
    try {
      const me = await getMe()
      _setUser(me)
      return 'restored'
    } catch (error) {
      if (error instanceof ApiResponseError && (error.status === 401 || error.status === 403)) {
        _clearSession()
        return 'rejected'
      }
      // No answer about the token: keep it saved for the next attempt, but
      // this page is not signed in.
      token.value = null
      setAuthToken(null)
      _setUser(null)
      return 'unreachable'
    } finally {
      loading.value = false
    }
  }

  /**
   * Close `staleToken`'s session on the server, best-effort. The ONE place a
   * session this page is abandoning gets revoked (completeBrowserLogin,
   * discardSession): left alone it would stay live in Redis for the rest of
   * its 30 days with nobody holding it. A 401 (already gone) or no answer is
   * fine -- either way it is not this page's session any more. A 401 here
   * also fires the client's `onUnauthorized -> _clearSession`; the callers set
   * or clear the session themselves right after.
   */
  async function _revokeOnServer(staleToken: string): Promise<void> {
    setAuthToken(staleToken)
    try {
      await api.post('/api/v1/auth/logout')
    } catch {
      // Already gone (401) or unreachable -- it expires on its own.
    }
  }

  /**
   * Drop the session this page holds -- revoked on the server, forgotten
   * here -- WITHOUT logout()'s side effects (logout() closes the Mini App in
   * Telegram). Used when a restored session turns out not to belong to the
   * person who opened the app (useAuth.ts, initAuth).
   */
  async function discardSession(): Promise<void> {
    const current = token.value
    if (current) {
      await _revokeOnServer(current)
    }
    _clearSession()
  }

  /**
   * Browser sign-in, step 1: ask the backend for Telegram's URL, remember
   * `{ state, mark }` in this browser (platform/browser-login.ts) and leave
   * for Telegram.
   *
   * @throws The API error for the login screen to word.
   */
  async function startBrowserLogin(): Promise<void> {
    const mark = newMark()
    const started = await api.post<BrowserLoginStartResponse>(
      '/api/v1/auth/telegram/browser/start',
      { mark },
    )
    rememberLoginMark({ state: started.state, mark })
    host.location.assign(started.url)
  }

  /**
   * Browser sign-in, step 2 (on the return, after the mark matched): trade
   * Telegram's code for a session. A session already saved in this browser
   * -- the same account or another one -- is closed on the server first, so
   * it does not linger in Redis for the rest of its 30 days.
   *
   * @returns Whether THIS sign-in gave the bot the right to write.
   *
   * @throws The API error for the login screen to word; the saved session is
   *   then left as it was.
   */
  async function completeBrowserLogin(code: string, state: string, mark: string): Promise<boolean> {
    loading.value = true
    try {
      const response = await api.post<BrowserLoginResponse>(
        '/api/v1/auth/telegram/browser/complete',
        { code, state, mark, language: host.navigator.language || null },
      )
      const previous = platform.readSessionToken()
      if (previous && previous !== response.session_token) {
        await _revokeOnServer(previous)
      }
      _setToken(response.session_token)
      _setUser(response.user)
      return response.bot_access_granted
    } finally {
      loading.value = false
    }
  }

  /**
   * Refetch /users/me and write the result into the store -- UNLESS the
   * session this call started under is no longer the current one by the
   * time it resolves (PROMPT №550, closing a PROMPT №549 adversarial finding).
   *
   * Pre-existing gap, only reachable in practice since T21-4/T21-5: before
   * useRoleFreshness.ts (PROMPT №546) started calling this on every
   * navigation and every 30s while foregrounded, fetchMe() ran rarely enough
   * (app boot, one screen mounting) that a call landing after logout was a
   * near-impossible timing coincidence. Promoting it to a routine background
   * call is what makes the race actually reachable: logout() stops FUTURE
   * poll ticks (stopRoleFreshnessPoll) but cannot cancel a request already
   * in flight, and this function used to check the token only at entry --
   * an in-flight call that resolved after `_clearSession()` ran would still
   * unconditionally `_setUser(me)`, resurrecting a stale user (and the role/
   * masterApplication computeds derived from it) into a session that had
   * already logged out or moved on.
   *
   * @returns Whether the attempt REACHED A DEFINITIVE OUTCOME (B2, PROMPT
   *   №724): no token / a successful fetch / a discarded-by-race fetch / a 401
   *   all resolve `true` -- each is a real answer, not something worth retrying
   *   sooner. Only a genuine transport failure (network blip, 5xx, anything
   *   this function does not recognise) resolves `false`. useRoleFreshness.ts
   *   uses this to decide whether the debounce/poll window may advance --
   *   before this, the window advanced unconditionally and a single failed
   *   attempt silently ate the whole staleness window with no retry.
   */
  async function fetchMe(): Promise<boolean> {
    if (!token.value) return true
    const requestToken = token.value
    try {
      const me = await getMe()
      // The token changed (cleared by logout, or a new session started)
      // while this request was in flight -- the session it was fetched for
      // is gone. Discard the result instead of writing it into whatever
      // session is current now. The round trip itself succeeded, so this
      // still counts as a definitive outcome, not a failure to retry.
      if (token.value !== requestToken) return true
      _setUser(me)
      return true
    } catch (error) {
      if (error instanceof ApiResponseError && error.status === 401) {
        // A 401 for a token that is no longer current says nothing about the
        // session the page holds now (the client skips it the same way).
        if (token.value === requestToken) _clearSession()
        return true
      }
      // Transport failure (network/5xx/unrecognised) -- no definitive answer
      // was reached. Caller should not treat this as a fresh fetch.
      return false
    }
  }

  /**
   * Update the current user's profile and store the fresh result.
   *
   * @returns The updated user on success.
   *
   * @throws On failure, so callers (e.g. the onboarding finish handler) can
   *   keep the user on the screen and show an error instead of advancing as
   *   if it saved.
   */
  async function updateProfile(body: UserUpdate): Promise<UserResponse> {
    const updated = await updateMe(body)
    _setUser(updated)
    return updated
  }

  /**
   * Switch the current account's role (TEST-ONLY tester tool) and store the
   * fresh profile. Navigation to the new role's dashboard is the caller's
   * job.
   *
   * @throws On failure, so the caller can show an error and stay put.
   */
  async function switchRole(target: UserRole): Promise<UserResponse> {
    const updated = await apiSwitchRole(target)
    _setUser(updated)
    return updated
  }

  /**
   * Sign out: revoke the session on the server (best-effort), then end it
   * here -- `_clearSession` resets every store (W-1). In Telegram this also
   * closes the Mini App.
   */
  async function logout(): Promise<void> {
    // In Telegram, "logout" closes the Mini App (product decision): on the
    // next open it starts fresh -> LoadingView -> auto re-login via initData.
    // Arm the logging-out gate FIRST so the App.vue gate shows LoadingView
    // during the brief window between _clearSession() (isAuthenticated -> false)
    // and the Mini App actually closing -- otherwise it would flash the
    // TelegramStubView ("Open via Telegram"). Outside Telegram there is
    // nothing to close: the cleared session puts the login screen up, and
    // the token is gone from storage (_setToken). useAuth arms the gate and
    // useRoleFreshness stops its poll (T21-4/T21-5) through onSessionEnd when
    // _clearSession('logout') announces the end -- before anything is cleared.
    const inTelegram = platform.name === 'telegram'

    try {
      await api.post('/api/v1/auth/logout')
    } catch {
      // Ignore -- logging out anyway.
    } finally {
      _clearSession('logout')
      if (inTelegram) {
        // close() returns the user to the chat. Wrapped in try/catch so a
        // missing SDK (getWebApp throws) degrades to the previous behaviour
        // instead of breaking logout. Standalone close() is a no-op, so we
        // only call it in Telegram.
        try {
          platform.close()
        } catch {
          // SDK unavailable -- fall back silently; gate handles the rest.
        }
      }
    }
  }

  return {
    user,
    token,
    loading,
    isAuthenticated,
    role,
    allowedRoles,
    masterApplication,
    loginViaTelegram,
    restoreSession,
    startBrowserLogin,
    completeBrowserLogin,
    discardSession,
    fetchMe,
    updateProfile,
    switchRole,
    logout,
  }
})
