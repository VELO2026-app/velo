// =============================================================================
// VELO Frontend -- Router Guards (Phase F2.2, updated F6, BUG-role-redirect, TD-F01)
// =============================================================================
//
// Navigation guards for role-based access control.
//
// Auth gate (authenticated yes/no) lives in App.vue (Phase F1.3).
// These guards handle ROLE-BASED routing for authenticated users:
//   - roleRedirect:      redirect / to role-specific dashboard
//   - roleGuard:         require a minimum role to access a route group
//   - masterStatusGuard: require verified master profile
//
// F6 update: masterStatusGuard is now fully implemented.
//   - Calls useMasterStore().fetchMyProfile() lazily (skips if loaded)
//   - Redirects to /master/pending if profile missing or not verified
//   - Guards are applied per-route in router/index.ts via beforeEnter
//
// BUG-role-redirect fix: roleRedirect is now async and awaits waitUntilReady()
// before reading auth.role. Without this, the guard fires during the first
// navigation (before App.vue mounts), sees role=null, and redirects every
// user to /user/dashboard regardless of their real role.
//
// WARNING-3: if waitUntilReady() timed out and role is still null, redirect
// to /auth-error so the user sees a recoverable error screen instead of
// landing on /user/dashboard with broken state.
//
// TD-F01: roleRedirect consumes pendingDeepLink after auth completes.
// If a startapp=open_practice__{uuid} deep link was parsed during initAuth(),
// the user is redirected to the practice detail page instead of the dashboard.
// pendingDeepLink is cleared after first use to prevent stale redirects.
// =============================================================================

import type { NavigationGuardWithThis, RouteLocationNormalized } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useMasterStore } from '@/stores/master'
import { waitUntilReady, pendingDeepLink } from '@/composables/useAuth'
import type { ReadyResult } from '@/composables/useAuth'
import { refreshRoleIfStale } from '@/composables/useRoleFreshness'
import type { UserRole } from '@/api/types'
import { MASTER_APPLIED_KEY, masterRejectionSeenKey } from '@/utils/constants'

/**
 * Redirect `/` to the correct dashboard based on user role.
 * Falls back to /user/dashboard for unknown roles.
 *
 * Async: awaits auth initialization so role is guaranteed to be set
 * before the switch. Without the await, role is always null on first load.
 *
 * TD-F01: if pendingDeepLink is set, redirect there instead of the dashboard
 * and clear the pending link so subsequent navigations go normally. A
 * pending deep link is a deliberate user action (e.g. a shared practice
 * link) and wins over the rejection redirect below -- the rejection screen
 * will surface on the next plain open instead.
 *
 * Bug 1 (ПРОМТ №405, operator device testing 2026-07-15): a rejected
 * applicant returning later (role='user', no capability) is routed to
 * /master/pending ONCE (operator decision: show the verdict, then treat
 * them as an ordinary user) if they have not already seen it -- see the
 * masterRejectionSeenKey check below.
 */
export const roleRedirect: NavigationGuardWithThis<undefined> = async () => {
  // Wait for initAuth() to complete so auth.role reflects the real session.
  const { timedOut }: ReadyResult = await waitUntilReady()

  const auth = useAuthStore()

  // WARNING-3: timeout + no role means auth stalled (network/SDK freeze).
  // Redirect to error screen instead of routing with null role.
  if (timedOut && auth.role === null) {
    return { path: '/auth-error' }
  }

  // TD-F01: consume pending deep link from startapp parameter.
  if (pendingDeepLink.value) {
    const target = pendingDeepLink.value
    pendingDeepLink.value = null
    return target
  }

  // Bug 1 fix: R2 (batch R, cb6d8bf) added the masterPendingGuard branch that
  // ALLOWS a rejected applicant onto /master/pending, but nothing routed them
  // there -- roleRedirect switched on role alone and always sent role='user'
  // to /user/dashboard, so a returning rejected applicant never saw the
  // screen the guard now permits. MasterPendingView marks the per-user key
  // seen once the screen actually renders (mirrors masterApprovedSeenKey's
  // placement for the approved case).
  if (
    auth.role === 'user' &&
    auth.masterApplication?.status === 'rejected' &&
    auth.user?.id &&
    !localStorage.getItem(masterRejectionSeenKey(auth.user.id))
  ) {
    return { path: '/master/pending' }
  }

  switch (auth.role) {
    case 'admin':
      return { path: '/admin/dashboard' }
    case 'master':
      return { path: '/master/dashboard' }
    default:
      return { path: '/user/dashboard' }
  }
}

