// =============================================================================
// VELO Frontend -- MasterInviteClaimView Screen Tests
// =============================================================================
//
// WHY THIS FILE EXISTS (probekit-screen-test audit, rank 1 of the untested-20
// table, SCREEN-TEST-AUDIT-20260810.md Part 1): the audit scored this screen
// "likely irreversible (+5, unconfirmed)" and explicitly said it "did not read
// the backend to confirm there truly is none [unclaim/revoke counterpart]."
// That recon was done before writing this file:
//
//   claimMasterInvite() (api/masters.ts:63-65) -> POST /api/v1/masters/invite/claim
//   -> backend/app/modules/masters/router.py:183-200 (claim_master_invite_endpoint)
//   -> backend/app/modules/masters/service.py:647-674 (claim_master_invite)
//
// service.py:660-674 is the actual mechanism: the token is SHA-256 hashed and
// burned from Redis with `GETDEL` -- an ATOMIC single-command read-and-delete
// (service.py:665, comment at :663-664: "no interleave between the check and
// the burn, so two concurrent claims can never both succeed"). Once burned,
// `stored is None` on any later attempt -> NotFoundError code=invite_invalid
// (service.py:666-670). There is no un-burn: grepped the whole admin/masters
// surface (router.py) for a revoke/unclaim/regenerate counterpart --
//   - POST /invite (admin/masters/router.py:54-67) issues a NEW invite with a
//     NEW token; it does not restore a burned one.
//   - POST /{user_id}/revoke (admin/masters/router.py:138-153) revokes an
//     ALREADY-VERIFIED master's capability -- a completely different lifecycle
//     stage (post-approval), not a counterpart to burning an invite token.
// CONFIRMED: claiming IS irreversible for that specific token, exactly as the
// audit guessed, now with backend evidence rather than an absent-inverse guess.
//
// ALSO WORTH KNOWING (does not change the irreversibility verdict, kept out of
// the screen's own test surface): claim_master_invite's own docstring
// (service.py:653-655) says "Becoming a master still goes through the regular
// apply wizard + admin approval loop; nothing is verified here" -- so burning
// the token does not itself grant any capability. It only unlocks entry to the
// existing apply wizard (MasterApplyView, its own screen). The irreversible
// thing is consuming the ONE-TIME LINK, not a role grant.
//
// PATTERN: a pure state machine over one API call, no store. @/api/masters is
// the seam (module-mocked). vue-router fully replaced (no RouterView, no
// transitive @/router import in this screen -- checked: only api/masters,
// api/client, composables/useToast, and two DS components).
//
// TRAPS PRESENT:
//  - SC-05-adjacent: the honest-failure copy ("Ссылка недействительна...") is
//    the screen's OWN hardcoded string, not the backend's -- the backend's
//    invite_invalid detail is "Invite link is invalid or already used"
//    (service.py:668), never rendered. Asserted as the screen's own constant,
//    not claimed as backend-message passthrough.
//  - W11 split (.vue:80-92, comment at :25-27): a genuine invite_invalid 404
//    is the ONLY thing that renders the honest dead-link state. Every other
//    failure shape (a different ApiResponseError code, a network TypeError)
//    is transient and offers a retry instead of declaring the link dead --
//    tested from both sides so neither branch is a guess.
//
// TRAPS ABSENT:
//  - NO VModal/VBottomSheet anywhere in this screen -- grepped the SFC. No
//    SC-13 purge needed.
//  - NO wall clock, no money, no v-show, no list, no pagination.
//
// SEPARATE FINDING, not fixed here (BOUNDARIES: source not modified) --
// recorded for the operator: claim() (.vue:70-96) sets `claiming.value = true`
// UNCONDITIONALLY at its top with no `if (claiming.value) return` guard, unlike
// every other re-entrant handler audited elsewhere in this codebase (e.g.
// MasterPendingView's onWithdraw/switchRole). A zero-tick double-tap on
// «Повторить» (VButton's :loading->:disabled binding needs a render tick it
// hasn't had yet) fires claimMasterInvite() twice concurrently. This is LOW
// SEVERITY, not the same class as the money/withdrawal-grade races found
// elsewhere: Redis GETDEL is atomic (service.py:663-665), so the second
// in-flight call always resolves invite_invalid rather than double-consuming
// anything -- it is a UI state race (whichever promise settles last wins
// claiming/errorTitle/transientError), not a data-integrity one. Not asserted
// as a test here (asserting today's un-guarded behaviour would just pin the
// gap rather than prove anything); flagged in the report instead.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import MasterInviteClaimView from '@/views/master/MasterInviteClaimView.vue'
import * as mastersApi from '@/api/masters'
import { ApiResponseError } from '@/api/client'

