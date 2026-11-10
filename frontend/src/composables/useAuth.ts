// =============================================================================
// VELO Frontend -- useAuth Composable (Phase F1.3, fixed 10.4, BUG-role-redirect, TD-F01)
// =============================================================================
//
// FIX 10.4: isReady and the other flags are reactive refs inside composable scope,
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
// After auth, read platform.getStartParam() and store the RAW start parameter
// in pendingStartParam; roleRedirect parses it (router/deepLinks.ts) once auth
// knows the role (Links: a notification button carries no viewer) and clears
// it after first use to prevent stale redirects.
//
// Standalone phase 3 -- outside Telegram the person signs in with "Log In
// With Telegram". The sign-in always ENDS on a fresh page load: Telegram
// sends the browser back to RETURN_PATH, and initAuth() completes it here,
// before isReady -- so the router's first navigation and the App.vue stage
// already see the signed-in user. A failed or refused return leaves a
// LoginNotice for the login screen to word.
// =============================================================================

import { ref, computed, watch } from 'vue'
import { platform } from '@/platform'
import { takeLoginMark, takeLoginReturn } from '@/platform/browser-login'
import { onSessionEnd } from '@/platform/session'
import { useAuthStore } from '@/stores/auth'
import { ApiNetworkError, ApiResponseError, ApiTimeoutError } from '@/api/client'
import { isSchoolInviteParam } from '@/router/deepLinks'

/** Whether auth initialization has completed. */
const isReady = ref(false)

/**
 * Why the login screen is up (outside Telegram), worded by TelegramLoginView:
 *   cancelled       -- the person declined on Telegram's page;
 *   foreign         -- the return came to a browser that did not start this
 *                      sign-in (no mark, or a mark for another state);
 *   expired         -- the backend no longer holds the state (taken, late);
 *   telegram_failed -- Telegram did not prove a user;
 *   not_configured  -- browser sign-in is not set up on this server;
 *   deactivated     -- the account is switched off;
 *   rate_limited    -- too many attempts;
 *   unavailable     -- the server answered that it cannot right now;
 *   network         -- no answer at all.
 */
export type LoginNotice =
  | 'cancelled'
  | 'foreign'
  | 'expired'
  | 'telegram_failed'
  | 'not_configured'
  | 'deactivated'
  | 'rate_limited'
  | 'unavailable'
  | 'network'

/** The notice for the login screen, or null. */
export const loginNotice = ref<LoginNotice | null>(null)

/**
 * The sign-in that just finished did NOT give the bot the right to write to
 * the person. Shown once after this sign-in (BotAccessHint) and kept nowhere
 * else -- the next launch does not show it again.
 */
export const botAccessHint = ref(false)

/**
 * The start could not complete: the saved session got no answer from the
 * server (the token is still saved), or the bootstrap threw (platform.init()
 * or the first-screen gate, FE-157). App.vue shows the "try again" screen
 * instead of the login screen or an endless splash.
 */
export const restoreUnreachable = ref(false)

/** Word an error of the browser sign-in endpoints as a LoginNotice. */
export function loginNoticeFor(error: unknown): LoginNotice {
  if (error instanceof ApiNetworkError || error instanceof ApiTimeoutError) return 'network'
  if (!(error instanceof ApiResponseError)) return 'telegram_failed'
  switch (error.status) {
    case 404:
      return 'not_configured'
    case 403:
      return 'deactivated'
    case 429:
      return 'rate_limited'
    case 400:
      if (error.code === 'login_expired') return 'expired'
      if (error.code === 'login_foreign') return 'foreign'
      return 'telegram_failed'
    case 422:
      return 'telegram_failed'
    default:
      return 'unavailable'
  }
}

/**
 * Whether a logout is in progress (Telegram only).
 *
 * Set the instant logout() starts clearing the session and kept true until
 * the Mini App actually closes. The App.vue gate shows LoadingView while this
 * is true, so the brief window between `_clearSession() (isAuthenticated -> false)`
 * and platform.close() never falls through to TelegramStubView. Without it,
 * a reactive tick could flash the "Open via Telegram" stub before the app closes.
 */
const isLoggingOut = ref(false)

/** Begin the logout transition: gate shows LoadingView, not the stub. */
export function beginLogout(): void {
  isLoggingOut.value = true
}

// In Telegram, signing out closes the Mini App, so the gate is armed the
// moment stores/auth.ts announces a LOGOUT (not a dropped session: a 401
// goes back to sign-in). Subscribing here, instead of auth.ts importing this
// module on demand, is what keeps auth -> useAuth -> auth out of the graph.
onSessionEnd((reason) => {
  if (reason === 'logout' && platform.name === 'telegram') beginLogout()
})

/**
 * The raw startapp parameter of this launch, pending its deep link (TD-F01).
 * roleRedirect parses it with the session role (parseStartParam,
 * router/deepLinks.ts) once, then clears it.
 */
export const pendingStartParam = ref<string | null>(null)

/** Timeout for waitUntilReady() in milliseconds (P-3). */
const READY_TIMEOUT_MS = 10_000

/**
 * FE-81: did the app open via a school invite deep link (`school__<token>`)?
 *
 * The entry gate (App.vue) defers the new-user Welcome for exactly this one
 * startapp kind: the router has already resolved the link to the standalone
 * invitation screen, so the gate opens the RouterView around it, and the join
 * view runs the onboarding carousel after a successful join (FE-83).
 *
 * Reads the platform live instead of pendingStartParam: roleRedirect may
 * already have consumed and cleared the pending copy by the time the gate
 * decides its initial stage -- both run right after initAuth() resolves.
 */
export function isSchoolInviteStartParam(): boolean {
  return isSchoolInviteParam(platform.getStartParam())
}

