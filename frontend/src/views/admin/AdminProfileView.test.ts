// =============================================================================
// VELO Frontend -- AdminProfileView Screen Tests (probekit-screen-test)
// =============================================================================
//
// 141 lines. PATTERN = stores-only, NO api seam at all -- confirmed by
// reading every import: useAuthStore (user + logout) and useUiStore
// (setUiMode) only, both real setup stores, both writable directly from
// outside (same shape as useAdminStore's `stats` ref, established in
// AdminPracticesView.test.ts / this round's AdminParticipantsView.test.ts).
// Real Pinia via createPinia/setActivePinia, seeded per-test.
//
// RoleSwitchSection -- READ, NOT ASSUMED (same check as UserProfileView.
// test.ts's precedent): no onMounted/fetch seam, gates purely on
// `v-if="targets.length > 0"` where `targets = authStore.allowedRoles.filter
// (r => r !== authStore.role)` and `allowedRoles` reads
// `user.role_switch?.allowed_roles ?? []`. Every fixture below sets
// `role_switch: null`, so it renders nothing -- confirmed by asserting zero
// `.role-switch` elements once, matching this repo's existing convention.
//
// FIXED in №487 -- root cause + before/after (same discipline as №468/№478/
// №481/№483): `onLogout` (.vue:79-88) was described in №486's prompt as
// "guarded by `loggingOut`", but reading the function body showed there was
// NO `if (loggingOut.value) return` at all -- `loggingOut.value = true` was
// set UNCONDITIONALLY at the top:
//   BEFORE:  async function onLogout(): Promise<void> {
//              loggingOut.value = true
//              try { await authStore.logout(); router.replace(...) }
//              finally { loggingOut.value = false }
//            }
//   AFTER:   async function onLogout(): Promise<void> {
//              if (loggingOut.value) return
//              loggingOut.value = true
//              try { ... } finally { loggingOut.value = false }
//            }
// EXACTLY the same shape as this round's OTHER fix on
// AdminMasterInviteView.onCreate (see that file's banner) -- before the fix,
// the only defense was VButton's own `:disabled="disabled || loading"`
// reacting to `:loading="loggingOut"`, a template binding defeated by a
// same-tick double click before Vue's microtask-batched DOM update paints --
// a plain double-tap on ONE button, not a two-button latent race, so a human
// hits it. Consequence: a double logout call. Modeled on the sibling in the
// SAME BATCH that already had the guard right, AdminParticipantsView.load
// (.vue:115, `if (loading.value) return`). The `:disabled`/`:loading`
// binding is UNCHANGED -- same reasoning as №481/№483b, real UX feedback,
// not a redundant guard layer.
//
// displayName (.vue:66-70) fallbacks covered the way UserProfileView's
// analogous computed was in №470: no user -> "Администратор"; first+last ->
// joined; only one half present -> that half alone; BOTH halves empty
// strings (falsy, `.filter(Boolean)` drops them) -> "Администратор" again,
// not a lone space.
//
// Cyrillic fixtures/expected strings below were typed via the Write tool,
// never a shell heredoc.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import AdminProfileView from '@/views/admin/AdminProfileView.vue'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import type { UserResponse } from '@/api/types'

