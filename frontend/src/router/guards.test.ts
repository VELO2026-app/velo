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
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import {
  ADMIN_PROFILE_TTL_MS,
  __resetAdminProfileTtlForTest,
  installAccessGuard,
  requirementsGuard,
  zoneHomeGuard,
  roleRedirect,
  roleGuard,
  masterNoProfileGuard,
  masterStatusGuard,
  masterPendingGuard,
  masterApplyGuard,
  roleFreshnessGuard,
  optionGuard,
} from '@/router/guards'
import { applyInstanceConfig } from '@/platform/instance'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { resetAuthState, __setReadyForTest, pendingStartParam } from '@/composables/useAuth'
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
  refreshRoleIfStale: (...args: Parameters<typeof refreshRoleIfStale>) =>
    refreshRoleIfStale(...args),
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
    __resetAdminProfileTtlForTest()
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

    // Links (3 October): this used to set an already-PARSED route. Right while
    // initAuth parsed without a role; the parse moved here, with the session
    // role, so the pending value is now the raw startapp string.
    it('a pending startapp is parsed WITH the role, consumed and cleared', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'master' })
      pendingStartParam.value = 'open_practice__00000000-0000-4000-8000-0000000000a1'

      const result = await call(roleRedirect)

      expect(result).toEqual({
        name: 'master-practice-detail',
        params: { id: '00000000-0000-4000-8000-0000000000a1' },
      })
      expect(pendingStartParam.value).toBeNull()
    })

    it('the same verb lands in the zone of the role: open_wallet -> top-up vs finance', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'user' })
      pendingStartParam.value = 'open_wallet'
      expect(await call(roleRedirect)).toEqual({ name: 'user-topup' })

      setAuthUser({ role: 'master' })
      pendingStartParam.value = 'open_wallet'
      expect(await call(roleRedirect)).toEqual({ name: 'master-finance' })
    })

    it('an unknown startapp falls through to the role dashboard, and is cleared', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'user' })
      pendingStartParam.value = 'open_admin_masters'
      expect(await call(roleRedirect)).toEqual({ path: '/user/dashboard' })
      expect(pendingStartParam.value).toBeNull()
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

    // -- Bug 1 (PROMPT №405): rejected applicant routing --------------------
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
      pendingStartParam.value = 'open_practice__00000000-0000-4000-8000-0000000000a1'

      const result = await call(roleRedirect)

      expect(result).toEqual({
        name: 'practice-detail',
        params: { id: '00000000-0000-4000-8000-0000000000a1' },
      })
      expect(pendingStartParam.value).toBeNull()
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

    // PROMPT №406: the seen key is a per-user LIFETIME flag, not per-rejection
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

  // FE-157: roleRedirect and roleFreshnessGuard share ONE rejection check
  // (hasUnseenRejection) -- they must never disagree on who sees the verdict.
  describe('the unseen-rejection rule is the same for both guards', () => {
    const toVerdict = (result: unknown) =>
      JSON.stringify(result) === JSON.stringify({ path: '/master/pending' })

    it.each([
      ['rejected, unseen', 'user', 'rejected', false, true],
      ['rejected, seen', 'user', 'rejected', true, false],
      ['pending', 'user', 'pending', false, false],
      ['rejected, master role', 'master', 'rejected', false, false],
      ['never applied', 'user', null, false, false],
    ] as const)('%s', async (_label, role, status, seen, routed) => {
      __setReadyForTest(true)
      setAuthUser({
        id: 'user_1',
        role,
        ...(status ? { master_application: { status } } : {}),
      })
      if (seen) localStorage.setItem(masterRejectionSeenKey('user_1'), '1')
      expect(toVerdict(await call(roleRedirect))).toBe(routed)
      expect(toVerdict(roleFreshnessGuard({ name: 'user-calendar' }))).toBe(routed)
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

    // B1 (PROMPT №726): roleGuard('master') admits role=='admin' too, with no
    // role change involved -- an admin never gets caught by the role-guard
    // demotion a real master would. Without a forced refetch, an admin whose
    // master profile is revoked mid-session (role stays 'admin', only the
    // profile flips to 'suspended') keeps passing on the stale cached
    // 'verified' value for the rest of the session. These two prove the FIX
    // by asserting the actual force argument fetchMyProfile is called with --
    // confirmed red against the pre-fix code (which always calls it with no
    // argument at all) before this test file was left in its fixed state.
    it('B1: admin role forces a real refetch, even with an already-cached verified profile', async () => {
      setAuthUser({ role: 'admin' })
      masterStoreState.profile = { status: 'verified' }
      await call(masterStatusGuard)
      expect(fetchMyProfile).toHaveBeenCalledWith(true)
    })

    it('B1: a real master keeps the lazy skip-if-loaded behaviour -- no forced refetch', async () => {
      setAuthUser({ role: 'master' })
      masterStoreState.profile = { status: 'verified' }
      await call(masterStatusGuard)
      expect(fetchMyProfile).toHaveBeenCalledWith(false)
    })
  })

  // FE-157: B1's refetch for an admin used to leave on EVERY check. It now
  // leaves at most once per ADMIN_PROFILE_TTL_MS per account; in between, the
  // store's last answer decides.
  describe('masterStatusGuard: the admin profile TTL', () => {
    it('a second check inside the window sends no request', async () => {
      setAuthUser({ role: 'admin' })
      masterStoreState.profile = { status: 'verified' }
      expect(await call(masterStatusGuard)).toBe(true)
      expect(await call(masterStatusGuard)).toBe(true)
      expect(fetchMyProfile).toHaveBeenCalledTimes(1)
      expect(fetchMyProfile).toHaveBeenCalledWith(true)
    })

    it('inside the window the cached answer still decides', async () => {
      setAuthUser({ role: 'admin' })
      masterStoreState.profile = { status: 'verified' }
      expect(await call(masterStatusGuard)).toBe(true)
      // The store learned of a suspension some other way (a screen's own
      // forced fetch): no request from the guard, and it reads the news.
      masterStoreState.profile = { status: 'suspended' }
      expect(await call(masterStatusGuard)).toEqual({ path: '/master/pending' })
      expect(fetchMyProfile).toHaveBeenCalledTimes(1)
    })

    it('once the window has passed, the next check refetches', async () => {
      vi.useFakeTimers()
      setAuthUser({ role: 'admin' })
      masterStoreState.profile = { status: 'verified' }
      await call(masterStatusGuard)
      vi.advanceTimersByTime(ADMIN_PROFILE_TTL_MS - 1)
      await call(masterStatusGuard)
      expect(fetchMyProfile).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1)
      await call(masterStatusGuard)
      expect(fetchMyProfile).toHaveBeenCalledTimes(2)
    })

    it("another account is not served by the previous account's window", async () => {
      setAuthUser({ id: 'admin_a', role: 'admin' })
      await call(masterStatusGuard)
      setAuthUser({ id: 'admin_b', role: 'admin' })
      await call(masterStatusGuard)
      expect(fetchMyProfile).toHaveBeenCalledTimes(2)
    })

    it('a real master never forces: the lazy fetch on every check, as before', async () => {
      setAuthUser({ role: 'master' })
      masterStoreState.profile = { status: 'verified' }
      await call(masterStatusGuard)
      await call(masterStatusGuard)
      expect(fetchMyProfile).not.toHaveBeenCalledWith(true)
    })
  })

  // FE-157: the store keeps no error kind -- a 403 for an unverified
  // application and a dropped connection both leave it WITHOUT a profile
  // (profile null, profileMissing false). GET /users/me's
  // master_application tells them apart; no answer at all is not a verdict.
  describe('masterStatusGuard: a request without an answer is not a verdict', () => {
    function stubFetchMe(result: { succeeds: boolean; application?: { status: string } }) {
      return vi.spyOn(useAuthStore(), 'fetchMe').mockImplementation(async () => {
        if (result.succeeds && result.application) {
          setAuthUser({ role: 'master', master_application: result.application })
        }
        return result.succeeds
      })
    }

    it('no profile, /users/me already says verified: the screen opens, not the verdict screen', async () => {
      setAuthUser({ role: 'master', master_application: { status: 'verified' } })
      const fetchMe = stubFetchMe({ succeeds: false })
      expect(await call(masterStatusGuard)).toBe(true)
      expect(fetchMe).not.toHaveBeenCalled()
    })

    it('no profile and nothing known, /users/me unreachable too: the screen opens', async () => {
      setAuthUser({ role: 'master' })
      const fetchMe = stubFetchMe({ succeeds: false })
      expect(await call(masterStatusGuard)).toBe(true)
      expect(fetchMe).toHaveBeenCalledTimes(1)
    })

    it('no profile, /users/me says pending (the 403 was a verdict): /master/pending', async () => {
      setAuthUser({ role: 'master', master_application: { status: 'pending' } })
      expect(await call(masterStatusGuard)).toEqual({ path: '/master/pending' })
    })

    it('fresh sign-in (no master_application yet): /users/me is asked once and decides', async () => {
      setAuthUser({ role: 'master' })
      const fetchMe = stubFetchMe({ succeeds: true, application: { status: 'rejected' } })
      expect(await call(masterStatusGuard)).toEqual({ path: '/master/pending' })
      expect(fetchMe).toHaveBeenCalledTimes(1)
    })

    it('the master profile request is not repeated within one check', async () => {
      setAuthUser({ role: 'master', master_application: { status: 'verified' } })
      await call(masterStatusGuard)
      expect(fetchMyProfile).toHaveBeenCalledTimes(1)
      expect(fetchMyProfile).toHaveBeenCalledWith(false)
    })

    it('a loaded profile still wins over /users/me', async () => {
      setAuthUser({ role: 'master', master_application: { status: 'verified' } })
      masterStoreState.profile = { status: 'suspended' }
      expect(await call(masterStatusGuard)).toEqual({ path: '/master/pending' })
    })

    it('an admin without a profile keeps the verdict-screen path (the endpoint refuses admins)', async () => {
      setAuthUser({ role: 'admin', master_application: { status: 'verified' } })
      expect(await call(masterStatusGuard)).toEqual({ path: '/master/pending' })
    })
  })

  describe('masterApplyGuard', () => {
    it.each(['pending', 'verified'])(
      'user with %s application goes to its status, not another form',
      async (status) => {
        __setReadyForTest(true)
        setAuthUser({ role: 'user', master_application: { status } })
        expect(await call(masterApplyGuard)).toEqual({ path: '/master/pending' })
      },
    )

    it.each(['rejected', 'cancelled_by_user', 'suspended'])(
      'allows reapplication after %s',
      async (status) => {
        __setReadyForTest(true)
        setAuthUser({ role: 'user', master_application: { status } })
        expect(await call(masterApplyGuard)).toBe(true)
      },
    )

    it('lets a first-time applicant fill the form', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'user' })
      expect(await call(masterApplyGuard)).toBe(true)
    })

    it('verified master stays in their cabinet', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'master' })
      masterStoreState.profile = { status: 'verified' }
      expect(await call(masterApplyGuard)).toEqual({ path: '/master/dashboard' })
    })
  })

  describe('masterPendingGuard', () => {
    it('pending applicant in a new session can see and withdraw their application', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'user', master_application: { status: 'pending' } })
      expect(sessionStorage.getItem(MASTER_APPLIED_KEY)).toBeNull()
      expect(await call(masterPendingGuard)).toBe(true)
    })

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
  // T21-4/T21-5 (PROMPT №546): roleFreshnessGuard generalizes roleRedirect's
  // rejection branch to EVERY route, not just a fresh nav to '/' -- the
  // actual gap the recon traced (a session already open and simply
  // navigating around never re-checked this at all). Takes `to` directly
  // (not the bare `call()` helper above), and always calls
  // refreshRoleIfStale() first (mocked, asserted separately below).
  describe('roleFreshnessGuard', () => {
    it('always calls refreshRoleIfStale before checking anything', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'user' })
      roleFreshnessGuard({ name: 'user-dashboard' })
      expect(refreshRoleIfStale).toHaveBeenCalledTimes(1)
    })

    it('rejected applicant, not yet seen, navigating anywhere else -> routed to /master/pending', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'user', master_application: { status: 'rejected' } })
      expect(roleFreshnessGuard({ name: 'user-calendar' })).toEqual({
        path: '/master/pending',
      })
    })

    it('does not redirect a navigation already headed to master-pending (avoids a loop)', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'user', master_application: { status: 'rejected' } })
      expect(roleFreshnessGuard({ name: 'master-pending' })).toBe(true)
    })

    it("rejected applicant, already seen -> allowed through (matches roleRedirect's own rule)", async () => {
      __setReadyForTest(true)
      setAuthUser({ id: 'user_1', role: 'user', master_application: { status: 'rejected' } })
      localStorage.setItem(masterRejectionSeenKey('user_1'), '1')
      expect(roleFreshnessGuard({ name: 'user-profile' })).toBe(true)
    })

    it('non-rejected user navigating around -> allowed through', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'user' })
      expect(roleFreshnessGuard({ name: 'user-dashboard' })).toBe(true)
    })

    it('master/admin roles -> allowed through (the rejection condition requires role=user)', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'master' })
      expect(roleFreshnessGuard({ name: 'master-dashboard' })).toBe(true)
    })

    // -- PROMPT №550: guard cost fix -- refreshRoleIfStale is fire-and-forget,
    // and its scope stays every-role (not gated to role='user'). ------------
    it('still refreshes for a master role, not only role=user -- a revoked master must keep learning about it', async () => {
      __setReadyForTest(true)
      setAuthUser({ role: 'master' })
      roleFreshnessGuard({ name: 'master-dashboard' })
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

      const result = roleFreshnessGuard({ name: 'user-dashboard' })

      expect(result).toBe(true)
      expect(refreshSettled).toBe(false)
    })
  })

  // =============================================================================
  // FE-157: the access guard (installAccessGuard) -- meta.requires replaces the
  // per-record beforeEnter role/status guards. Driven through a REAL router
  // (memory history) over a stub table shaped like the master zone, so the
  // "entering" rule is vue-router's own matching, not a re-implementation.
  // =============================================================================
  describe('installAccessGuard + requirementsGuard', () => {
    const Stub = defineComponent({ render: () => h('div') })

    function accessRouter() {
      const router = createRouter({
        history: createMemoryHistory(),
        routes: [
          { path: '/', component: Stub },
          { path: '/user/dashboard', name: 'user-dashboard', component: Stub },
          { path: '/user/calendar', name: 'user-calendar', component: Stub },
          { path: '/master/pending', name: 'master-pending', component: Stub },
          { path: '/master/apply', component: Stub },
          { path: '/admin/dashboard', component: Stub },
          {
            path: '/master',
            component: Stub,
            meta: { requires: 'master-role' },
            children: [
              { path: 'dashboard', component: Stub, meta: { requires: 'master-application' } },
              { path: 'inbox', component: Stub },
              { path: 'practices/:id', component: Stub, meta: { requires: 'verified-master' } },
              { path: 'groups', component: Stub, meta: { requires: 'verified-master' } },
            ],
          },
        ],
      })
      installAccessGuard(router)
      return router
    }

    async function go(router: ReturnType<typeof accessRouter>, path: string): Promise<string> {
      await router.push(path)
      return router.currentRoute.value.fullPath
    }

    beforeEach(() => {
      __setReadyForTest(true)
    })

    it('the parent role requirement runs first: a user never reaches the status check', async () => {
      setAuthUser({ role: 'user' })
      const router = accessRouter()
      expect(await go(router, '/master/practices/p1')).toBe('/user/dashboard')
      expect(fetchMyProfile).not.toHaveBeenCalled()
    })

    it('verified master: the shell and the screen pass', async () => {
      setAuthUser({ role: 'master' })
      masterStoreState.profile = { status: 'verified' }
      const router = accessRouter()
      expect(await go(router, '/master/practices/p1')).toBe('/master/practices/p1')
    })

    it('pending master: a verified-master screen redirects, an open one does not', async () => {
      setAuthUser({ role: 'master' })
      masterStoreState.profile = { status: 'pending' }
      const router = accessRouter()
      expect(await go(router, '/master/groups')).toBe('/master/pending')
      expect(await go(router, '/master/inbox')).toBe('/master/inbox')
    })

    it('a deep link into a verified-master screen survives a dropped profile request', async () => {
      setAuthUser({ role: 'master' })
      vi.spyOn(useAuthStore(), 'fetchMe').mockResolvedValue(false)
      const router = accessRouter()
      expect(await go(router, '/master/practices/p1')).toBe('/master/practices/p1')
    })

    it('no-application master on the dashboard goes to the apply wizard', async () => {
      setAuthUser({ role: 'master' })
      masterStoreState.profileMissing = true
      const router = accessRouter()
      expect(await go(router, '/master/dashboard')).toBe('/master/apply')
    })

    // The beforeEnter rule the 21 per-record guards had: a record the
    // navigation does not ENTER is not checked again.
    it('a param change inside one screen does not re-run its check', async () => {
      setAuthUser({ role: 'master' })
      masterStoreState.profile = { status: 'verified' }
      const router = accessRouter()
      await go(router, '/master/practices/p1')
      const calls = fetchMyProfile.mock.calls.length

      masterStoreState.profile = { status: 'pending' }
      expect(await go(router, '/master/practices/p2')).toBe('/master/practices/p2')
      expect(fetchMyProfile.mock.calls.length).toBe(calls)

      // Entering a sibling record checks it.
      expect(await go(router, '/master/groups')).toBe('/master/pending')
    })

    it('a move between two screens of the shell does not re-run the shell role check', async () => {
      setAuthUser({ role: 'master' })
      const router = accessRouter()
      await go(router, '/master/inbox')

      setAuthUser({ role: 'user' })
      expect(await go(router, '/master/inbox?tab=all')).toBe('/master/inbox?tab=all')
      expect(await go(router, '/master/dashboard')).toBe('/master/dashboard')

      // Re-entering the shell from outside checks the role again.
      await go(router, '/user/calendar')
      expect(await go(router, '/master/inbox')).toBe('/user/dashboard')
    })

    it('requirementsGuard reads each record, not the merged meta', async () => {
      setAuthUser({ role: 'user' })
      const router = accessRouter()
      const to = router.resolve('/master/practices/p1')
      // The merged meta carries only the child's requirement ...
      expect(to.meta.requires).toBe('verified-master')
      // ... yet the parent's role requirement still decides first.
      expect(await requirementsGuard(to, router.resolve('/'))).toEqual({ path: '/user/dashboard' })
    })

    it('P-1 runs in the same guard: a master on the user dashboard goes to the master zone', async () => {
      setAuthUser({ role: 'master' })
      const router = accessRouter()
      expect(await go(router, '/user/dashboard')).toBe('/master/dashboard')
    })
  })

  describe('zoneHomeGuard (P-1)', () => {
    it.each([
      ['admin', { path: '/admin/dashboard' }],
      ['master', { path: '/master/dashboard' }],
      ['user', true],
    ] as const)('%s opening the user dashboard', (role, expected) => {
      setAuthUser({ role })
      expect(zoneHomeGuard({ name: 'user-dashboard', path: '/user/dashboard' })).toEqual(expected)
    })

    it('the user mode keeps a master on the user dashboard', () => {
      setAuthUser({ role: 'master' })
      useUiStore().setUiMode('user')
      expect(zoneHomeGuard({ name: 'user-dashboard', path: '/user/dashboard' })).toBe(true)
    })

    it('any other user-zone screen is left alone', () => {
      setAuthUser({ role: 'admin' })
      expect(zoneHomeGuard({ name: 'user-calendar', path: '/user/calendar' })).toBe(true)
    })
  })

  describe('optionGuard (FE-151: instance options)', () => {
    const Stub = defineComponent({ render: () => h('div') })

    function optionRouter() {
      const router = createRouter({
        history: createMemoryHistory(),
        routes: [
          { path: '/', component: Stub },
          { path: '/404', name: 'not-found', component: Stub },
          {
            path: '/user',
            component: Stub,
            children: [
              { path: 'dashboard', component: Stub },
              { path: 'topup', component: Stub, meta: { option: 'payments' } },
              { path: 'schools', component: Stub, meta: { option: 'schools' } },
            ],
          },
          {
            path: '/schools',
            component: Stub,
            meta: { option: 'schools' },
            children: [{ path: 'join/:token', component: Stub }],
          },
        ],
      })
      installAccessGuard(router)
      return router
    }

    beforeEach(() => {
      __setReadyForTest(true)
      setAuthUser({ role: 'user' })
    })
    afterEach(() => {
      applyInstanceConfig(null)
    })

    it('no options block (golden build): every option record is open', async () => {
      const router = optionRouter()
      await router.push('/user/topup')
      expect(router.currentRoute.value.fullPath).toBe('/user/topup')
    })

    it('an option off: its record lands on /404; another option stays open', async () => {
      applyInstanceConfig({ options: { payments: 'false', schools: 'true' } })
      const router = optionRouter()
      await router.push('/user/dashboard')
      await router.push('/user/topup')
      expect(router.currentRoute.value.fullPath).toBe('/404')
      await router.push('/user/schools')
      expect(router.currentRoute.value.fullPath).toBe('/user/schools')
    })

    it('an unset flag (placeholder) is off', async () => {
      applyInstanceConfig({ options: { payments: 'true', schools: '${OPTION_SCHOOLS}' } })
      const router = optionRouter()
      await router.push('/user/schools')
      expect(router.currentRoute.value.fullPath).toBe('/404')
    })

    it('a parent record carrying the option closes every child', () => {
      applyInstanceConfig({ options: { schools: 'false' } })
      const router = optionRouter()
      expect(optionGuard(router.resolve('/schools/join/t1'))).toEqual({
        path: '/404',
        replace: true,
      })
      expect(optionGuard(router.resolve('/user/dashboard'))).toBe(true)
    })
  })
})
