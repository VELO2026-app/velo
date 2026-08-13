// =============================================================================
// VELO Frontend -- MasterProfileView Screen Tests
// =============================================================================
//
// WHY THIS FILE EXISTS (probekit-screen-test audit, rank 2 of the untested-20
// table): a settings hub with 2 store imports (useMasterStore, useAuthStore),
// 3 computed()s over live store state, and a logout confirm flow.
//
// CORRECTION TO THE AUDIT: the audit's "Notable" column claims this screen is
// "behind masterStatusGuard". That is FALSE, checked two ways before writing
// this file:
//   1. The SFC's own banner (.vue:7) says outright: "No masterStatusGuard --
//      accessible even while pending."
//   2. router/index.ts:266-270 -- the `master-profile` route has NO
//      `beforeEnter` at all, unlike its siblings on every side (:262, :326,
//      :333, ...) which all carry `beforeEnter: masterStatusGuard`. The route
//      was very deliberately left off the guard.
// So this file tests NO guard (there isn't one) -- only the real branching:
// the onMounted role gate, the display-name/email/avatar fallback chains, the
// messages-badge fetch, and the logout confirm. Also: the audit counted "4
// computed()"; reading the SFC finds 3 (displayName, avatarUrl, userEmail) --
// noted so nobody re-greps looking for a 4th.
//
// PATTERN: real Pinia (masterStore + authStore, set directly -- both are
// setup stores with writable refs, same idiom as guards.test.ts's
// `store.user = {...}`), REAL RoleSwitchSection child (renders nothing for
// every fixture below: role_switch stays null, so `authStore.allowedRoles`
// is empty and RoleSwitchSection's own `v-if="targets.length > 0"` never
// opens -- confirmed by reading RoleSwitchSection.vue rather than assumed,
// same check AdminProfileView.test.ts / UserProfileView.test.ts already made
// for their own copies of this shared component). @/api/masters and
// @/api/chats are the two API seams (module-mocked); @/composables/useToast
// mocked wholesale per this repo's convention even though nothing here
// currently calls it directly (RoleSwitchSection imports it, unreachable).
//
// TRAPS PRESENT:
//  - SC-13: the logout confirm renders through VModal (Teleport to="body").
//    Queried off document.body (SC-07), purged in afterEach (SC-13), and the
//    "cancel leaves nothing changed" test uses dialogLeaving() rather than
//    asserting the overlay is gone (SC-13b).
//
// TRAPS ABSENT -- checked, not assumed:
//  - NO wall clock, no money, no v-show, no list/pagination cap.
//  - NO re-entry race on the logout button: onLogout has no loading ref at
//    all (no :loading binding either) -- a double click awaits
//    authStore.logout() twice in a row rather than racing a shared flag. Not
//    the SC-17 shape (no guard exists to prove), so not asserted as a guard
//    test; the single-click path is what's covered.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import MasterProfileView from '@/views/master/MasterProfileView.vue'
import { useAuthStore } from '@/stores/auth'
import * as mastersApi from '@/api/masters'
import * as chatsApi from '@/api/chats'
import type { MasterProfileResponse, UserResponse } from '@/api/types'

vi.mock('@/api/masters')
vi.mock('@/api/chats')

const push = vi.fn()
const replace = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, replace }),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}))

function profile(overrides: Partial<MasterProfileResponse> = {}): MasterProfileResponse {
  return {
    user_id: 'u1',
    status: 'verified',
    display_name: 'Мастер Ирина',
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

function user(overrides: Partial<UserResponse> & Record<string, unknown> = {}): UserResponse {
  return {
    id: 'u1',
    telegram_id: 1,
    role: 'master',
    first_name: 'Ирина',
    last_name: null,
    avatar_url: null,
    timezone: 'Europe/Moscow',
    language: 'ru',
    is_active: true,
    balance_cents: 0,
    created_at: '2026-01-01T00:00:00Z',
    last_login_at: null,
    onboarding_completed: true,
    master_onboarding_completed: true,
    phone: null,
    bio: null,
    email: null,
    master_notifications: null,
    role_switch: null,
    ...overrides,
  } as UserResponse
}

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(MasterProfileView)
  app.use(pinia)
  app.mount(host)
  return host
}

// mount -> onMounted (role check, sync) -> loadMessagesCount fire-and-forget
// (listChats await + Promise.all of getChatUnreadCount, 2 awaits) -> re-render
// (1); in parallel fetchMyProfile await (1) -> re-render (1). 6 leaves margin.
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function rowByLabel(label: string): HTMLElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLElement>('.v-menu-row') ?? []).find(
    (r) => r.querySelector('.v-menu-row__text')?.textContent?.trim() === label,
  )
}

