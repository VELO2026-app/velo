// =============================================================================
// VELO Frontend -- Router Guards (Phase F2.2, updated F6, BUG-role-redirect, TD-F01)
// =============================================================================
//
// Role-based routing for an authenticated session; the auth gate itself
// (authenticated yes/no) lives in App.vue (Phase F1.3). Two shapes:
//
//   - ACCESS REQUIREMENTS (FE-157): a route record declares what entering it
//     demands in meta.requires (RouteRequirement). installAccessGuard()
//     registers the router's one access guard: auth readiness on the first
//     navigation, the role freshness check, the P-1 dashboard redirect, then
//     the requirement of every record the navigation enters, parent first.
//     roleGuard, masterNoProfileGuard and masterStatusGuard are the checks
//     behind the requirements (REQUIREMENT_CHECKS).
//   - LANDING POLICIES: '/', /master/apply, /master/invite/:token and
//     /master/pending keep their own beforeEnter (roleRedirect,
//     masterApplyGuard, masterPendingGuard) -- each is the decision table of
//     ONE landing, not a requirement other records share.
//
// BUG-role-redirect fix: roleRedirect awaits waitUntilReady() before reading
// auth.role. Without this, the guard fires during the first navigation
// (before App.vue mounts), sees role=null, and redirects every user to
// /user/dashboard regardless of their real role.
//
// WARNING-3: if waitUntilReady() timed out and role is still null, redirect
// to /auth-error so the user sees a recoverable error screen instead of
// landing on /user/dashboard with broken state.
//
// TD-F01: roleRedirect consumes pendingStartParam after auth completes.
// initAuth() stores the raw startapp value; roleRedirect parses it with the
// session role (parseStartParam, router/deepLinks.ts) and redirects there
// instead of the dashboard -- open_practice__{uuid} to the practice,
// zoom__{code} to practice-live (T-35), a notification verb to the bell's
// screen. It is cleared after first use to prevent stale redirects.
// =============================================================================

import type {
  NavigationGuardWithThis,
  RouteLocationNormalized,
  RouteRecordNormalized,
  Router,
} from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { waitUntilReady, pendingStartParam } from '@/composables/useAuth'
import type { ReadyResult } from '@/composables/useAuth'
import { parseStartParam } from '@/router/deepLinks'
import { refreshRoleIfStale } from '@/composables/useRoleFreshness'
import type { UserRole } from '@/api/types'
import { MASTER_APPLIED_KEY, masterRejectionSeenKey } from '@/utils/constants'
import { isOptionEnabled, type OptionName } from '@/platform/instance'

/**
 * The master store, imported on first use (FE-157): only the master-zone
 * guards read it, so a student's startup bundle carries neither the store
 * nor the master API module behind it.
 */
async function loadMasterStore() {
  const { useMasterStore } = await import('@/stores/master')
  return useMasterStore()
}

/**
 * What entering a route record demands of the session (meta.requires).
 *
 * @remarks
 *   - `master-role`: role master or admin (an admin browses the master zone).
 *   - `admin-role`: role admin.
 *   - `master-application`: a role=master account with no master profile at
 *     all is led to /master/apply (№257 honest entry).
 *   - `verified-master`: a verified master profile; implies
 *     `master-application`.
 */
export type RouteRequirement =
  'master-role' | 'admin-role' | 'master-application' | 'verified-master'

declare module 'vue-router' {
  interface RouteMeta {
    /** The record's own access requirement, checked when a navigation enters
     * it (requirementsGuard). Read per record from `to.matched`: through the
     * merged `to.meta` a child's value would hide its parent's. */
    requires?: RouteRequirement
    /** The instance option the record belongs to (FE-151): with the option
     * off the record is not there for the user -- optionGuard sends the
     * navigation to the 404 screen. Read per record from `to.matched`. */
    option?: OptionName
  }
}

/** A guard verdict: let the navigation on, or redirect it. */
type AccessResult = true | { path: string; replace?: boolean }

/** The session check behind one RouteRequirement. Takes no route: the
 * requirement already names what is checked. */
type AccessCheck = () => AccessResult | Promise<AccessResult>

