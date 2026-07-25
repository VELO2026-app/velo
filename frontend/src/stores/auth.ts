// =============================================================================
// VELO Frontend -- Auth Store (Phase F1.3, fixed 10.2, QW-4, W-1)
// =============================================================================
//
// FIX 10.2: registers onUnauthorized callback with API client.
// QW-4: role returns null (not 'user') for unauthenticated users.
// W-1: logout() resets masterStore to prevent data leak between sessions.
//
// Profile reads/writes go through api/users.ts wrappers (getMe / updateMe)
// instead of inline api.get/patch calls, so the endpoint path lives in one
// place. updateProfile() is used by the profile screen and by the welcome
// onboarding flow to persist { timezone, onboarding_completed }.
// =============================================================================

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api, setAuthToken, setOnUnauthorized, ApiResponseError } from '@/api/client'
import { getMe, updateMe, switchRole as apiSwitchRole } from '@/api/users'
import { platform } from '@/platform'
import type {
  AuthResponse,
  MasterApplicationInfo,
  RoleSwitchInfo,
  UserResponse,
  UserRole,
  UserUpdate,
} from '@/api/types'

const TOKEN_KEY = 'velo_token'

export const useAuthStore = defineStore('auth', () => {
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
  // admins — no feature flag). Read structurally (generated.ts may not carry
  // the field locally yet). The settings UI shows a switch button per allowed
  // role except the current one.
  const allowedRoles = computed<UserRole[]>(() => {
    const rs = (user.value as { role_switch?: RoleSwitchInfo | null } | null)?.role_switch
    return rs?.allowed_roles ?? []
  })

  // T5: the user's master-application state (status + rejection reason), so a
  // rejected/pending role='user' applicant can see the verdict without the
  // master-only /masters/me endpoint. Same structural read as allowedRoles.
  const masterApplication = computed<MasterApplicationInfo | null>(() => {
    return (
      (user.value as { master_application?: MasterApplicationInfo | null } | null)
        ?.master_application ?? null
    )
  })

  function _setToken(newToken: string | null): void {
    token.value = newToken
    setAuthToken(newToken)
    if (newToken) {
      sessionStorage.setItem(TOKEN_KEY, newToken)
    } else {
      sessionStorage.removeItem(TOKEN_KEY)
    }
  }

  function _setUser(newUser: UserResponse | null): void {
    user.value = newUser
  }

  /** Clear all auth state (used by 401 handler and logout). */
  function _clearSession(): void {
    _setToken(null)
    _setUser(null)
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

  async function restoreSession(): Promise<boolean> {
    const savedToken = sessionStorage.getItem(TOKEN_KEY)
    if (!savedToken) return false

    _setToken(savedToken)
    loading.value = true
    try {
      const me = await getMe()
      _setUser(me)
      return true
    } catch {
      _clearSession()
      return false
    } finally {
      loading.value = false
    }
  }

  /**
   * Refetch /users/me and write the result into the store -- UNLESS the
   * session this call started under is no longer the current one by the
   * time it resolves (ПРОМТ №550, closing a ПРОМТ №549 adversarial finding).
   *
   * Pre-existing gap, only reachable in practice since T21-4/T21-5: before
   * useRoleFreshness.ts (ПРОМТ №546) started calling this on every
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
   */
  async function fetchMe(): Promise<void> {
    if (!token.value) return
    const requestToken = token.value
    try {
      const me = await getMe()
      // The token changed (cleared by logout, or a new session started)
      // while this request was in flight -- the session it was fetched for
      // is gone. Discard the result instead of writing it into whatever
      // session is current now.
      if (token.value !== requestToken) return
      _setUser(me)
    } catch (error) {
      if (error instanceof ApiResponseError && error.status === 401) {
        _clearSession()
      }
    }
  }

  /**
   * Update the current user's profile and store the fresh result.
   *
   * Returns the updated user on success. Throws on failure so callers
   * (e.g. the onboarding finish handler) can keep the user on the screen
   * and show an error instead of advancing as if it saved.
   */
  async function updateProfile(body: UserUpdate): Promise<UserResponse> {
    const updated = await updateMe(body)
    _setUser(updated)
    return updated
  }

  /**
   * Switch the current account's role (TEST-ONLY tester tool) and store the
   * fresh profile. Throws on failure so the caller can show an error and stay
   * put. Navigation to the new role's dashboard is the caller's job.
   */
  async function switchRole(target: UserRole): Promise<UserResponse> {
    const updated = await apiSwitchRole(target)
    _setUser(updated)
    return updated
  }

  async function logout(): Promise<void> {
    // W-1: reset master store before clearing session to prevent stale
    // profile/practices data leaking to the next user session.
    // Dynamic import breaks the potential circular dep auth -> master -> auth.
    const { useMasterStore } = await import('@/stores/master')
    useMasterStore().$reset()

    // T21-4/T21-5 (ПРОМТ №546): stop the foreground role-freshness poll so it
    // doesn't keep ticking a fetchMe() against a session that's about to be
    // cleared. Dynamic import, same circular-dep reasoning as above.
    const { stopRoleFreshnessPoll } = await import('@/composables/useRoleFreshness')
    stopRoleFreshnessPoll()

    // In Telegram, "logout" closes the Mini App (product decision): on the
    // next open it starts fresh -> LoadingView -> auto re-login via initData.
    // Arm the logging-out gate FIRST so the App.vue gate shows LoadingView
    // during the brief window between _clearSession() (isAuthenticated -> false)
    // and the Mini App actually closing -- otherwise it would flash the
    // StandaloneStubView ("Open via Telegram"). Dynamic import breaks the
    // circular dep auth -> useAuth -> auth (same pattern as the master store).
    const inTelegram = platform.name === 'telegram'
    if (inTelegram) {
      const { beginLogout } = await import('@/composables/useAuth')
      beginLogout()
    }

    try {
      await api.post('/api/v1/auth/logout')
    } catch {
      // Ignore -- logging out anyway.
    } finally {
      _clearSession()
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
    fetchMe,
    updateProfile,
    switchRole,
    logout,
  }
})