function badgeOn(label: string): string | null {
  return rowByLabel(label)?.querySelector('.v-menu-row__badge')?.textContent?.trim() ?? null
}

function displayName(): string {
  return host?.querySelector('.master-profile__name')?.textContent?.trim() ?? ''
}

function emailText(): string | null {
  return host?.querySelector('.master-profile__email')?.textContent?.trim() ?? null
}

/** Teleported to document.body (SC-07); scoped past a mid-leave corpse (SC-13c). */
function liveDialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('.v-modal__overlay:not(.v-modal-leave-active)')
}

function dialogButton(label: string): HTMLButtonElement | undefined {
  return Array.from(liveDialog()?.querySelectorAll('button') ?? []).find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined
}

/** SC-13b: the overlay is never REMOVED in happy-dom -- it parks mid-leave. */
function dialogLeaving(): boolean {
  return !!document.body.querySelector('.v-modal-leave-active')
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)

  vi.mocked(mastersApi.getMyMasterProfile).mockReset().mockResolvedValue(profile())
  vi.mocked(chatsApi.listChats).mockReset().mockResolvedValue({ threads: [], next_cursor: null })
  vi.mocked(chatsApi.getChatUnreadCount).mockReset().mockResolvedValue({ unread: 0 })
  push.mockReset()
  replace.mockReset()

  const authStore = useAuthStore()
  authStore.user = user()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null

  // SC-13: a closed VModal overlay survives app.unmount() -- purge or the
  // next test's first modal query finds this file's own corpse.
  document.body.querySelectorAll('.v-modal__overlay').forEach((el) => el.remove())

  vi.clearAllMocks()
})