/**
 * T21-4/T21-5 (ПРОМТ №546, cost fixed ПРОМТ №550): keeps role/master-
 * application state fresh across in-app navigation and catches an unseen
 * rejection verdict on ANY route. roleRedirect's own rejection branch above
 * only ever fires for a fresh navigation to '/' -- for a session that's
 * already open and simply navigating around (dashboard -> calendar ->
 * settings), nothing previously re-checked this at all (ПРОМТ №545 recon,
 * B1's actual root cause). Called directly from router/index.ts's global
 * beforeEach rather than registered as its own router.beforeEach, so it
 * composes with the existing P-1 logic in one guard chain instead of two
 * independent ones racing on order.
 *
 * refreshRoleIfStale() is deliberately NOT awaited (ПРОМТ №550, ПРОМТ №549
 * regression finding): this guard runs on EVERY navigation, for EVERY role
 * -- awaiting it made every navigation, app-wide, periodically block on a
 * real GET /users/me round trip (roughly once per NAV_REFRESH_DEBOUNCE_MS of
 * active use), even for admin/master navigations that have nothing to do
 * with the rejection screen this guard exists for. The only thing that
 * genuinely must resolve WITH this navigation is the redirect check below,
 * which reads whatever is ALREADY in the store -- the refetch itself only
 * needs to land before some FUTURE check, not this one. Fired here
 * (fire-and-forget, matching the same idiom already used by this module's
 * own visibilitychange resume handler) so it still updates the store in the
 * background for the next navigation/poll tick to see.
 *
 * Scope is deliberately UNCHANGED (still called for every role, not gated to
 * role==='user'): the obvious-looking fix of only refreshing for a
 * rejection-eligible role would blind the SYMMETRIC case --
 * AdminMasterReviewView.vue's «Отозвать мастера» revoke flips a master's
 * server-side role straight to 'user' (admin/masters/service.py's
 * revoke_master), and a master who is never refreshed would keep the stale
 * client-side role until a cold boot, same bug class as T21-4, pointed the
 * other way.
 *
 * COST, stated plainly (not assumed): a rejected user -- or, symmetrically,
 * a just-revoked master -- can complete ONE MORE navigation on stale data
 * before the now-in-flight refresh lands and the NEXT check catches it,
 * where previously a debounce-eligible navigation would sometimes block and
 * catch it immediately. Bounded by the same debounce window as before (not
 * unbounded), and backed by two independent safety nets this cost doesn't
 * touch: the foreground poll (useRoleFreshness.ts, every
 * FOREGROUND_POLL_INTERVAL_MS while parked on one screen) and the backend's
 * OWN per-request role check (auth/dependencies.py's get_current_master
 * reads the CURRENT DB row every call, never the client's cached role) --
 * so a revoked master's UI may show master chrome for one extra navigation,
 * but no master-only backend action is actually reachable in that window.
 * Judged acceptable on that basis, not by default.
 *
 * Skips when `to` is already the verdict screen itself -- masterPendingGuard
 * owns that route's own access rules, this must not redirect a navigation
 * that's already headed there.
 *
 * Deliberately NOT typed as NavigationGuardWithThis (unlike every guard
 * above) -- it is never registered via router.beforeEach directly, only
 * called manually from inside the already-registered global beforeEach
 * (router/index.ts), which passes just `to`. That type's call signature
 * requires (to, from, next), which a direct 1-arg call does not satisfy.
 */
export async function roleFreshnessGuard(
  to: Pick<RouteLocationNormalized, 'name'>,
): Promise<true | { path: string }> {
  void refreshRoleIfStale()

  const auth = useAuthStore()

  if (
    to.name !== 'master-pending' &&
    auth.role === 'user' &&
    auth.masterApplication?.status === 'rejected' &&
    auth.user?.id &&
    !localStorage.getItem(masterRejectionSeenKey(auth.user.id))
  ) {
    return { path: '/master/pending' }
  }

  return true
}

/**
 * Factory: require a minimum role to access a route group.
 *
 * roleGuard('master') -- allows master + admin
 * roleGuard('admin')  -- allows admin only
 */
export function roleGuard(
  required: Extract<UserRole, 'master' | 'admin'>,
): NavigationGuardWithThis<undefined> {
  return () => {
    const auth = useAuthStore()
    const role = auth.role

    if (required === 'admin' && role !== 'admin') {
      return { path: '/user/dashboard' }
    }

    if (required === 'master' && role !== 'master' && role !== 'admin') {
      return { path: '/user/dashboard' }
    }

    return true
  }
}

