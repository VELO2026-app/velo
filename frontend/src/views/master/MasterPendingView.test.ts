// =============================================================================
// VELO Frontend -- MasterPendingView Screen Tests
// =============================================================================
//
// WHY THIS FILE EXISTS
//
// One screen, three verdicts, and the only place an applicant can pull their
// own application back:
//
//   onWithdraw() (MasterPendingView.vue:225) DELETEs /masters/me/application.
//
// IS THAT REVERSIBLE? Followed one level down rather than trusting the dialog's
// own promise («Подать новую заявку можно в любой момент») or the wrapper's
// docstring -- a string is not evidence:
//   - service.withdraw_master_application (masters/service.py:270-311) flips
//     data.account.status to "cancelled_by_user". The User row is untouched
//     (pinned: test_withdraw_application_success asserts role/is_active).
//   - Re-applying afterwards genuinely works: apply_for_master only special-
//     cases "pending"/"verified", so "cancelled_by_user" falls through to the
//     generic reapply path (pinned: test_reapply_after_withdrawal_succeeds).
//   So the CLAIM IS TRUE and this is NOT an AdminWithdrawalDetailView-grade
//   one-way door: no money moves, nothing is deleted.
//
// It is still a one-way door in the small: there is no un-withdraw endpoint
// (a second DELETE is a 409 -- "Only a pending application can be withdrawn"),
// the way back is a NEW 3-step application that overwrites the profile data in
// place, and the queue position is gone. So the assertions that earn their keep
// are weighted accordingly: one click must never withdraw, two clicks must be
// ONE DELETE, and a FAILED withdraw must never claim success, never navigate,
// and never drop the applicant marker.
//
// THE APPLICANT MARKER IS NOT COSMETIC. masterPendingGuard (guards.ts:230) lets
// a role='user' onto /master/pending precisely because sessionStorage holds
// MASTER_APPLIED_KEY. onWithdraw removes it (:232) -- if a failed withdraw
// removed it anyway, the applicant would be bounced off their own still-live
// pending screen.
//
// PATTERN A-ish, degenerate: all state is read from two stores and there is no
// local form. Both stores are DEPENDENCIES, not the thing under test, so both
// are module-mocked behind getters over a mutable object (velo-idiom §5, the
// guards.test.ts trick). @/api/masters is the seam for the one direct API call.
//
// The mutable objects are reactive() and not plain: unlike EditPracticeView's
// fixtures, some tests here MUTATE store state after mount (a fetchMe that
// lands an approval, a profileLoading that flips) and a plain object behind a
// getter would never re-render.
//
// NO PINIA, verified rather than assumed. Both stores are module-mocked, and no
// child in this tree resolves a store of its own: the screen renders only
// VLoader / VCard / VButton / VConfirmDialog -> VModal -> IconClose, while a grep
// for use*Store across src/components hits ONLY RoleSwitchSection, WeekStrip,
// BookingPopup and DiaryComposer -- none of them reachable from here. Installing
// a Pinia to look like the PracticeDetailView precedent would be cargo.
//
// TRAPS PRESENT
//   - SC-13 (teleported overlay): VConfirmDialog renders through VModal, which
//     is `Teleport to="body"` (VModal.vue:20). Queried from document.body, NOT
//     from host (SC-07), and PURGED in afterEach (SC-13).
//   - SC-13b: proving the dialog closed by asserting the overlay is GONE never
//     passes -- it parks at .v-modal-leave-active awaiting a transitionend
//     happy-dom never fires. dialogLeaving() asserts the leave STARTED, pinned
//     false while open so it cannot always-pass.
//   - SC-13c: cancel-then-inspect parks a corpse mid-test, so every live-dialog
//     query is scoped `:not(.v-modal-leave-active)`.
//   - SC-15: every negative-space assertion is preceded by a positive one (the
//     verdict title), so "no withdraw link" cannot pass on a blank mount.
//
// TRAPS ABSENT -- grepped, and recorded so the next agent does not cargo-cult
// setup this screen has no use for:
//   - NO wall clock. No Date.now()/new Date() anywhere in the SFC, and nothing
//     it renders is time-derived. vi.setSystemTime would be dead setup.
//   - NO money. No formatMoney, no amounts -- the ru U+00A0 trap (velo-idiom
//     §11) cannot bite, so there is no norm() helper here on purpose.
//   - NO v-show (SC-14). The three verdicts are `<template v-if/v-else-if/
//     v-else>`, so exactly ONE branch is in the DOM and whole-host assertions
//     are honest. No tab strip either.
//   - NO preview cap (SC-16), no list at all.
//   - NO window.history.state, no navigator.clipboard, no window.location.href.
//   - NO bottom sheet (.v-sheet__overlay); the only overlay is .v-modal__overlay.
//
// THE FETCH IS A SEAM THAT DOES NOT MUTATE STATE. fetchMe/fetchMyProfile are
// spies, so a fixture set before mount represents the POST-fetch account. The
// one test that cares about the refresh itself ("an approval that lands on this
// mount") makes its fetchMe spy mutate authState, which is the real property:
// the screen re-keys off whatever /users/me just said.
//
// NO ORDER DEPENDENCE. Declaration order is execution order, but nothing here
// relies on it; localStorage/sessionStorage are cleared per test.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, reactive, type App } from 'vue'
import MasterPendingView from '@/views/master/MasterPendingView.vue'
import * as mastersApi from '@/api/masters'
import { ApiResponseError } from '@/api/client'
import {
  MASTER_APPLIED_KEY,
  masterApprovedSeenKey,
  masterRejectionSeenKey,
} from '@/utils/constants'
import type {
  MasterApplicationInfo,
  MasterProfileResponse,
  UserResponse,
  UserRole,
} from '@/api/types'

