// =============================================================================
// VELO Frontend -- Role Freshness (T21-4/T21-5, ПРОМТ №546)
// =============================================================================
//
// The gap this closes: nothing in the app ever refetched GET /users/me for a
// session that was ALREADY OPEN. authStore.user (role, allowedRoles,
// masterApplication) was only ever refreshed on a full app boot (restoreSession/
// loginViaTelegram) or by mounting MasterPendingView specifically. A rejection
// or an admin approval that happened while the client sat on any other screen
// was invisible until the user reloaded -- sometimes several times (ПРОМТ
// №545 recon, B1/B2, ONE root cause traced end to end).
//
// Two levels, per the owner's decision (both, not either):
//   1. refreshRoleIfStale() -- called from the router's global beforeEach on
//      every navigation, debounced so rapid navigation cannot storm the
//      endpoint.
//   2. startRoleFreshnessPoll()/stopRoleFreshnessPoll() -- a foreground-only
//      poll for someone parked on a single screen who never navigates again
//      while waiting for a verdict. Paused on backgrounding via
//      visibilitychange (this codebase had NO pause-on-background handling
//      anywhere before this -- confirmed absent by the ПРОМТ №545 recon), so
//      it never ticks blind in a backgrounded Telegram webview.
//
// Explicitly NOT a websocket/push mechanism -- the owner has ruled that a
// messaging/notification module is coming from the backend team (Zod); this
// is a stopgap reusing the existing GET /users/me endpoint, not a parallel
// mechanism to be thrown away later.
// =============================================================================

import { useAuthStore } from '@/stores/auth'

/** Minimum time between navigation-triggered refetches. Chosen as "fast
 *  enough that a verdict reachable by normal in-app navigation feels near-
 *  instant, slow enough that rapidly tapping between tabs can't turn every
 *  tap into a network call" -- there is no measured threshold behind this
 *  number, it is a judgment call; revisit if it proves too chatty or too slow
 *  in practice. */
const NAV_REFRESH_DEBOUNCE_MS = 15_000

/** Foreground poll interval while the app is visible and authenticated.
 *  Chosen as "someone staring at a pending-verdict screen sees it resolve
 *  within half a minute of the admin's action, without polling often enough
 *  to matter for battery/network in a Telegram webview." Not measured
 *  against real usage data -- a judgment call, named here (not inlined) so
 *  it is one place to revisit. */
const FOREGROUND_POLL_INTERVAL_MS = 30_000

let lastFetchAt = 0
let pollHandle: ReturnType<typeof setInterval> | null = null
let visibilityHandler: (() => void) | null = null

/**
 * Refetch /users/me if the last fetch (from either this function or the
 * poll below) is older than NAV_REFRESH_DEBOUNCE_MS. Safe to call on every
 * navigation -- most calls are a no-op timestamp check, not a network call.
 * fetchMe() itself already no-ops when there is no session token.
 */
export async function refreshRoleIfStale(): Promise<void> {
  const now = Date.now()
  if (now - lastFetchAt < NAV_REFRESH_DEBOUNCE_MS) return
  lastFetchAt = now
  await useAuthStore().fetchMe()
}

/** The poll tick itself -- always goes through the SAME debounce state as
 *  refreshRoleIfStale so a poll tick and a navigation refetch can never both
 *  fire back-to-back for the same staleness window. */
async function pollTick(): Promise<void> {
  await refreshRoleIfStale()
}

function clearPoll(): void {
  if (pollHandle !== null) {
    clearInterval(pollHandle)
    pollHandle = null
  }
}

function startPollIfForeground(): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  if (pollHandle !== null) return
  pollHandle = setInterval(() => {
    void pollTick()
  }, FOREGROUND_POLL_INTERVAL_MS)
}

/**
 * Start the foreground poll (idempotent -- safe to call once from App.vue's
 * onMounted, alongside initAuth()). Pauses itself on backgrounding and
 * resumes on foregrounding via visibilitychange; the listener is attached
 * exactly once regardless of how many times this is called.
 */
export function startRoleFreshnessPoll(): void {
  startPollIfForeground()

  if (visibilityHandler || typeof document === 'undefined') return
  visibilityHandler = () => {
    if (document.visibilityState === 'hidden') {
      clearPoll()
    } else {
      // Coming back to the foreground is itself a good moment to check --
      // the interval alone could otherwise leave a stale window up to
      // FOREGROUND_POLL_INTERVAL_MS long right after resuming.
      void refreshRoleIfStale()
      startPollIfForeground()
    }
  }
  document.addEventListener('visibilitychange', visibilityHandler)
}

/** Stop the poll and detach nothing else -- used by logout() so a cleared
 *  session doesn't keep ticking against a 401. The visibilitychange listener
 *  itself is left attached (idempotent, harmless while there's no poll to
 *  restart into foreground) rather than torn down and re-attached on next
 *  login, matching this module's singleton-composable pattern (useAuth.ts). */
export function stopRoleFreshnessPoll(): void {
  clearPoll()
}

/** TEST-ONLY. Reset module state between tests -- mirrors
 *  useAuth.ts's resetAuthState() seam. Actually removes the visibilitychange
 *  listener (not just a flag flip) so a fresh startRoleFreshnessPoll() call
 *  in the next test doesn't stack a second listener alongside a stale one. */
export function __resetRoleFreshnessForTest(): void {
  lastFetchAt = 0
  clearPoll()
  if (visibilityHandler && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', visibilityHandler)
  }
  visibilityHandler = null
}
