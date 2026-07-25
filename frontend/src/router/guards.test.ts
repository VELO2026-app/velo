// =============================================================================
// VELO Frontend -- router/guards.ts Unit Tests (T1 stage 3 -- seam + guards)
// =============================================================================
//
// Uses the REAL @/composables/useAuth module (unlike stage 2, which mocked it
// wholesale to avoid the isReady singleton entirely) -- that singleton and
// waitUntilReady() are exactly what stage 3 exists to make testable. The seam
// is __setReadyForTest() (useAuth.ts, test-only, additive): forces isReady
// without running the real initAuth() bootstrap. The not-ready/timeout path
// uses fake timers to fast-forward waitUntilReady()'s 10s race instead of
// leaving isReady unset and waiting for real time (well past testTimeout).
//
// @/stores/auth is the REAL Pinia store (setActivePinia per test) so
// role/allowedRoles/masterApplication computeds are exercised for real, not
// re-implemented in a mock. @/stores/master is mocked wholesale -- its
// fetchMyProfile() would otherwise hit the network.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import {
  roleRedirect,
  roleGuard,
  masterNoProfileGuard,
  masterStatusGuard,
  masterPendingGuard,
  roleFreshnessGuard,
} from '@/router/guards'
import { useAuthStore } from '@/stores/auth'
import { resetAuthState, __setReadyForTest, pendingDeepLink } from '@/composables/useAuth'
import { MASTER_APPLIED_KEY, masterRejectionSeenKey } from '@/utils/constants'
import type { UserResponse } from '@/api/types'

// roleFreshnessGuard calls refreshRoleIfStale() (useRoleFreshness.ts), which
// calls the REAL authStore.fetchMe() -> a real network call happy-dom cannot
// satisfy. refreshRoleIfStale's OWN behaviour (debounce timing, what it
// fetches) is tested separately in useRoleFreshness.test.ts -- here only
// roleFreshnessGuard's OWN redirect logic is under test, so the call is
// stubbed to a no-op, same idiom as AdminMastersView.test.ts's
// primeMethodTaxonomyCatalog mock.
const refreshRoleIfStale = vi.fn().mockResolvedValue(undefined)
vi.mock('@/composables/useRoleFreshness', () => ({
  refreshRoleIfStale: (...args: unknown[]) => refreshRoleIfStale(...args),
}))

// Guards ignore (to, from, next) entirely at runtime -- call bare, matching
// how vue-router actually invokes them. NavigationGuardWithThis's declared
// 3-required-param signature is a vue-router typing convenience, not a real
// runtime requirement here; cast through unknown rather than pass dummy args.
type BareGuardResult = { path: string } | { name: string; params?: Record<string, string> } | true
function call(guard: unknown): Promise<BareGuardResult> {
  return (guard as () => Promise<BareGuardResult>)()
}

const masterStoreState: { profileMissing: boolean; profile: { status: string } | null } = {
  profileMissing: false,
  profile: null,
}
const fetchMyProfile = vi.fn().mockResolvedValue(undefined)
vi.mock('@/stores/master', () => ({
  useMasterStore: () => ({
    get profileMissing() {
      return masterStoreState.profileMissing
    },
    get profile() {
      return masterStoreState.profile
    },
    fetchMyProfile,
  }),
}))

function setAuthUser(overrides: Partial<UserResponse> & Record<string, unknown> = {}): void {
  const store = useAuthStore()
  store.token = 'tok'
  store.user = {
    id: 'user_1',
    role: 'user',
    first_name: 'Test',
    last_name: null,
    onboarding_completed: true,
    ...overrides,
  } as UserResponse
}