vi.mock('@/api/masters')

const push = vi.fn()
const replace = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, replace, back: vi.fn() }),
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: vi.fn() }),
}))

// -- The two dependency stores (velo-idiom §5): getters over a mutable reactive
//    object, so a test mutates state instead of re-mocking. The spies live
//    inside the returned object literal of a nested arrow -- never dereferenced
//    at factory top level -- so the hoisted factory cannot TDZ-crash.

const authState = reactive<{
  role: UserRole | null
  allowedRoles: UserRole[]
  masterApplication: MasterApplicationInfo | null
  user: { id: string } | null
}>({
  role: 'user',
  allowedRoles: [],
  masterApplication: null,
  user: { id: 'u1' },
})
const fetchMe = vi.fn()
const switchRole = vi.fn()
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    get role() {
      return authState.role
    },
    get allowedRoles() {
      return authState.allowedRoles
    },
    get masterApplication() {
      return authState.masterApplication
    },
    get user() {
      return authState.user
    },
    fetchMe,
    switchRole,
  }),
}))

const masterState = reactive<{
  profileLoading: boolean
  profile: MasterProfileResponse | null
}>({
  profileLoading: false,
  profile: null,
})
const fetchMyProfile = vi.fn()
vi.mock('@/stores/master', () => ({
  useMasterStore: () => ({
    get profileLoading() {
      return masterState.profileLoading
    },
    get profile() {
      return masterState.profile
    },
    fetchMyProfile,
  }),
}))

function profile(overrides: Partial<MasterProfileResponse> = {}): MasterProfileResponse {
  return {
    user_id: 'u1',
    status: 'pending',
    display_name: 'Мастер',
    bio: null,
    methods: [],
    languages: [],
    experience_years: 3,
    frozen_cents: 0,
    available_cents: 0,
    min_withdrawal_cents: 5000,
    withdrawal_fee_cents: 0,
    payout: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: null,
    rejection_reason: null,
    ...overrides,
  }
}

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(MasterPendingView)
  app.mount(host)
  return host
}