vi.mock('@/api/masters')

const push = vi.fn()
const replace = vi.fn()
const routeParams: { token?: string } = { token: 'tok_abc123' }
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: routeParams }),
  useRouter: () => ({ push, replace }),
}))

const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: toastSuccess, error: vi.fn(), info: vi.fn() }),
}))

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(MasterInviteClaimView)
  app.mount(host)
  return host
}

// Chain: onMounted -> claim() -> await claimMasterInvite (1) -> success/catch
// branch (sync) -> finally claiming=false -> re-render (1). 4 ticks leaves
// margin over the counted 2.
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll('button') ?? []).find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined
}

beforeEach(() => {
  routeParams.token = 'tok_abc123'
  vi.mocked(mastersApi.claimMasterInvite).mockReset()
  push.mockReset()
  replace.mockReset()
  toastSuccess.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('MasterInviteClaimView', () => {
  describe('the state ladder', () => {
    it('shows the loader while the claim is in flight, no verdict yet', async () => {
      vi.mocked(mastersApi.claimMasterInvite).mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(host?.querySelector('.v-loader')).not.toBeNull()
      expect(text()).toContain('Проверяем приглашение…')
      expect(text()).not.toContain('Ссылка недействительна')
    })

    it('claims with the token straight off the route param', async () => {
      vi.mocked(mastersApi.claimMasterInvite).mockReturnValue(new Promise(() => {}))
      routeParams.token = 'tok_xyz999'
      mount()
      await flush()

      expect(mastersApi.claimMasterInvite).toHaveBeenCalledWith('tok_xyz999')
    })

    it('success: toasts and hands off to the apply wizard, never the honest-failure copy', async () => {
      vi.mocked(mastersApi.claimMasterInvite).mockResolvedValue({
        claimed_at: '2026-08-10T12:00:00Z',
      })
      mount()
      await flush()

      expect(toastSuccess).toHaveBeenCalledWith('Приглашение принято!')
      expect(replace).toHaveBeenCalledWith({ name: 'master-apply' })
      expect(text()).not.toContain('Ссылка недействительна')
      expect(text()).not.toContain('Не удалось проверить приглашение')
    })
  })

  describe('the W11 split: dead link vs. transient blip', () => {
    it('a genuine invite_invalid 404 is the ONLY thing that declares the link dead', async () => {
      // Mirrors the real backend contract for an already-burned token
      // (service.py:666-670: GETDEL found nothing -> NotFoundError
      // code=invite_invalid). This is the exact shape a re-claim of an
      // already-consumed one-time link produces.
      vi.mocked(mastersApi.claimMasterInvite).mockRejectedValue(
        new ApiResponseError(404, 'Invite link is invalid or already used', 'invite_invalid'),
      )
      mount()
      await flush()

      expect(text()).toContain('Ссылка недействительна')
      expect(text()).toContain('Приглашение одноразовое')
      // The screen's OWN copy, not the backend's -- the real detail string
      // never reaches the DOM on this path (SC-05-adjacent).
      expect(text()).not.toContain('Invite link is invalid or already used')
      expect(button('Повторить')).toBeUndefined()
      expect(host?.querySelector('.v-loader')).toBeNull()
    })

    it('«На главную» on the dead-link state routes to the user dashboard, not back into the wizard', async () => {
      vi.mocked(mastersApi.claimMasterInvite).mockRejectedValue(
        new ApiResponseError(404, 'Invite link is invalid or already used', 'invite_invalid'),
      )
      mount()
      await flush()

      button('На главную')?.click()
      await flush()

      expect(replace).toHaveBeenCalledWith({ name: 'user-dashboard' })
      expect(push).not.toHaveBeenCalled()
    })

    it('a DIFFERENT ApiResponseError code is treated as transient, not a dead link', async () => {
      // e.g. a 401/403/500 shape unrelated to invite_invalid -- the code, not
      // the mere fact of an ApiResponseError, is what the screen keys on
      // (.vue:85).
      vi.mocked(mastersApi.claimMasterInvite).mockRejectedValue(
        new ApiResponseError(500, 'Внутренняя ошибка', 'server_error'),
      )
      mount()
      await flush()

      expect(text()).toContain('Не удалось проверить приглашение')
      expect(text()).toContain('Проблема с соединением')
      expect(text()).not.toContain('Ссылка недействительна')
      expect(button('Повторить')).toBeDefined()
    })

    it('a plain network error (not ApiResponseError) is ALSO transient', async () => {
      vi.mocked(mastersApi.claimMasterInvite).mockRejectedValue(new TypeError('Failed to fetch'))
      mount()
      await flush()

      expect(text()).toContain('Не удалось проверить приглашение')
      expect(text()).not.toContain('Ссылка недействительна')
      expect(button('Повторить')).toBeDefined()
    })

    it('«Повторить» re-runs the claim, and a second success completes the hand-off', async () => {
      vi.mocked(mastersApi.claimMasterInvite).mockRejectedValue(new TypeError('Failed to fetch'))
      mount()
      await flush()
      expect(mastersApi.claimMasterInvite).toHaveBeenCalledTimes(1)

      vi.mocked(mastersApi.claimMasterInvite).mockResolvedValue({
        claimed_at: '2026-08-10T12:00:00Z',
      })
      button('Повторить')?.click()
      await flush()

      expect(mastersApi.claimMasterInvite).toHaveBeenCalledTimes(2)
      expect(mastersApi.claimMasterInvite).toHaveBeenNthCalledWith(2, 'tok_abc123')
      expect(toastSuccess).toHaveBeenCalledWith('Приглашение принято!')
      expect(replace).toHaveBeenCalledWith({ name: 'master-apply' })
    })

    it('«Повторить» that fails AGAIN with invite_invalid moves off the transient copy onto the honest dead-link one', async () => {
      // Proves the two branches are not stuck once entered -- a second,
      // DIFFERENT outcome re-keys the whole ladder, not just a sub-region.
      vi.mocked(mastersApi.claimMasterInvite).mockRejectedValue(new TypeError('Failed to fetch'))
      mount()
      await flush()
      expect(button('Повторить')).toBeDefined()

      vi.mocked(mastersApi.claimMasterInvite).mockRejectedValue(
        new ApiResponseError(404, 'Invite link is invalid or already used', 'invite_invalid'),
      )
      button('Повторить')?.click()
      await flush()

      expect(text()).toContain('Ссылка недействительна')
      expect(text()).not.toContain('Не удалось проверить приглашение')
      expect(button('Повторить')).toBeUndefined()
    })
  })

  describe('a missing route token', () => {
    it('an absent token param claims the literal empty string rather than crashing', async () => {
      // route.params.token ?? '' (.vue:74) -- a malformed deeplink still
      // reaches the same POST, coercing to ''; the backend is the one that
      // decides that hash is invite_invalid, not the frontend guessing early.
      routeParams.token = undefined
      vi.mocked(mastersApi.claimMasterInvite).mockRejectedValue(
        new ApiResponseError(404, 'Invite link is invalid or already used', 'invite_invalid'),
      )
      mount()
      await flush()

      expect(mastersApi.claimMasterInvite).toHaveBeenCalledWith('')
      expect(text()).toContain('Ссылка недействительна')
    })
  })
})

// =============================================================================
// NOT COVERED, deliberately
// =============================================================================
// - The zero-tick double-tap re-entry gap on «Повторить» (see the banner's
//   SEPARATE FINDING above) -- not asserted; today's behaviour is a UI-only
//   race the atomic backend burn already protects against, not a data bug.
// - applyGuard (router/index.ts:32-48), which is what actually keeps a
//   verified master from reaching this route at all -- that is route-guard
//   behaviour, private to router/index.ts (not exported, unlike guards.ts),
//   and out of this screen's own test surface.
// =============================================================================