describe('router/guards', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetAuthState()
    sessionStorage.clear()
    localStorage.clear()
    masterStoreState.profileMissing = false
    masterStoreState.profile = null
    fetchMyProfile.mockClear()
    refreshRoleIfStale.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('roleRedirect', () => {
    it('admin -> /admin/dashboard', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'admin' })
      expect(await call(roleRedirect)).toEqual({ path: '/admin/dashboard' })
    })

    it('master -> /master/dashboard', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'master' })
      expect(await call(roleRedirect)).toEqual({ path: '/master/dashboard' })
    })

    it('user -> /user/dashboard (default case)', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'user' })
      expect(await call(roleRedirect)).toEqual({ path: '/user/dashboard' })
    })

    it('a pending deep link is consumed and cleared instead of the role dashboard', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'master' })
      pendingDeepLink.value = { name: 'practice-detail', params: { id: 'p1' } }

      const result = await call(roleRedirect)

      expect(result).toEqual({ name: 'practice-detail', params: { id: 'p1' } })
      expect(pendingDeepLink.value).toBeNull()
    })

    it('timeout with role still null -> /auth-error', async () => {
      vi.useFakeTimers()
      // isReady never set -- waitUntilReady() races the 10s timeout.
      const promise = call(roleRedirect)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await promise).toEqual({ path: '/auth-error' })
    })

    it('timeout but role already resolved -> falls through to normal role routing, not auth-error', async () => {
      vi.useFakeTimers()
      setAuthUser({ role: 'master' })
      const promise = call(roleRedirect)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await promise).toEqual({ path: '/master/dashboard' })
    })

    // -- Bug 1 (ПРОМТ №405): rejected applicant routing --------------------
    it('rejected applicant, not yet seen -> routed to /master/pending', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'user', master_application: { status: 'rejected' } })
      expect(await call(roleRedirect)).toEqual({ path: '/master/pending' })
    })

    it('rejected applicant, already seen -> /user/dashboard like an ordinary user', async () => {
      __setReadyForTest(true)
      setAuthUser({ id: 'user_1', role: 'user', master_application: { status: 'rejected' } })
      localStorage.setItem(masterRejectionSeenKey('user_1'), '1')
      expect(await call(roleRedirect)).toEqual({ path: '/user/dashboard' })
    })

    it('rejected applicant with a pending deep link -> the deep link wins', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'user', master_application: { status: 'rejected' } })
      pendingDeepLink.value = { name: 'practice-detail', params: { id: 'p1' } }

      const result = await call(roleRedirect)

      expect(result).toEqual({ name: 'practice-detail', params: { id: 'p1' } })
      expect(pendingDeepLink.value).toBeNull()
    })

    it('a plain user with no application is unaffected -> /user/dashboard', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'user' })
      expect(await call(roleRedirect)).toEqual({ path: '/user/dashboard' })
    })

    it('the seen key is scoped per user -- user B still gets routed after user A is marked seen', async () => {
      __setReadyForTest(true)
      localStorage.setItem(masterRejectionSeenKey('user_a'), '1')

      setAuthUser({ id: 'user_b', role: 'user', master_application: { status: 'rejected' } })

      expect(await call(roleRedirect)).toEqual({ path: '/master/pending' })
    })

    // ПРОМТ №406: the seen key is a per-user LIFETIME flag, not per-rejection
    // -- without a re-arm on re-apply, a second rejection would be invisible
    // forever. MasterApplyView.vue's submit handler clears the key via the
    // same masterRejectionSeenKey(userId) + localStorage.removeItem() call
    // exercised directly here (mounting the 3-step wizard just to reach that
    // one line would be disproportionate and isn't this codebase's test
    // idiom); what matters is proving the ROUND TRIP through roleRedirect,
    // not the mechanical fact that a key got removed.
    it('re-apply re-arms the screen: seen -> dashboard, re-apply clears it, second rejection shows again', async () => {
      __setReadyForTest(true)
      setAuthUser({ id: 'user_1', role: 'user', master_application: { status: 'rejected' } })

      // First rejection: not yet seen -> routed to the verdict screen, then
      // MasterPendingView marks it seen (simulated directly, same call it makes).
      expect(await call(roleRedirect)).toEqual({ path: '/master/pending' })
      localStorage.setItem(masterRejectionSeenKey('user_1'), '1')

      // Seen -> subsequent opens go straight to the dashboard, not captivity.
      expect(await call(roleRedirect)).toEqual({ path: '/user/dashboard' })

      // Re-apply: status leaves 'rejected' -> 'pending' (proven server-side at
      // masters/service.py:76 _build_data, reused by _build_reapply_data), so
      // roleRedirect's rejection branch cannot fire in the interim -- and the
      // submit handler clears the seen key (MasterApplyView.vue).
      setAuthUser({ id: 'user_1', role: 'user', master_application: { status: 'pending' } })
      localStorage.removeItem(masterRejectionSeenKey('user_1'))
      expect(await call(roleRedirect)).toEqual({ path: '/user/dashboard' })

      // A genuine second rejection lands -- the re-armed key means it is
      // visible again, not silently swallowed by the first rejection's flag.
      setAuthUser({ id: 'user_1', role: 'user', master_application: { status: 'rejected' } })
      expect(await call(roleRedirect)).toEqual({ path: '/master/pending' })
    })
  })

  describe('roleGuard', () => {
    it("roleGuard('admin'): admin passes", () => {
      setAuthUser({ role: 'admin' })
      expect(call(roleGuard('admin'))).toBe(true)
    })

    it("roleGuard('admin'): master is redirected to /user/dashboard", () => {
      setAuthUser({ role: 'master' })
      expect(call(roleGuard('admin'))).toEqual({ path: '/user/dashboard' })
    })

    it("roleGuard('admin'): user is redirected to /user/dashboard", () => {
      setAuthUser({ role: 'user' })
      expect(call(roleGuard('admin'))).toEqual({ path: '/user/dashboard' })
    })

    it("roleGuard('master'): master passes", () => {
      setAuthUser({ role: 'master' })
      expect(call(roleGuard('master'))).toBe(true)
    })

    it("roleGuard('master'): admin also passes (admin outranks master)", () => {
      setAuthUser({ role: 'admin' })
      expect(call(roleGuard('master'))).toBe(true)
    })

    it("roleGuard('master'): user is redirected to /user/dashboard", () => {
      setAuthUser({ role: 'user' })
      expect(call(roleGuard('master'))).toEqual({ path: '/user/dashboard' })
    })
  })

  describe('masterNoProfileGuard', () => {
    it('non-master role: passes without touching the master store', async () => {
      setAuthUser({ role: 'user' })
      expect(await call(masterNoProfileGuard)).toBe(true)
      expect(fetchMyProfile).not.toHaveBeenCalled()
    })

    it('master with no profile at all: redirects to /master/apply', async () => {
      setAuthUser({ role: 'master' })
      masterStoreState.profileMissing = true
      expect(await call(masterNoProfileGuard)).toEqual({ path: '/master/apply' })
    })

    it('master with a profile: passes', async () => {
      setAuthUser({ role: 'master' })
      masterStoreState.profileMissing = false
      expect(await call(masterNoProfileGuard)).toBe(true)
    })
  })

  describe('masterStatusGuard', () => {
    it('no profile at all: redirects to /master/apply (delegates to the no-profile check)', async () => {
      setAuthUser({ role: 'master' })
      masterStoreState.profileMissing = true
      expect(await call(masterStatusGuard)).toEqual({ path: '/master/apply' })
    })

    it('profile exists but not verified: redirects to /master/pending', async () => {
      setAuthUser({ role: 'master' })
      masterStoreState.profile = { status: 'pending' }
      expect(await call(masterStatusGuard)).toEqual({ path: '/master/pending' })
    })

    it('profile verified: passes', async () => {
      setAuthUser({ role: 'master' })
      masterStoreState.profile = { status: 'verified' }
      expect(await call(masterStatusGuard)).toBe(true)
    })
  })

  describe('masterPendingGuard', () => {
    it('timeout with role still null -> /auth-error', async () => {
      vi.useFakeTimers()
      const promise = call(masterPendingGuard)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await promise).toEqual({ path: '/auth-error' })
    })

    it('admin -> redirected to /admin/dashboard (admins never apply)', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'admin' })
      expect(await call(masterPendingGuard)).toEqual({ path: '/admin/dashboard' })
    })

    it('master -> allowed (masterStatusGuard is what sent them here)', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'master' })
      expect(await call(masterPendingGuard)).toBe(true)
    })

    it('user with the fresh-submit session marker -> allowed', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'user' })
      sessionStorage.setItem(MASTER_APPLIED_KEY, '1')
      expect(await call(masterPendingGuard)).toBe(true)
    })

    it('user with master in allowedRoles (approved capability) -> allowed', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'user', role_switch: { allowed_roles: ['user', 'master'] } })
      expect(await call(masterPendingGuard)).toBe(true)
    })

    it('user with a rejected application -> allowed (sees the rejection screen)', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'user', master_application: { status: 'rejected' } })
      expect(await call(masterPendingGuard)).toBe(true)
    })

    it('plain user who never applied -> redirected to /user/dashboard', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'user' })
      expect(await call(masterPendingGuard)).toEqual({ path: '/user/dashboard' })
    })
  })

  // ===========================================================================
  // T21-4/T21-5 (ПРОМТ №546): roleFreshnessGuard generalizes roleRedirect's
  // rejection branch to EVERY route, not just a fresh nav to '/' -- the
  // actual gap the recon traced (a session already open and simply
  // navigating around never re-checked this at all). Takes `to` directly
  // (not the bare `call()` helper above), and always calls
  // refreshRoleIfStale() first (mocked, asserted separately below).
  describe('roleFreshnessGuard', () => {
    it('always calls refreshRoleIfStale before checking anything', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'user' })
      await roleFreshnessGuard({ name: 'user-dashboard' })
      expect(refreshRoleIfStale).toHaveBeenCalledTimes(1)
    })

    it('rejected applicant, not yet seen, navigating anywhere else -> routed to /master/pending', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'user', master_application: { status: 'rejected' } })
      expect(await roleFreshnessGuard({ name: 'user-calendar' })).toEqual({ path: '/master/pending' })
    })

    it('does not redirect a navigation already headed to master-pending (avoids a loop)', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'user', master_application: { status: 'rejected' } })
      expect(await roleFreshnessGuard({ name: 'master-pending' })).toBe(true)
    })

    it('rejected applicant, already seen -> allowed through (matches roleRedirect\'s own rule)', async () => {
      __setReadyForTest(true)
      setAuthUser({ id: 'user_1', role: 'user', master_application: { status: 'rejected' } })
      localStorage.setItem(masterRejectionSeenKey('user_1'), '1')
      expect(await roleFreshnessGuard({ name: 'user-profile' })).toBe(true)
    })

    it('non-rejected user navigating around -> allowed through', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'user' })
      expect(await roleFreshnessGuard({ name: 'user-dashboard' })).toBe(true)
    })

    it('master/admin roles -> allowed through (the rejection condition requires role=user)', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'master' })
      expect(await roleFreshnessGuard({ name: 'master-dashboard' })).toBe(true)
    })

    // -- ПРОМТ №550: guard cost fix -- refreshRoleIfStale is fire-and-forget,
    // and its scope stays every-role (not gated to role='user'). ------------
    it('still refreshes for a master role, not only role=user -- a revoked master must keep learning about it', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'master' })
      await roleFreshnessGuard({ name: 'master-dashboard' })
      expect(refreshRoleIfStale).toHaveBeenCalledTimes(1)
    })

    it('resolves without waiting for refreshRoleIfStale to settle -- navigation is never blocked on the network round trip', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'user' })

      // A refresh that is still pending 50ms after this guard is awaited --
      // if roleFreshnessGuard still `await`ed refreshRoleIfStale (the
      // reverted behavior), its own returned promise could not settle before
      // this slow mock does, and `refreshSettled` would already be true by
      // the time `result` is assigned below.
      let refreshSettled = false
      refreshRoleIfStale.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              refreshSettled = true
              resolve()
            }, 50)
          }),
      )

      const result = await roleFreshnessGuard({ name: 'user-dashboard' })

      expect(result).toBe(true)
      expect(refreshSettled).toBe(false)
    })
  })
})