const back = vi.fn()
const push = vi.fn()
const replace = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ back, push, replace }),
}))

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function user(overrides: Partial<UserResponse> = {}): UserResponse {
  return {
    id: 'admin_1',
    telegram_id: 1,
    role: 'admin',
    first_name: 'Игорь',
    last_name: 'Орлов',
    avatar_url: null,
    timezone: 'Europe/Moscow',
    language: 'ru',
    is_active: true,
    balance_cents: 0,
    created_at: '2026-01-01T00:00:00Z',
    last_login_at: null,
    onboarding_completed: true,
    master_onboarding_completed: false,
    phone: null,
    bio: null,
    email: null,
    master_notifications: null,
    role_switch: null,
    ...overrides,
  }
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null
let pinia: Pinia

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AdminProfileView)
  app.use(pinia)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function buttonByText(t: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-btn') ?? []).find((b) =>
    b.textContent?.trim().startsWith(t),
  )
}
function logoutBtn(): HTMLButtonElement {
  const b = buttonByText('Выйти')
  if (!b) throw new Error('«Выйти» did not render')
  return b
}
function switchBtn(): HTMLButtonElement {
  const b = buttonByText('Открыть как пользователь')
  if (!b) throw new Error('«Открыть как пользователь» did not render')
  return b
}
function displayName(): string {
  return host?.querySelector('.admin-profile__name')?.textContent?.trim() ?? ''
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)

  useAuthStore().user = user()

  back.mockReset()
  push.mockReset()
  replace.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('AdminProfileView', () => {
  // ===========================================================================
  describe('displayName (.vue:66-70)', () => {
    it('no user at all: "Администратор"', async () => {
      useAuthStore().user = null
      mount()
      await flush()

      expect(displayName()).toBe('Администратор')
    })

    it('first + last present: joined with a space', async () => {
      useAuthStore().user = user({ first_name: 'Игорь', last_name: 'Орлов' })
      mount()
      await flush()

      expect(displayName()).toBe('Игорь Орлов')
    })

    it('only first_name present: that alone', async () => {
      useAuthStore().user = user({ first_name: 'Игорь', last_name: null })
      mount()
      await flush()

      expect(displayName()).toBe('Игорь')
    })

    it('only last_name present: that alone', async () => {
      useAuthStore().user = user({ first_name: null, last_name: 'Орлов' })
      mount()
      await flush()

      expect(displayName()).toBe('Орлов')
    })

    it('BOTH halves empty strings (falsy, not null): still "Администратор", not a lone space', async () => {
      useAuthStore().user = user({ first_name: '', last_name: '' })
      mount()
      await flush()

      expect(displayName()).toBe('Администратор')
    })
  })

  // ===========================================================================
  describe('RoleSwitchSection (role_switch: null in every fixture -- see banner)', () => {
    it('renders nothing', async () => {
      mount()
      await flush()

      expect(host?.querySelectorAll('.role-switch')).toHaveLength(0)
    })
  })

  // ===========================================================================
  describe('switchToUserMode (.vue:73-76)', () => {
    it('sets uiMode to "user" AND pushes to user-profile', async () => {
      const order: string[] = []
      const uiStore = useUiStore()
      const originalSet = uiStore.setUiMode.bind(uiStore)
      vi.spyOn(uiStore, 'setUiMode').mockImplementation((mode) => {
        order.push(`setUiMode:${mode}`)
        originalSet(mode)
      })
      push.mockImplementation(() => {
        order.push('push')
      })
      mount()
      await flush()

      switchBtn().click()
      await flush()

      expect(order).toEqual(['setUiMode:user', 'push'])
      expect(uiStore.uiMode).toBe('user')
      expect(push).toHaveBeenCalledWith({ name: 'user-profile' })
    })
  })

  // ===========================================================================
  describe('onLogout (.vue:79-87)', () => {
    it('awaits authStore.logout() BEFORE router.replace -- proves the order, not just that both happened', async () => {
      const order: string[] = []
      const authStore = useAuthStore()
      vi.spyOn(authStore, 'logout').mockImplementation(async () => {
        order.push('logout')
      })
      replace.mockImplementation(() => {
        order.push('replace')
      })
      mount()
      await flush()

      logoutBtn().click()
      await flush()

      expect(order).toEqual(['logout', 'replace'])
      expect(replace).toHaveBeenCalledWith({ path: '/' })
    })

    it('REALISTIC interaction: once :disabled has painted, a second click on the real <button> is a no-op', async () => {
      let resolveLogout!: () => void
      const authStore = useAuthStore()
      vi.spyOn(authStore, 'logout').mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveLogout = () => resolve()
          }),
      )
      mount()
      await flush()

      logoutBtn().click()
      await flush() // let :loading="loggingOut" paint

      expect(logoutBtn().disabled).toBe(true)
      logoutBtn().click() // a real click on a disabled <button> does not fire

      expect(authStore.logout).toHaveBeenCalledTimes(1)
      resolveLogout()
      await flush()
    })

    it('FIXED: a same-tick double click is now blocked at the handler layer -- authStore.logout() is called ONCE', async () => {
      let resolveLogout!: () => void
      const authStore = useAuthStore()
      vi.spyOn(authStore, 'logout').mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveLogout = () => resolve()
          }),
      )
      mount()
      await flush()

      const btn = logoutBtn()
      btn.click()
      btn.click() // no await -- the disabled attribute has not painted yet
      await flush()

      expect(authStore.logout).toHaveBeenCalledTimes(1)
      resolveLogout()
      await flush()
    })
  })
})