// COUNTED, not copied (velo-idiom §3). The chains this screen kicks off:
//   mount -> onMounted awaits fetchMe|fetchMyProfile (1) -> its continuation
//   writes localStorage / calls router.replace (1) -> re-render (1).
//   onWithdraw -> await withdrawMasterApplication (1) -> continuation toasts +
//   replaces (1) -> `finally` lowers withdrawing/confirmWithdrawOpen -> the
//   dialog's leave transition re-render (1).
// Deepest measured is 3; five leaves margin and an over-count is harmless.
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}

function withdrawLink(): HTMLButtonElement | null {
  return host?.querySelector<HTMLButtonElement>('.pending-view__withdraw-link') ?? null
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
    b.textContent?.includes(label),
  ) as HTMLButtonElement | undefined
}

// -- The confirm dialog is TELEPORTED to document.body (VModal.vue:20), so it is
//    NOT under host (SC-07). Scoped past any corpse parked mid-test (SC-13c).

function liveDialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('.v-modal__overlay:not(.v-modal-leave-active)')
}

function dialogText(): string {
  return liveDialog()?.querySelector('.v-confirm__text')?.textContent ?? ''
}

function dialogButton(label: string): HTMLButtonElement | undefined {
  const actions = liveDialog()?.querySelector('.v-confirm__actions')
  return Array.from(actions?.querySelectorAll('button') ?? []).find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined
}

/** SC-13b: the overlay is never REMOVED in happy-dom -- it parks mid-leave. */
function dialogLeaving(): boolean {
  return !!document.body.querySelector('.v-modal-leave-active')
}

/** Open the withdraw confirm the way an applicant does. */
async function openWithdrawDialog(): Promise<void> {
  withdrawLink()?.click()
  await flush()
}

beforeEach(() => {
  authState.role = 'user'
  authState.allowedRoles = []
  authState.masterApplication = null
  authState.user = { id: 'u1' }
  masterState.profileLoading = false
  masterState.profile = null

  vi.mocked(mastersApi.withdrawMasterApplication).mockReset().mockResolvedValue(undefined)
  fetchMe.mockReset().mockResolvedValue(undefined)
  fetchMyProfile.mockReset().mockResolvedValue(undefined)
  switchRole.mockReset().mockResolvedValue({} as UserResponse)
  push.mockReset()
  replace.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()

  localStorage.clear()
  sessionStorage.clear()
  sessionStorage.setItem(MASTER_APPLIED_KEY, '1')
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null

  // MANDATORY (SC-13). A CLOSED teleported overlay survives app.unmount():
  // VModal wraps it in a <Transition> (VModal.vue:21-22) and when `open` flips
  // to false Vue holds the leaving element pending a transitionend happy-dom
  // never fires. It stays parked directly on document.body, outliving the app
  // that owns its handlers -- the next test then finds the DEAD dialog first in
  // document order, clicks it, and nothing happens. The signature is that the
  // FIRST dialog test in a file passes and every later one fails while the
  // screen is perfectly healthy.
  document.body.querySelectorAll('.v-modal__overlay').forEach((el) => el.remove())

  localStorage.clear()
  sessionStorage.clear()
  vi.clearAllMocks()
})