describe('MasterProfileView', () => {
  describe('what the mount loads (role-gated)', () => {
    it('role=master fetches the master profile AND the messages badge', async () => {
      mount()
      await flush()

      expect(mastersApi.getMyMasterProfile).toHaveBeenCalledTimes(1)
      expect(chatsApi.listChats).toHaveBeenCalledTimes(1)
    })

    it('a non-master role fetches NEITHER -- the master-only endpoint would 403', async () => {
      const authStore = useAuthStore()
      authStore.user = user({ role: 'user' })
      mount()
      await flush()

      expect(mastersApi.getMyMasterProfile).not.toHaveBeenCalled()
      expect(chatsApi.listChats).not.toHaveBeenCalled()
    })
  })

  describe('display name fallback chain', () => {
    it('the loaded master profile display_name wins', async () => {
      vi.mocked(mastersApi.getMyMasterProfile).mockResolvedValue(
        profile({ display_name: 'Мастер Ирина' }),
      )
      const authStore = useAuthStore()
      authStore.user = user({ first_name: 'Ирина-юзер' })
      mount()
      await flush()

      expect(displayName()).toBe('Мастер Ирина')
    })

    it('falls back to the auth user first_name while the profile has not landed', async () => {
      vi.mocked(mastersApi.getMyMasterProfile).mockReturnValue(new Promise(() => {}))
      const authStore = useAuthStore()
      authStore.user = user({ first_name: 'Ирина-юзер' })
      mount()
      await flush()

      expect(displayName()).toBe('Ирина-юзер')
    })

    it('falls back to the generic "Мастер" when neither is available', async () => {
      // `?? 'Мастер'` (.vue:135-137) only falls through on null/undefined --
      // an empty-string first_name would NOT trigger it, so the fixture must
      // remove the user entirely to reach the true fallback branch.
      vi.mocked(mastersApi.getMyMasterProfile).mockReturnValue(new Promise(() => {}))
      const authStore = useAuthStore()
      authStore.user = null
      mount()
      await flush()

      expect(displayName()).toBe('Мастер')
    })
  })

  describe('the email row -- Zod field, hidden until the backend sends it', () => {
    it('renders the email when the auth user carries one', async () => {
      const authStore = useAuthStore()
      authStore.user = user({ email: 'irina@example.com' } as Partial<UserResponse>)
      mount()
      await flush()

      expect(emailText()).toBe('irina@example.com')
    })

    it('hides the row entirely when there is none', async () => {
      const authStore = useAuthStore()
      authStore.user = user({ email: null } as Partial<UserResponse>)
      mount()
      await flush()

      expect(host?.querySelector('.master-profile__email')).toBeNull()
    })
  })

  describe('messages badge (real since T2)', () => {
    it('sums unread counts across every thread', async () => {
      vi.mocked(chatsApi.listChats).mockResolvedValue({
        threads: [
          { id: 't1', created_at: '2026-08-01T00:00:00Z' },
          { id: 't2', created_at: '2026-08-02T00:00:00Z' },
        ],
        next_cursor: null,
      })
      vi.mocked(chatsApi.getChatUnreadCount).mockImplementation(async (id: string) =>
        id === 't1' ? { unread: 3 } : { unread: 2 },
      )
      mount()
      await flush()

      expect(badgeOn('Сообщения')).toBe('5')
    })

    it('no badge at all when every thread is fully read', async () => {
      vi.mocked(chatsApi.listChats).mockResolvedValue({
        threads: [{ id: 't1', created_at: '2026-08-01T00:00:00Z' }],
        next_cursor: null,
      })
      vi.mocked(chatsApi.getChatUnreadCount).mockResolvedValue({ unread: 0 })
      mount()
      await flush()

      expect(badgeOn('Сообщения')).toBeNull()
    })

    it('a failed listChats degrades to no badge -- the hub must not fail on it', async () => {
      vi.mocked(chatsApi.listChats).mockRejectedValue(new Error('network'))
      mount()
      await flush()

      expect(badgeOn('Сообщения')).toBeNull()
      // The rest of the hub is unaffected -- the badge is a courtesy, not a gate.
      expect(displayName()).not.toBe('')
    })

    it('a single failed per-thread unread count counts as 0 for THAT thread only', async () => {
      vi.mocked(chatsApi.listChats).mockResolvedValue({
        threads: [
          { id: 't1', created_at: '2026-08-01T00:00:00Z' },
          { id: 't2', created_at: '2026-08-02T00:00:00Z' },
        ],
        next_cursor: null,
      })
      vi.mocked(chatsApi.getChatUnreadCount).mockImplementation(async (id: string) => {
        if (id === 't1') throw new Error('boom')
        return { unread: 4 }
      })
      mount()
      await flush()

      expect(badgeOn('Сообщения')).toBe('4')
    })
  })

  describe('menu navigation', () => {
    it.each([
      ['Редактировать профиль', { name: 'master-edit-profile' }],
      ['Сообщения', { name: 'master-messages' }],
      ['Мои промокоды', { name: 'master-promocodes' }],
      ['Вывод средств', { name: 'master-finance' }],
      ['Уведомления', { name: 'master-notifications' }],
      ['Язык/Часовой пояс', { name: 'master-language-timezone' }],
      ['Поддержка', { name: 'master-support' }],
    ] as const)('%s pushes %o', async (label, target) => {
      mount()
      await flush()

      rowByLabel(label)?.click()
      await flush()

      expect(push).toHaveBeenCalledWith(target)
    })
  })

  describe('logout: a click opens a confirm, not an immediate logout', () => {
    it('«Выйти» does not log out on its own -- it opens the modal', async () => {
      mount()
      await flush()

      rowByLabel('Выйти')?.click()
      await flush()

      expect(liveDialog()).not.toBeNull()
      expect(liveDialog()?.textContent).toContain('Выйти из аккаунта?')
    })

    it('«Нет» closes the modal without touching the session', async () => {
      const authStore = useAuthStore()
      const logoutSpy = vi.spyOn(authStore, 'logout').mockResolvedValue(undefined)
      mount()
      await flush()
      rowByLabel('Выйти')?.click()
      await flush()
      expect(dialogLeaving()).toBe(false) // pinned open first (SC-13b)

      dialogButton('Нет')?.click()
      await flush()

      expect(logoutSpy).not.toHaveBeenCalled()
      expect(replace).not.toHaveBeenCalled()
      expect(dialogLeaving()).toBe(true)
    })

    it('«Да» logs out through the REAL store action, then leaves via replace (not push)', async () => {
      const authStore = useAuthStore()
      const order: string[] = []
      const logoutSpy = vi.spyOn(authStore, 'logout').mockImplementation(async () => {
        order.push('logout')
      })
      replace.mockImplementation(() => {
        order.push('replace')
      })
      mount()
      await flush()
      rowByLabel('Выйти')?.click()
      await flush()

      dialogButton('Да')?.click()
      await flush()

      expect(logoutSpy).toHaveBeenCalledTimes(1)
      expect(order).toEqual(['logout', 'replace']) // proves the AWAIT, not just that both fired
      expect(replace).toHaveBeenCalledWith({ path: '/' })
      expect(push).not.toHaveBeenCalled()
    })
  })
})

// =============================================================================
// NOT COVERED, deliberately
// =============================================================================
// - masterStatusGuard -- does not apply to this route (see the banner's
//   correction to the audit). Nothing to cover.
// - RoleSwitchSection's own switch behaviour: covered as "renders nothing"
//   here (role_switch stays null in every fixture); its own internals belong
//   to its own component test, not this screen's.
// =============================================================================