/**
 * Whether the session is a rejected applicant who has not seen the verdict
 * screen yet (Bug 1, PROMPT №405; T21-4 on any route).
 *
 * @remarks ONE copy for roleRedirect and roleFreshnessGuard: a role='user'
 * account whose master application was rejected, routed to /master/pending
 * ONCE (operator decision: show the verdict, then treat them as an ordinary
 * user). MasterPendingView marks the per-user key seen once the screen
 * actually renders (mirrors masterApprovedSeenKey's placement for the
 * approved case); re-applying clears it (MasterApplyView).
 */
function hasUnseenRejection(auth: ReturnType<typeof useAuthStore>): boolean {
  const userId = auth.user?.id
  if (auth.role !== 'user' || auth.masterApplication?.status !== 'rejected' || !userId) {
    return false
  }
  return !localStorage.getItem(masterRejectionSeenKey(userId))
}

/** The dashboard of a role's own zone; /user/dashboard for any other role. */
function zoneDashboard(role: UserRole | null): { path: string } {
  switch (role) {
    case 'admin':
      return { path: '/admin/dashboard' }
    case 'master':
      return { path: '/master/dashboard' }
    default:
      return { path: '/user/dashboard' }
  }
}

/**
 * Redirect `/` to the correct dashboard based on user role.
 * Falls back to /user/dashboard for unknown roles.
 *
 * Async: awaits auth initialization so role is guaranteed to be set
 * before the switch. Without the await, role is always null on first load.
 *
 * TD-F01: if pendingStartParam is set and parses to a route for this role,
 * redirect there instead of the dashboard
 * and clear the pending link so subsequent navigations go normally. A
 * pending deep link is a deliberate user action (e.g. a shared practice
 * link) and wins over the rejection redirect below -- the rejection screen
 * will surface on the next plain open instead.
 *
 * Bug 1 (PROMPT №405, operator device testing 2026-07-15): a rejected
 * applicant returning later (role='user', no capability) is routed to
 * /master/pending ONCE (operator decision: show the verdict, then treat
 * them as an ordinary user) if they have not already seen it -- see
 * hasUnseenRejection.
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

  // TD-F01: consume the pending startapp parameter. Links (3 October): it is
  // parsed HERE, with the session role -- a notification button carries no
  // viewer, and some verbs land in different zones for user and master. An
  // unknown parameter falls through to the usual dashboard.
  if (pendingStartParam.value) {
    const startParam = pendingStartParam.value
    pendingStartParam.value = null
    const target = parseStartParam(startParam, auth.role)
    if (target) return target
  }

  // Bug 1 fix: R2 (batch R, cb6d8bf) added the masterPendingGuard branch that
  // ALLOWS a rejected applicant onto /master/pending, but nothing routed them
  // there -- roleRedirect switched on role alone and always sent role='user'
  // to /user/dashboard, so a returning rejected applicant never saw the
  // screen the guard now permits.
  if (hasUnseenRejection(auth)) return { path: '/master/pending' }

  return zoneDashboard(auth.role)
}

/**
 * T21-4/T21-5 (PROMPT №546, cost fixed PROMPT №550): keeps role/master-
 * application state fresh across in-app navigation and catches an unseen
 * rejection verdict on ANY route. roleRedirect's own rejection branch above
 * only ever fires for a fresh navigation to '/' -- for a session that's
 * already open and simply navigating around
 * (`dashboard -> calendar -> settings`), nothing previously re-checked this
 * at all (PROMPT №545 recon, B1's actual root cause). Called from inside
 * the access guard (installAccessGuard) rather than registered as its own
 * router.beforeEach, so it composes with the P-1 logic and the route
 * requirements in one guard chain instead of independent ones racing on
 * order.
 *
 * refreshRoleIfStale() is deliberately NOT awaited (PROMPT №550, PROMPT №549
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
 * AdminMasterReviewView.vue's revoke action
 * (i18n:adminScreens.adminMasterReview.revokeMaster) flips a master's
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
 * Deliberately NOT typed as NavigationGuardWithThis -- it is never
 * registered via router.beforeEach directly, only called from inside the
 * access guard (installAccessGuard), which passes just `to`. That type's
 * call signature requires (to, from, next), which a direct 1-arg call does
 * not satisfy.
 */
export function roleFreshnessGuard(
  to: Pick<RouteLocationNormalized, 'name'>,
): true | { path: string } {
  void refreshRoleIfStale()

  if (to.name !== 'master-pending' && hasUnseenRejection(useAuthStore())) {
    return { path: '/master/pending' }
  }

  return true
}