describe('MasterPendingView', () => {
  describe('the state ladder', () => {
    it('shows the loader while the profile is in flight, and no verdict at all', async () => {
      // A verdict rendered over a half-loaded profile would tell an applicant
      // they were rejected before anyone said so.
      masterState.profileLoading = true
      authState.role = 'master'
      mount()
      await flush()

      expect(host?.querySelector('.v-loader')).not.toBeNull()
      expect(host?.querySelector('.pending-view__card')).toBeNull()
      expect(withdrawLink()).toBeNull()
    })

    it('replaces the loader with the verdict once the profile lands', async () => {
      // The reactive half: the store, not a remount, drives the transition.
      masterState.profileLoading = true
      authState.role = 'master'
      mount()
      await flush()
      expect(host?.querySelector('.v-loader')).not.toBeNull()

      masterState.profile = profile({ status: 'verified' })
      masterState.profileLoading = false
      await flush()

      expect(host?.querySelector('.v-loader')).toBeNull()
      expect(text()).toContain('Ваша заявка одобрена!')
    })

    it('a plain applicant sees «Заявка отправлена!» and the withdraw link', async () => {
      mount()
      await flush()

      expect(text()).toContain('Заявка отправлена!')
      expect(text()).toContain('Рассмотрим за 24–48 часов')
      expect(withdrawLink()?.textContent?.trim()).toBe('Отозвать заявку')
    })

    it('the pending card is the centered layout; the verdicts are not', async () => {
      // isPending (:161) drives --centered. K2: pending is the one state that
      // exists so a person waits calmly on a bare card.
      mount()
      await flush()
      expect(host?.querySelector('.pending-view__content--centered')).not.toBeNull()

      app?.unmount()
      host?.remove()
      authState.allowedRoles = ['user', 'master']
      mount()
      await flush()
      expect(host?.querySelector('.pending-view__content--centered')).toBeNull()
    })
  })

  describe('which status the screen keys on', () => {
    it('a role=user with the master CAPABILITY is approved, not pending', async () => {
      // T4 (:148-157): approval no longer flips the role -- an approved
      // applicant stays role='user' and gains 'master' in allowedRoles. Reading
      // the role alone would leave them staring at «Заявка отправлена» forever.
      authState.allowedRoles = ['user', 'master']
      mount()
      await flush()

      expect(text()).toContain('Ваша заявка одобрена!')
      expect(button('Войти в кабинет')).toBeDefined()
      // Positive pinned above, so this exclusion is real (SC-15): an approved
      // applicant must not be offered a button that withdraws the application
      // that was just granted.
      expect(withdrawLink()).toBeNull()
    })

    it('a role=master reads the verdict off the LOADED PROFILE, not the capability', async () => {
      authState.role = 'master'
      authState.allowedRoles = []
      masterState.profile = profile({ status: 'verified' })
      mount()
      await flush()

      expect(text()).toContain('Ваша заявка одобрена!')
    })

    it('a role=master whose profile has not landed falls back to pending', async () => {
      // `masterStore.profile?.status ?? 'pending'` (:149). Falling back to a
      // verdict instead would announce one that was never issued.
      authState.role = 'master'
      masterState.profile = null
      mount()
      await flush()

      expect(text()).toContain('Заявка отправлена!')
    })

    it('a role=master with a still-pending profile shows the pending card', async () => {
      authState.role = 'master'
      masterState.profile = profile({ status: 'pending' })
      mount()
      await flush()

      expect(text()).toContain('Заявка отправлена!')
      expect(withdrawLink()).not.toBeNull()
    })

    it('a rejected applicant sees the reject card without the master-only endpoint', async () => {
      // T5 (:152-154): the verdict rides GET /users/me, so a role='user' with no
      // capability can be told they were rejected.
      authState.masterApplication = { status: 'rejected', rejection_reason: null }
      mount()
      await flush()

      expect(text()).toContain('Спасибо за заявку!')
      expect(text()).toContain('К сожалению, мы пока не можем одобрить вашу заявку.')
      expect(withdrawLink()).toBeNull()
    })

    it('the CAPABILITY wins over a stale rejected application', async () => {
      // Branch order (:149-156): allowedRoles is checked BEFORE
      // masterApplication. A re-applicant approved on the second attempt whose
      // /users/me still carries the old rejection must see the approval.
      authState.allowedRoles = ['user', 'master']
      authState.masterApplication = { status: 'rejected', rejection_reason: 'Старый отказ' }
      mount()
      await flush()

      expect(text()).toContain('Ваша заявка одобрена!')
      expect(text()).not.toContain('Старый отказ')
    })

    it('a WITHDRAWN application bounces to the user dashboard', async () => {
      // F4 (:195-197). The applicant already withdrew in another tab; there is
      // no card for this state, so the screen must not strand them on one.
      authState.masterApplication = { status: 'cancelled_by_user', rejection_reason: null }
      mount()
      await flush()

      expect(replace).toHaveBeenCalledWith({ name: 'user-dashboard' })
    })

    it('a pending applicant is NOT bounced anywhere', async () => {
      mount()
      await flush()

      expect(replace).not.toHaveBeenCalled()
      expect(push).not.toHaveBeenCalled()
    })
  })

  describe('the rejection reason', () => {
    it('surfaces the REAL reason from the loaded profile', async () => {
      // E14 (:166-173). The reason is the applicant's only instruction on what
      // to change before re-applying; a generic line wastes their second try.
      authState.role = 'master'
      masterState.profile = profile({
        status: 'rejected',
        rejection_reason: 'Не хватает сертификата',
      })
      mount()
      await flush()

      expect(text()).toContain('Не хватает сертификата')
      expect(host?.querySelector('.pending-view__reason-label')?.textContent).toBe('Причина:')
    })

    it("the profile's reason wins over the /users/me copy", async () => {
      // `profile?.rejection_reason ?? masterApplication?.rejection_reason` (:169).
      // Both can be populated; only one is the fresher read.
      authState.role = 'master'
      authState.masterApplication = { status: 'rejected', rejection_reason: 'Из /users/me' }
      masterState.profile = profile({ status: 'rejected', rejection_reason: 'Из профиля' })
      mount()
      await flush()

      expect(host?.querySelector('.pending-view__reason-text')?.textContent).toBe('Из профиля')
    })

    it('falls back to /users/me when there is no profile (role=user)', async () => {
      authState.masterApplication = { status: 'rejected', rejection_reason: 'Опыт не подтверждён' }
      mount()
      await flush()

      expect(host?.querySelector('.pending-view__reason-text')?.textContent).toBe(
        'Опыт не подтверждён',
      )
    })

    it('falls back to a generic line when the admin left no reason at all', async () => {
      // Rendering an empty amber box, or the literal «null», would read as a bug
      // to the one person least able to explain it.
      authState.masterApplication = { status: 'rejected', rejection_reason: null }
      mount()
      await flush()

      expect(host?.querySelector('.pending-view__reason-text')?.textContent).toBe(
        'Заявка не прошла верификацию. Свяжитесь с поддержкой для повторной заявки.',
      )
    })

    it('offers BOTH ways out: support AND a fresh application (FORK-4)', async () => {
      // Re-apply is genuinely backend-supported (apply_for_master updates the
      // rejected profile in place). Offering only «в поддержку» would dead-end
      // an applicant the backend is happy to take again.
      authState.masterApplication = { status: 'rejected', rejection_reason: null }
      mount()
      await flush()

      button('Написать в поддержку')?.click()
      await flush()
      expect(push).toHaveBeenCalledWith({ name: 'master-support' })

      button('Подать новую заявку')?.click()
      await flush()
      expect(push).toHaveBeenCalledWith({ name: 'master-apply' })
    })

    it('marks the rejection seen so roleRedirect stops routing here', async () => {
      // Bug 1 fix (:186-190). roleRedirect (guards.ts:86-93) sends a rejected
      // role='user' here until this key exists -- without the write, the account
      // can never reach its own dashboard again.
      authState.masterApplication = { status: 'rejected', rejection_reason: null }
      mount()
      await flush()

      expect(localStorage.getItem(masterRejectionSeenKey('u1'))).toBe('1')
    })

    it('does NOT mark anything seen for a pending applicant', async () => {
      mount()
      await flush()

      expect(localStorage.getItem(masterRejectionSeenKey('u1'))).toBeNull()
    })

    it('does not crash marking a rejection with no user id on hand', async () => {
      // The `&& authStore.user?.id` half of the guard (:188).
      authState.user = null
      authState.masterApplication = { status: 'rejected', rejection_reason: null }
      mount()
      await flush()

      expect(text()).toContain('Спасибо за заявку!')
      expect(localStorage.length).toBe(0)
    })
  })

  describe('what the mount refreshes', () => {
    it('a role=master FORCE-reloads the profile and never re-fetches /users/me', async () => {
      // force=true (:180): the store short-circuits on profileLoaded (master.ts:58),
      // so a polling applicant would see a cached «pending» forever without it.
      authState.role = 'master'
      mount()
      await flush()

      expect(fetchMyProfile).toHaveBeenCalledWith(true)
      expect(fetchMe).not.toHaveBeenCalled()
    })

    it('a role=user refreshes /users/me and never calls the master-only endpoint', async () => {
      // GET /masters/me is master-only; calling it for an applicant is a 403.
      mount()
      await flush()

      expect(fetchMe).toHaveBeenCalledTimes(1)
      expect(fetchMyProfile).not.toHaveBeenCalled()
    })

    it('an approval that lands ON THIS MOUNT re-keys the screen to approved', async () => {
      // The whole reason :182 re-fetches /users/me: the applicant re-opens the
      // Mini App on a stale session and the approval is in the response.
      fetchMe.mockImplementation(async () => {
        authState.allowedRoles = ['user', 'master']
      })
      mount()
      await flush()

      expect(text()).toContain('Ваша заявка одобрена!')
      expect(text()).not.toContain('Заявка отправлена!')
    })

    it('a rejection that lands ON THIS MOUNT is marked seen', async () => {
      // profileStatus is re-read AFTER the await (:188), not before -- reading it
      // early would miss the verdict the fetch just delivered and re-route the
      // account here on every open.
      fetchMe.mockImplementation(async () => {
        authState.masterApplication = { status: 'rejected', rejection_reason: 'Отказ' }
      })
      mount()
      await flush()

      expect(text()).toContain('Отказ')
      expect(localStorage.getItem(masterRejectionSeenKey('u1'))).toBe('1')
    })
  })

  describe('withdrawing: one click is not enough', () => {
    it('the link does NOT withdraw -- it only opens the confirm', async () => {
      // The whole point of the dialog. A stray tap on a quiet text link must not
      // cost an applicant their place in the queue.
      mount()
      await flush()

      await openWithdrawDialog()

      expect(mastersApi.withdrawMasterApplication).not.toHaveBeenCalled()
      expect(dialogButton('Отозвать')).toBeDefined()
    })

    it('the confirm states the consequence AND the way back', async () => {
      // Verified against the backend, not taken from the string: re-applying
      // after "cancelled_by_user" really does work (test_reapply_after_
      // withdrawal_succeeds). If that ever stops being true, this promise
      // becomes a lie and this assertion is where it surfaces.
      mount()
      await flush()
      await openWithdrawDialog()

      expect(dialogText()).toBe(
        'Отозвать заявку? Вы вернётесь к обычному аккаунту пользователя. ' +
          'Подать новую заявку можно в любой момент.',
      )
      expect(dialogButton('Отмена')).toBeDefined()
    })

    it('«Отмена» withdraws nothing and closes the dialog', async () => {
      mount()
      await flush()
      await openWithdrawDialog()
      // Pinned while OPEN so the assertion below cannot always-pass (SC-13b).
      expect(dialogLeaving()).toBe(false)

      dialogButton('Отмена')?.click()
      await flush()

      expect(mastersApi.withdrawMasterApplication).not.toHaveBeenCalled()
      expect(replace).not.toHaveBeenCalled()
      expect(sessionStorage.getItem(MASTER_APPLIED_KEY)).toBe('1')
      // The overlay is never REMOVED in happy-dom -- it parks mid-leave (SC-13b).
      expect(dialogLeaving()).toBe(true)
    })

    it('confirming withdraws ONCE, drops the marker, says so, and leaves', async () => {
      mount()
      await flush()
      await openWithdrawDialog()

      dialogButton('Отозвать')?.click()
      await flush()

      expect(mastersApi.withdrawMasterApplication).toHaveBeenCalledTimes(1)
      // guards.ts:230 -- a stale marker would keep bouncing the account back onto
      // a pending screen for an application that no longer exists.
      expect(sessionStorage.getItem(MASTER_APPLIED_KEY)).toBeNull()
      expect(toastSuccess).toHaveBeenCalledWith('Заявка отозвана')
      // replace, not push: the withdrawn pending screen must not be back-navigable.
      expect(replace).toHaveBeenCalledWith({ name: 'user-dashboard' })
      expect(push).not.toHaveBeenCalled()
    })

    it('does NOT withdraw twice on a double-tap the DOM has not caught up with', async () => {
      // The `withdrawing` REF guard (:226), isolated. Deliberately NO tick
      // between the clicks: VConfirmDialog binds :loading -> VButton renders
      // :disabled (VButton.vue:27), so after a re-render the disabled attribute
      // would block click 2 and this test would pass without the ref guard ever
      // running. With no tick the DOM is still un-disabled, so the ref is the
      // ONLY thing standing between a fast double-tap and a second DELETE --
      // which lands on an already-"cancelled_by_user" application and 409s
      // (service.py:298), toasting a failure at an applicant who just succeeded.
      let resolve!: () => void
      vi.mocked(mastersApi.withdrawMasterApplication).mockReturnValue(
        new Promise<void>((r) => {
          resolve = r
        }),
      )
      mount()
      await flush()
      await openWithdrawDialog()

      const confirm = dialogButton('Отозвать')
      expect(confirm?.disabled).toBe(false)
      confirm?.click()
      confirm?.click()

      expect(mastersApi.withdrawMasterApplication).toHaveBeenCalledTimes(1)

      resolve()
      await flush()
    })

    it('disables the confirm while the withdraw is in flight', async () => {
      // The second, independent guard: once the DOM catches up the button is
      // :disabled, so the ref above is belt-and-braces rather than the only rung.
      let resolve!: () => void
      vi.mocked(mastersApi.withdrawMasterApplication).mockReturnValue(
        new Promise<void>((r) => {
          resolve = r
        }),
      )
      mount()
      await flush()
      await openWithdrawDialog()

      dialogButton('Отозвать')?.click()
      await flush()

      expect(dialogButton('Отозвать')?.disabled).toBe(true)
      // The cancel button too: closing the dialog mid-DELETE would leave the
      // request running behind an applicant who thinks they backed out.
      expect(dialogButton('Отмена')?.disabled).toBe(true)

      resolve()
      await flush()
    })

    it('a FAILED withdraw shows the mapped table phrase for a real code and keeps the application alive', async () => {
      // The race the screen was written for (:235-238): an admin decided while
      // the dialog was open. Claiming success here would tell an applicant they
      // withdrew an application that is now verified.
      // B8 (PROMPT №747): 'conflict' IS a real backend code -- extractApiError
      // now returns its table phrase regardless of the mocked detail text.
      vi.mocked(mastersApi.withdrawMasterApplication).mockRejectedValue(
        new ApiResponseError(409, 'Only a pending application can be withdrawn', 'conflict'),
      )
      mount()
      await flush()
      await openWithdrawDialog()

      dialogButton('Отозвать')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith(
        'Конфликт с текущим состоянием — попробуйте обновить страницу',
      )
      expect(toastSuccess).not.toHaveBeenCalled()
      expect(replace).not.toHaveBeenCalled()
      // NOT dropped: the application still exists, and masterPendingGuard needs
      // the marker to let this applicant back onto their own screen.
      expect(sessionStorage.getItem(MASTER_APPLIED_KEY)).toBe('1')
    })

    it('falls back to a generic message on a non-API error', async () => {
      vi.mocked(mastersApi.withdrawMasterApplication).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()
      await openWithdrawDialog()

      dialogButton('Отозвать')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось отозвать заявку')
      expect(replace).not.toHaveBeenCalled()
    })

    it('the dialog closes even when the withdraw failed', async () => {
      // The `finally` (:244-247). A dialog stuck open over a failed request
      // invites the double-tap the re-entry guard exists to refuse.
      vi.mocked(mastersApi.withdrawMasterApplication).mockRejectedValue(new TypeError('boom'))
      mount()
      await flush()
      await openWithdrawDialog()
      expect(dialogLeaving()).toBe(false)

      dialogButton('Отозвать')?.click()
      await flush()

      expect(dialogLeaving()).toBe(true)
    })
  })

  describe('entering master mode after approval', () => {
    beforeEach(() => {
      authState.allowedRoles = ['user', 'master']
    })

    it('switches the role, marks the screen seen, and opens the cabinet', async () => {
      // MA3 (:208-212). Without the key, RoleSwitchSection detours every future
      // self-switch back through this celebratory screen.
      mount()
      await flush()

      button('Войти в кабинет')?.click()
      await flush()

      expect(switchRole).toHaveBeenCalledWith('master')
      expect(localStorage.getItem(masterApprovedSeenKey('u1'))).toBe('1')
      expect(push).toHaveBeenCalledWith({ name: 'master-dashboard' })
    })

    it('a FAILED switch stays put and does not claim the screen was seen', async () => {
      // Marking it seen on a failure would burn the one-time screen for an
      // account that never got into the cabinet.
      switchRole.mockRejectedValue(new ApiResponseError(500, 'Boom', 'server_error'))
      mount()
      await flush()

      button('Войти в кабинет')?.click()
      await flush()

      expect(toastError).toHaveBeenCalledWith('Не удалось переключиться в режим мастера')
      expect(push).not.toHaveBeenCalled()
      expect(localStorage.getItem(masterApprovedSeenKey('u1'))).toBeNull()
    })

    it('does NOT switch twice on a double-tap the DOM has not caught up with', async () => {
      // The `switching` REF guard (:202), isolated -- same reasoning as the
      // withdraw double-tap above: no tick between the clicks, or :loading ->
      // :disabled (VButton.vue:27) would do the work and the ref would never run.
      let resolve!: (v: UserResponse) => void
      switchRole.mockReturnValue(
        new Promise<UserResponse>((r) => {
          resolve = r
        }),
      )
      mount()
      await flush()

      const cta = button('Войти в кабинет')
      expect(cta?.disabled).toBe(false)
      cta?.click()
      cta?.click()

      expect(switchRole).toHaveBeenCalledTimes(1)

      resolve({} as UserResponse)
      await flush()
    })

    it('disables the CTA while the switch is in flight', async () => {
      let resolve!: (v: UserResponse) => void
      switchRole.mockReturnValue(
        new Promise<UserResponse>((r) => {
          resolve = r
        }),
      )
      mount()
      await flush()

      button('Войти в кабинет')?.click()
      await flush()

      expect(button('Войти в кабинет')?.disabled).toBe(true)

      resolve({} as UserResponse)
      await flush()
    })
  })

  // NOT COVERED, deliberately -- stated rather than faked:
  //
  // 1. The «Обновить статус» polling the banner (:16) still advertises does not
  //    exist in this template any more -- there is no poll button and no
  //    setInterval in the SFC. Nothing to test; the stale banner line is a
  //    comment defect, not a behaviour gap, and fixing product code (even a
  //    comment) is out of scope for this file.
  //
  // 2. The three verdict illustrations (/onboarding/master-verdict-*.svg) are
  //    asserted only by the branch they live in, not by their src. happy-dom
  //    does not load them, so an <img src> assertion would prove the string in
  //    the template and nothing about the asset existing.
  //
  // 3. masterPendingGuard / roleRedirect -- how an account ARRIVES here -- is
  //    guard-layer behaviour and is covered bare in router/guards.test.ts. This
  //    file covers only what the screen does once mounted.
})