/**
 * Reset auth state (for testing).
 */
export function resetAuthState(): void {
  isReady.value = false
  isLoggingOut.value = false
  pendingStartParam.value = null
  loginNotice.value = null
  botAccessHint.value = false
  restoreUnreachable.value = false
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
 *
 * Used by roleRedirect guard, applyGuard, and router beforeEach.
 * Safe to call multiple times -- each call gets its own Promise.
 *
 * @returns A Promise that resolves immediately with
 *   `{ ok: true, timedOut: false }` when isReady is already true; races a 10s
 *   timeout (WARNING-3) and returns `{ ok, timedOut }` so callers can
 *   distinguish a clean ready from a network-stall timeout. On timeout,
 *   auth.role may still be null -- callers must handle that case (e.g.
 *   redirect to /auth-error) instead of falling through to role-based
 *   routing with a null role.
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
 *
 * Never rejects: an exception from the bootstrap (platform.init() or a
 * failure the flow does not handle itself) marks the run as unreachable and
 * ready, so App.vue shows the "try again" screen (LoadingErrorView) instead
 * of the splash forever.
 */
async function initAuth(): Promise<void> {
  try {
    await runInitAuth()
  } catch {
    restoreUnreachable.value = true
    isReady.value = true
  }
}

async function runInitAuth(): Promise<void> {
  const authStore = useAuthStore()

  // Reset in case of re-initialization.
  resetAuthState()

  await platform.init()

  // TD-F01: read startapp param before auth so it's available regardless
  // of whether we restore a session or do a fresh login.
  const startParam = platform.getStartParam()
  pendingStartParam.value = startParam

  if (platform.name === 'standalone') {
    await initStandalone(authStore)
    isReady.value = true
    return
  }

  // Telegram. Step 1: restore this run's session (a page reload inside the
  // Mini App -- initData older than the backend's 300 s window would be
  // refused, so a reload cannot simply sign in again).
  //
  // The restored session is used ONLY if it belongs to the person who opened
  // the app: its telegram_id must equal the user id in THIS initData.
  // Telegram Web keeps the iframe's sessionStorage across an account switch
  // in the same tab, so without this check account B would open account A.
  // The id is read from the unsigned initData string -- enough, because the
  // check can only DROP a session or keep one this tab already holds; every
  // new session still comes from the server, which verifies the signature.
  const restored = await authStore.restoreSession()
  if (restored === 'restored') {
    const ownerId = authStore.user?.telegram_id ?? null
    if (ownerId !== null && ownerId === initDataUserId(platform.getInitData())) {
      isReady.value = true
      return
    }
    // Someone else's session (or initData naming nobody): revoke it and
    // let initData decide.
    await authStore.discardSession()
  }

  // Step 2: sign in with initData. A failure leaves the session cleared and
  // App.vue shows TelegramStubView.
  const initData = platform.getInitData()
  if (initData) {
    await authStore.loginViaTelegram(initData)
  }
  isReady.value = true
}

/**
 * The Telegram user id in an initData string. Unsigned -- see
 * initAuth for why that is enough for the one decision it feeds.
 *
 * @returns Null when there is none: no string, no `user` field, not JSON, or
 *   no integer `id`.
 */
export function initDataUserId(initData: string | null): number | null {
  if (!initData) return null
  const raw = new URLSearchParams(initData).get('user')
  if (!raw) return null
  try {
    const user: unknown = JSON.parse(raw)
    const id = user !== null && typeof user === 'object' ? (user as { id?: unknown }).id : undefined
    return typeof id === 'number' && Number.isSafeInteger(id) ? id : null
  } catch {
    return null
  }
}

/**
 * Outside Telegram: finish a sign-in this page is the return of, else
 * restore the saved session, else leave the login screen to App.vue.
 */
async function initStandalone(authStore: ReturnType<typeof useAuthStore>): Promise<void> {
  if (await completeFromReturn(authStore)) return

  const outcome = await authStore.restoreSession()
  if (outcome === 'restored') {
    // Signed in already: a refused return (someone else's link) has nothing
    // to show on a screen this person will not see.
    loginNotice.value = null
    return
  }
  restoreUnreachable.value = outcome === 'unreachable'
}

/**
 * The return from Telegram, if this page is one. The address is wiped and
 * the mark taken FIRST, whatever happens next: a reload must not replay the
 * same state, and a mark serves one return only.
 *
 * Refused WITHOUT a request: an error from Telegram, a return without code
 * and state, and a return this browser holds no mark for (another browser's
 * link -- platform/browser-login.ts, WHY THE MARK).
 */
async function completeFromReturn(authStore: ReturnType<typeof useAuthStore>): Promise<boolean> {
  const back = takeLoginReturn()
  if (!back) return false
  const started = takeLoginMark()

  if (back.error) {
    loginNotice.value = 'cancelled'
    return false
  }
  if (!back.code || !back.state) {
    loginNotice.value = 'telegram_failed'
    return false
  }
  if (!started || started.state !== back.state) {
    loginNotice.value = 'foreign'
    return false
  }

  try {
    const granted = await authStore.completeBrowserLogin(back.code, back.state, started.mark)
    botAccessHint.value = !granted
    return true
  } catch (error) {
    loginNotice.value = loginNoticeFor(error)
    return false
  }
}

/** Access the shared singleton auth state: readiness, login notices, init and the logout flag. */
export function useAuth() {
  const authStore = useAuthStore()

  return {
    isReady,
    isAuthenticated: computed(() => authStore.isAuthenticated),
    restoreUnreachable,
    loginNotice,
    botAccessHint,
    isLoggingOut,
    initAuth,
    /** Exposed for testing (10.4). */
    resetAuthState,
  }
}