/**
 * Factory: the role check behind `master-role` and `admin-role`; any other
 * role goes to /user/dashboard.
 *
 * roleGuard('master') -- allows master + admin
 * roleGuard('admin')  -- allows admin only
 */
export function roleGuard(required: Extract<UserRole, 'master' | 'admin'>): AccessCheck {
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
 * Shared no-application check (№257 honest entry, operator Q4=A).
 *
 * A role=master account with NO master profile at all (confirmed by the
 * backend's 403 code=master_profile_not_found -- e.g. an admin who switched
 * into master, or a CLI-promoted account without a profile) is LED to the
 * application wizard instead of a mute degraded dashboard / a false
 * application-sent screen (i18n:masterScreens.masterPending.toast.sent).
 * Distinct from pending/rejected applications,
 * which keep their existing /master/pending verdict flow.
 *
 * Admins browsing /master/* keep today's path (`pending -> admin bounce`), and
 * a transient fetch error never triggers the redirect (profileMissing is
 * keyed on the machine code, not on profile===null).
 */
async function noProfileMasterRedirect(): Promise<{ path: string } | null> {
  const auth = useAuthStore()
  if (auth.role !== 'master') return null

  const masterStore = await loadMasterStore()
  // Lazy-fetch profile (skips network if already loaded this session).
  await masterStore.fetchMyProfile(false)

  return masterStore.profileMissing ? { path: '/master/apply' } : null
}

/**
 * The `master-application` check: lead a no-application master to the apply
 * wizard.
 *
 * Required by: /master/dashboard (which requires no verified status --
 * pending / rejected masters may sit on it, byte-identical to before №257).
 */
export const masterNoProfileGuard: AccessCheck = async () =>
  (await noProfileMasterRedirect()) ?? true

/** Application and invite entry share the same server-backed status gate.
 * A verified profile grants capability even while the person uses user mode. */
export const masterApplyGuard: NavigationGuardWithThis<undefined> = async () => {
  const { timedOut }: ReadyResult = await waitUntilReady()
  const auth = useAuthStore()
  if (timedOut && auth.role === null) return { path: '/auth-error' }
  if (auth.role === 'admin') return { path: '/admin/dashboard' }
  if (auth.role === 'master') {
    const master = await loadMasterStore()
    await master.fetchMyProfile()
    if (master.profile?.status === 'verified') return { path: '/master/dashboard' }
    if (master.profile?.status === 'pending') return { path: '/master/pending' }
    return true
  }
  if (
    auth.masterApplication?.status === 'pending' ||
    auth.masterApplication?.status === 'verified' ||
    auth.allowedRoles.includes('master')
  ) {
    return { path: '/master/pending' }
  }
  return true
}

/**
 * How long an admin's master-profile answer serves the `verified-master`
 * check before the next check refetches it (B1).
 *
 * @remarks The GET /users/me freshness window (useRoleFreshness.ts
 * NAV_REFRESH_DEBOUNCE_MS): the staleness the app already accepts for a role
 * change bounds B1's stale cached profile too.
 */
export const ADMIN_PROFILE_TTL_MS = 15_000

/** The last admin profile fetch: when, and for which account. */
let adminProfileFetch: { userId: string | null; at: number } | null = null

type MasterStore = Awaited<ReturnType<typeof loadMasterStore>>

/**
 * Refetch an admin's master profile once ADMIN_PROFILE_TTL_MS has passed
 * since the last fetch, or when that fetch was another account's; within
 * the window the store's answer stands and no request leaves.
 *
 * @remarks Stamped whatever the answer: GET /masters/me refuses role=admin
 * (403 from get_current_master, backend auth/dependencies.py), so for an
 * admin an error IS the usual answer and cannot gate the stamp. Stamped
 * after the fetch, so a check racing it waits on the same request (the API
 * client dedupes the GET) instead of reading the store before it lands.
 */
async function refreshAdminProfile(master: MasterStore, userId: string | null): Promise<void> {
  const last = adminProfileFetch
  if (last && last.userId === userId && Date.now() - last.at < ADMIN_PROFILE_TTL_MS) return
  await master.fetchMyProfile(true)
  adminProfileFetch = { userId, at: Date.now() }
}

/**
 * TEST-ONLY. Forget the last admin profile fetch, so each test starts with
 * the TTL window closed. Never call from production code.
 */
export function __resetAdminProfileTtlForTest(): void {
  adminProfileFetch = null
}

/**
 * A master's application status when GET /masters/me brought no profile.
 *
 * @remarks The master store keeps no error kind: a 403 for an unverified
 * application (master_profile_not_verified) and a request that never got an
 * answer both leave it without a profile. The session's GET /users/me copy
 * (master_application) tells them apart. It is fetched here once when the
 * session holds none yet -- the user a fresh Telegram sign-in returns
 * carries no master_application until the first refresh lands; the client
 * joins the refresh roleFreshnessGuard already started (GET dedupe).
 *
 * @returns Undefined when neither request got an answer.
 */
async function applicationStatusWithoutProfile(
  auth: ReturnType<typeof useAuthStore>,
): Promise<string | undefined> {
  if (!auth.masterApplication) await auth.fetchMe()
  return auth.masterApplication?.status
}

/**
 * The `verified-master` check: a verified master profile.
 *
 * Required by: practices/*, finance, students, groups, schools, summary
 * (routes that require active master status; router/routes/master.ts).
 * Not by: /master/profile, /master/apply, /master/pending.
 * №257: a confirmed no-application master goes to /master/apply (honest
 * entry); everything else non-verified keeps the /master/pending redirect.
 *
 * @remarks FE-157: a network error is not a verdict. For a master the
 * status comes from the profile, else from GET /users/me
 * (applicationStatusWithoutProfile); with no answer from either the
 * navigation goes on, and the screen's own requests surface the connection
 * error with their retry. Nothing is exposed by it: every master endpoint
 * checks the verified status itself (get_current_master, backend
 * auth/dependencies.py). It used to land a verified master on the verdict
 * screen, a deep link included.
 */
export const masterStatusGuard: AccessCheck = async () => {
  const redirect = await noProfileMasterRedirect()
  if (redirect) return redirect

  const auth = useAuthStore()
  const masterStore = await loadMasterStore()

  // B1 (PROMPT №726): roleGuard('master') admits role=='admin' too (no role
  // change involved -- an admin browses /master/* directly, never switching
  // their own role column). A REAL master who loses verified status always
  // gets demoted to role='user' in the SAME backend transaction
  // (revoke_master / set_role.py to_user), so the freshness tick catches
  // them via the role guard before this ever runs on stale data. An admin
  // holding a verified master profile has no such tell: revoke_master's own
  // role-reset is conditional on `user.role == MASTER`, which is false for
  // an admin, so their profile can flip to 'suspended' while role stays
  // 'admin' -- profileLoaded would otherwise cache the old 'verified'
  // forever. Refetch for exactly this population, at most once per
  // ADMIN_PROFILE_TTL_MS (FE-157: it used to be on every check); a real
  // master keeps the existing lazy skip-if-loaded behaviour and pays no
  // extra network call at all (noProfileMasterRedirect above made its one
  // lazy fetch).
  if (auth.role === 'master') {
    const status = masterStore.profile?.status ?? (await applicationStatusWithoutProfile(auth))
    if (status === undefined) return true
    return status === 'verified' ? true : { path: '/master/pending' }
  }

  // An admin: GET /masters/me refuses role=admin, so no profile is the usual
  // answer, not a lost one -- the verdict screen bounces an admin to the
  // admin dashboard (masterPendingGuard), the path admins always took.
  await refreshAdminProfile(masterStore, auth.user?.id ?? null)
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
 * a false application-sent screen (i18n:masterScreens.masterPending.toast.sent).
 * Access rules:
 *   - admin            `->` redirect to /admin/dashboard (admins never apply)
 *   - master           `->` allow (masterStatusGuard sends non-verified masters
 *                         here; a verified master is redirected to the dashboard
 *                         by the view's own onMounted check)
 *   - user + marker     `->` allow (an actual applicant — still role='user' until
 *                         the backend promotes them; MASTER_APPLIED_KEY is set
 *                         on a successful application submit)
 *   - user + capability `->` allow (MA3: an already-approved role='user' account
 *                         detoured here by RoleSwitchSection so it sees the
 *                         approval screen (i18n:masterScreens.masterPending.approved.title)
 *                         before switching — same
 *                         authoritative signal the view's own profileStatus
 *                         computed already trusts, not the sessionStorage marker
 *                         which only covers the fresh-submit path)
 *   - user + rejected   `->` allow (R2 fix, PROMPT №390: a rejected applicant is
 *                         role='user' with no capability and no session marker
 *                         by the time a decision lands (24-48h later, a
 *                         different session) — without this branch every
 *                         rejected applicant fell through to the "neither"
 *                         case below and got bounced to /user/dashboard
 *                         before MasterPendingView could ever show the
 *                         rejection screen. masterApplication is populated
 *                         from GET /users/me (T5), same source the view's own
 *                         profileStatus computed already trusts.)
 *   - user, neither     `->` redirect to /user/dashboard (never applied)
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
  if (auth.masterApplication?.status === 'pending') return true
  if (auth.masterApplication?.status === 'verified') return true
  if (auth.masterApplication?.status === 'rejected') return true

  return { path: '/user/dashboard' }
}

/**
 * P-1: a master or an admin opening the user dashboard lands on their own
 * zone's dashboard -- unless they chose the user mode (ui store uiMode).
 */
export function zoneHomeGuard(to: Pick<RouteLocationNormalized, 'name' | 'path'>): AccessResult {
  if (to.name !== 'user-dashboard' && to.path !== '/user' && to.path !== '/user/') {
    return true
  }

  const auth = useAuthStore()
  if (auth.role !== 'master' && auth.role !== 'admin') return true
  if (useUiStore().uiMode === 'user') return true

  return zoneDashboard(auth.role)
}

/** The check behind each RouteRequirement. */
const REQUIREMENT_CHECKS: Record<RouteRequirement, AccessCheck> = {
  'master-role': roleGuard('master'),
  'admin-role': roleGuard('admin'),
  'master-application': masterNoProfileGuard,
  'verified-master': masterStatusGuard,
}

/** One record, also when reached through an alias (vue-router's own rule). */
function sameRecord(a: RouteRecordNormalized, b: RouteRecordNormalized): boolean {
  return (a.aliasOf ?? a) === (b.aliasOf ?? b)
}

/**
 * Check the meta.requires of every record `to` enters, parent first; the
 * first redirect wins.
 *
 * @remarks "Enters" is vue-router's own `beforeEnter` rule, so the 21
 * per-record `beforeEnter: masterStatusGuard` this replaced still fire
 * exactly as before: a record `from` already matched is not checked again --
 * a param, query or hash change, or a move between two screens of one shell,
 * checks only the records that change.
 */
export async function requirementsGuard(
  to: Pick<RouteLocationNormalized, 'matched'>,
  from: Pick<RouteLocationNormalized, 'matched'>,
): Promise<AccessResult> {
  for (const record of to.matched) {
    const requirement = record.meta.requires
    if (!requirement) continue
    if (from.matched.some((left) => sameRecord(left, record))) continue
    const result = await REQUIREMENT_CHECKS[requirement]()
    if (result !== true) return result
  }
  return true
}

/**
 * Send a navigation into a switched-off option's section to the 404 screen
 * (FE-151, tz-whitelabel §4).
 *
 * @remarks The option's code is always in the bundle (variant A) and its
 * records are always registered, so a named push from a leftover link still
 * resolves -- and lands here instead of a screen whose API the backend has
 * closed. `replace`: the dead address does not stay in history.
 */
export function optionGuard(to: Pick<RouteLocationNormalized, 'matched'>): AccessResult {
  const off = to.matched.some((record) => {
    const option = record.meta.option
    return option !== undefined && !isOptionEnabled(option)
  })
  return off ? { path: '/404', replace: true } : true
}

/**
 * Register the router's one access guard (a global beforeEach).
 *
 * @remarks Order inside it: the first navigation waits for auth
 * (waitUntilReady) -- it starts before App.vue mounts; then the instance
 * options (optionGuard, FE-151), the role freshness check (T21-4/T21-5),
 * the P-1 dashboard redirect, and the
 * requirements of the records the navigation enters. Install it AFTER
 * installRouteCatalogs: guards run in registration order, so a deep link into
 * a zone starts its catalog fetch during the auth wait.
 */
export function installAccessGuard(router: Router): void {
  let authSettled = false

  router.beforeEach(async (to, from) => {
    if (!authSettled) {
      const { timedOut }: ReadyResult = await waitUntilReady()
      authSettled = true
      if (timedOut) {
        console.warn('[router] auth initialization timed out on first navigation')
      }
    }

    const option = optionGuard(to)
    if (option !== true) return option

    const freshness = roleFreshnessGuard(to)
    if (freshness !== true) return freshness

    const home = zoneHomeGuard(to)
    if (home !== true) return home

    return requirementsGuard(to, from)
  })
}
