// =============================================================================
// VELO Frontend -- useAuth Composable (Phase F1.3, fixed 10.4, BUG-role-redirect, TD-F01)
// =============================================================================
//
// FIX 10.4: isReady/isStandalone are reactive refs inside composable scope,
// but shared via module-level refs (Vue pattern for singleton composables).
// Testable: reset by calling initAuth() in test setup.
//
// BUG-role-redirect: Vue Router is created and begins its first navigation
// before App.vue mounts and calls initAuth(). This means roleRedirect fires
// while auth.role is still null, and every user is sent to /user/dashboard.
// Fix: export waitUntilReady() so roleRedirect can await auth completion
// before reading auth.role.
//
// WARNING-3: waitUntilReady() now returns { ok, timedOut } so callers can
// distinguish a clean ready from a timeout and act accordingly (e.g. redirect
// to /auth-error instead of reading a null role).
//
// TD-F01: Deep link handling.
// After auth, read platform.getStartParam() and parse open_practice__{uuid}.
// Store the target route in pendingDeepLink so roleRedirect can consume it.
// pendingDeepLink is cleared after first use to prevent stale redirects.
// =============================================================================

import { ref, computed, watch } from 'vue'
import { platform } from '@/platform'
import { useAuthStore } from '@/stores/auth'

/** Whether auth initialization has completed. */
const isReady = ref(false)

/** Whether we're in standalone mode (no Telegram initData). */
const isStandalone = ref(false)

/**
 * Whether a logout is in progress (Telegram only).
 *
 * Set the instant logout() starts clearing the session and kept true until
 * the Mini App actually closes. The App.vue gate shows LoadingView while this
 * is true, so the brief window between _clearSession() (isAuthenticated -> false)
 * and platform.close() never falls through to StandaloneStubView. Without it,
 * a reactive tick could flash the "Open via Telegram" stub before the app closes.
 */
const isLoggingOut = ref(false)

/** Begin the logout transition: gate shows LoadingView, not the stub. */
export function beginLogout(): void {
  isLoggingOut.value = true
}

/**
 * Pending deep link route from startapp parameter (TD-F01).
 * Consumed once by roleRedirect, then cleared.
 * Format: { name: string, params?: Record<string, string> }
 */
export const pendingDeepLink = ref<{ name: string; params?: Record<string, string> } | null>(null)

/** Timeout for waitUntilReady() in milliseconds (P-3). */
const READY_TIMEOUT_MS = 10_000

/**
 * Parse the Telegram startapp parameter into a router location.
 * Returns null if the parameter is absent or unrecognized.
 *
 * Supported formats:
 *   open_practice__{uuid}       -> { name: 'practice-detail', params: { id } }
 *   master_onboarding__{token}  -> { name: 'master-invite', params: { token } }
 *   group_invite__{token}       -> { name: 'group-join', params: { token } } (P4, ПРОМТ №593)
 */
export function parseStartParam(
  startParam: string | null,
): { name: string; params?: Record<string, string> } | null {
  if (!startParam) return null

  const practiceMatch = startParam.match(/^open_practice__([0-9a-f-]{36})$/)
  if (practiceMatch?.[1]) {
    return { name: 'practice-detail', params: { id: practiceMatch[1] } }
  }

  // Batch-INVITE (№258): one-time master invite link issued by an admin.
  // Token charset = secrets.token_urlsafe (url-safe base64); length-bounded
  // to match the backend's ClaimMasterInviteRequest (16..128).
  const inviteMatch = startParam.match(/^master_onboarding__([A-Za-z0-9_-]{16,128})$/)
  if (inviteMatch?.[1]) {
    return { name: 'master-invite', params: { token: inviteMatch[1] } }
  }

  // Group invite (P4, №593): a master's reusable group link. Same token
  // charset/length bound as above -- both are secrets.token_urlsafe(32)
  // outputs, matching JoinGroupRequest.token (groups_schemas.py: 16..128).
  const groupInviteMatch = startParam.match(/^group_invite__([A-Za-z0-9_-]{16,128})$/)
  if (groupInviteMatch?.[1]) {
    return { name: 'group-join', params: { token: groupInviteMatch[1] } }
  }

  return null
}

/**
 * Reset auth state (for testing).
 */
export function resetAuthState(): void {
  isReady.value = false
  isStandalone.value = false
  isLoggingOut.value = false
  pendingDeepLink.value = null
}

/**
 * TEST-ONLY. Force `isReady` without running the real initAuth() bootstrap
 * (network/platform.init()/auth store calls). Router-guard tests need to
 * control waitUntilReady()'s resolution synchronously; this is the only
 * seam for that. Never call from production code -- there is no legitimate
 * production reason to set readiness without actually being ready.
 */
export function __setReadyForTest(ready: boolean): void {
  isReady.value = ready
}

/** Result returned by waitUntilReady(). */
export interface ReadyResult {
  /** True if auth completed normally before the timeout. */
  ok: boolean
  /** True if the 10s timeout fired before initAuth() finished. */
  timedOut: boolean
}

/**
 * Returns a Promise that resolves once isReady becomes true.
 * If isReady is already true, resolves immediately with { ok: true, timedOut: false }.
 *
 * WARNING-3: races against a 10s timeout and now returns { ok, timedOut }
 * so callers can distinguish a clean ready from a network-stall timeout.
 * On timeout, auth.role may still be null -- callers must handle that case
 * (e.g. redirect to /auth-error) instead of falling through to role-based
 * routing with a null role.
 *
 * Used by roleRedirect guard, applyGuard, and router beforeEach.
 * Safe to call multiple times -- each call gets its own Promise.
 */
export function waitUntilReady(): Promise<ReadyResult> {
  if (isReady.value) return Promise.resolve({ ok: true, timedOut: false })

  const waitPromise = new Promise<ReadyResult>((resolve) => {
    const stop = watch(isReady, (ready) => {
      if (ready) {
        stop()
        resolve({ ok: true, timedOut: false })
      }
    })
  })

  const timeoutPromise = new Promise<ReadyResult>((resolve) => {
    setTimeout(() => {
      resolve({ ok: false, timedOut: true })
    }, READY_TIMEOUT_MS)
  })

  return Promise.race([waitPromise, timeoutPromise])
}

/**
 * Run the full auth initialization flow.
 * Should be called once from App.vue on mount.
 */
async function initAuth(): Promise<void> {
  const authStore = useAuthStore()

  // Reset in case of re-initialization.
  resetAuthState()

  await platform.init()

  // TD-F01: read startapp param before auth so it's available regardless
  // of whether we restore a session or do a fresh login.
  const startParam = platform.getStartParam()
  pendingDeepLink.value = parseStartParam(startParam)

  // Step 1: try to restore existing session (page reload).
  const restored = await authStore.restoreSession()
  if (restored) {
    isReady.value = true
    return
  }

  // Step 2: try platform-specific login.
  const initData = platform.getInitData()

  if (initData) {
    await authStore.loginViaTelegram(initData)
    isReady.value = true
    return
  }

  // Standalone: no auto-login possible.
  isStandalone.value = true
  isReady.value = true
}

export function useAuth() {
  const authStore = useAuthStore()

  return {
    isReady,
    isAuthenticated: computed(() => authStore.isAuthenticated),
    isStandalone,
    isLoggingOut,
    initAuth,
    /** Exposed for testing (10.4). */
    resetAuthState,
  }
}