/**
 * Shared no-application check (№257 honest entry, operator Q4=А).
 *
 * A role=master account with NO master profile at all (confirmed by the
 * backend's 403 code=master_profile_not_found -- e.g. an admin who switched
 * into master, or a CLI-promoted account without a profile) is LED to the
 * application wizard instead of a mute degraded dashboard / a false
 * "заявка отправлена" screen. Distinct from pending/rejected applications,
 * which keep their existing /master/pending verdict flow.
 *
 * Admins browsing /master/* keep today's path (pending -> admin bounce), and
 * a transient fetch error never triggers the redirect (profileMissing is
 * keyed on the machine code, not on profile===null).
 */
async function noProfileMasterRedirect(): Promise<{ path: string } | null> {
  const auth = useAuthStore()
  if (auth.role !== 'master') return null

  const masterStore = useMasterStore()
  // Lazy-fetch profile (skips network if already loaded this session).
  await masterStore.fetchMyProfile()

  return masterStore.profileMissing ? { path: '/master/apply' } : null
}

/**
 * Lead a no-application master to the apply wizard on dashboard entry.
 *
 * Applied to: /master/dashboard (which has no status guard -- pending /
 * rejected masters may sit on it, byte-identical to before №257).
 */
export const masterNoProfileGuard: NavigationGuardWithThis<undefined> = async () =>
  (await noProfileMasterRedirect()) ?? true

/**
 * Require verified master profile before accessing protected master routes.
 *
 * Applied to: practices/*, finance (routes that require active master status).
 * Not applied to: /master/profile, /master/apply, /master/pending.
 * №257: a confirmed no-application master goes to /master/apply (honest
 * entry); everything else non-verified keeps the /master/pending redirect.
 */
export const masterStatusGuard: NavigationGuardWithThis<undefined> = async () => {
  const redirect = await noProfileMasterRedirect()
  if (redirect) return redirect

  const masterStore = useMasterStore()

  // Lazy-fetch profile (skips network if already loaded this session).
  await masterStore.fetchMyProfile()

  if (!masterStore.profile || masterStore.profile.status !== 'verified') {
    return { path: '/master/pending' }
  }

  return true
}

/**
 * Gate the standalone `master-pending` route.
 *
 * The route lives OUTSIDE the /master shell group, so it has no role guard of
 * its own — without this, a plain user who opens /master/pending directly sees
 * a false "Заявка отправлена!" screen. Access rules:
 *   - admin            -> redirect to /admin/dashboard (admins never apply)
 *   - master           -> allow (masterStatusGuard sends non-verified masters
 *                         here; a verified master is redirected to the dashboard
 *                         by the view's own onMounted check)
 *   - user + marker     -> allow (an actual applicant — still role='user' until
 *                         the backend promotes them; MASTER_APPLIED_KEY is set
 *                         on a successful application submit)
 *   - user + capability -> allow (MA3: an already-approved role='user' account
 *                         detoured here by RoleSwitchSection so it sees the
 *                         "Ваша заявка одобрена!" screen before switching — same
 *                         authoritative signal the view's own profileStatus
 *                         computed already trusts, not the sessionStorage marker
 *                         which only covers the fresh-submit path)
 *   - user + rejected   -> allow (R2 fix, ПРОМТ №390: a rejected applicant is
 *                         role='user' with no capability and no session marker
 *                         by the time a decision lands (24-48h later, a
 *                         different session) — without this branch every
 *                         rejected applicant fell through to the "neither"
 *                         case below and got bounced to /user/dashboard
 *                         before MasterPendingView could ever show the
 *                         rejection screen. masterApplication is populated
 *                         from GET /users/me (T5), same source the view's own
 *                         profileStatus computed already trusts.)
 *   - user, neither     -> redirect to /user/dashboard (never applied)
 */
export const masterPendingGuard: NavigationGuardWithThis<undefined> = async () => {
  const { timedOut }: ReadyResult = await waitUntilReady()
  const auth = useAuthStore()

  if (timedOut && auth.role === null) {
    return { path: '/auth-error' }
  }

  if (auth.role === 'admin') return { path: '/admin/dashboard' }
  if (auth.role === 'master') return true

  if (sessionStorage.getItem(MASTER_APPLIED_KEY) === '1') return true
  if (auth.allowedRoles.includes('master')) return true
  if (auth.masterApplication?.status === 'rejected') return true

  return { path: '/user/dashboard' }
}
