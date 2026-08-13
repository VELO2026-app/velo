// =============================================================================
// VELO Frontend -- UserProfileView Screen Tests (probekit-screen-test)
// =============================================================================
//
// 306 lines, the user zone's main profile screen (header + stats + menu).
//
// PATTERN A (store-backed), ONE mocked API seam: `getMyStats` (@/api/bookings,
// .vue:139), a fire-and-forget call in onMounted (.vue:211-221) wrapped in its
// own try/catch -- NEW-7's own comment says a failed fetch must not break the
// screen, just leave the stat cards at 0. Real useAuthStore (user + role) and
// useUiStore (uiMode) -- both plain reactive state, no API seam of their own.
// Real vue-router mocked at the composable boundary (push/replace spies).
//
// ROLESWITCHSECTION -- READ, NOT ASSUMED, AND THE PARENT'S OWN COMMENT IS
// STALE: .vue:106 calls it "TEST-ONLY tester tool; renders nothing for normal
// users", but RoleSwitchSection.vue's OWN header (lines 1-13) says it has been
// a PRODUCTION self-role-switch feature since №256/№260 -- a real, if minor,
// doc bug in UserProfileView.vue (reported, not touched -- out of scope).
// Mechanically it gates on `v-if="targets.length > 0"`
// (RoleSwitchSection.vue:17), where `targets = authStore.allowedRoles.filter
// (r => r !== authStore.role)` and `allowedRoles` reads
// `user.role_switch?.allowed_roles ?? []` (auth.ts:48-51). Every fixture below
// sets `role_switch: null` (matching this repo's existing fixture convention,
// e.g. EditProfileView.test.ts/LanguageTimezoneView.test.ts), so
// `allowedRoles` is always `[]`, `targets` is always `[]`, and the section
// renders NOTHING in every test here -- confirmed by asserting zero
// `.role-switch` elements in the master/admin role tests below, where a
// leaked render would be most likely to show up and collide with the
// screen's OWN "Вернуться в режим …" row (which is a SEPARATE, older
// mechanism, .vue:88-104, unconditional on role_switch).
//
// MONEY: none (stats are counts/hours, not currency). Cyrillic fixtures and
// expected strings below were still typed via the Write tool, not a shell
// heredoc, per house habit.
//
// No modal, no v-show, no order dependence -- every test mounts its own app +
// fresh Pinia.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import UserProfileView from '@/views/user/UserProfileView.vue'
import * as bookingsApi from '@/api/bookings'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import type { UserResponse } from '@/api/types'

vi.mock('@/api/bookings')

const push = vi.fn()
const replace = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, replace }),
}))

const toastError = vi.fn()
const toastInfo = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, info: toastInfo, success: toastSuccess }),
}))

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function user(overrides: Partial<UserResponse> = {}): UserResponse {
  return {
    id: 'user_1',
    telegram_id: 1,
    role: 'user',
    first_name: 'Аня',
    last_name: 'Иванова',
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
  app = createApp(UserProfileView)
  app.use(pinia)
  app.mount(host)
  return host
}

// onMounted -> await getMyStats -- one microtask hop, then a re-render.
// Generous headroom matching this repo's other Pattern-A screens (SC-08).
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function statValue(label: string): string | undefined {
  const card = Array.from(host?.querySelectorAll<HTMLElement>('.v-stat') ?? []).find(
    (c) => c.querySelector('.v-stat__label')?.textContent?.trim() === label,
  )
  return card?.querySelector('.v-stat__value')?.textContent?.trim()
}
function menuRowByLabel(label: string): HTMLElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLElement>('.v-menu-row') ?? []).find(
    (r) => r.querySelector('.v-menu-row__text')?.textContent?.trim() === label,
  )
}
function roleSwitchSectionCount(): number {
  return host?.querySelectorAll('.role-switch').length ?? 0
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)

  vi.mocked(bookingsApi.getMyStats)
    .mockReset()
    .mockResolvedValue({ practices_attended: 0, hours_attended: 0 })

  useAuthStore().user = user()

  push.mockReset()
  replace.mockReset()
  toastError.mockReset()
  toastInfo.mockReset()
  toastSuccess.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('UserProfileView', () => {
  // ===========================================================================
  describe('stats: success vs silent failure (NEW-7)', () => {
    it('success: fills both stat cards from getMyStats', async () => {
      vi.mocked(bookingsApi.getMyStats).mockResolvedValue({
        practices_attended: 7,
        hours_attended: 12,
      })
      mount()
      await flush()

      expect(statValue('Практик')).toBe('7')
      expect(statValue('Часов')).toBe('12')
    })

    it('failure: does not throw, screen still renders, both cards stay at 0', async () => {
      vi.mocked(bookingsApi.getMyStats).mockRejectedValue(new Error('ECONNRESET'))

      expect(() => mount()).not.toThrow()
      await flush()

      expect(statValue('Практик')).toBe('0')
      expect(statValue('Часов')).toBe('0')
      // No error UI of any kind -- the screen degrades completely silently.
      expect(host?.textContent).not.toMatch(/ошибк/i)
    })
  })

  // ===========================================================================
  describe('hoursLabel formatting (.vue:162-165)', () => {
    it('an integer renders plain, without a trailing separator', async () => {
      vi.mocked(bookingsApi.getMyStats).mockResolvedValue({
        practices_attended: 1,
        hours_attended: 12,
      })
      mount()
      await flush()

      expect(statValue('Часов')).toBe('12')
    })

    it('a fractional value renders with a Russian COMMA, not a dot', async () => {
      vi.mocked(bookingsApi.getMyStats).mockResolvedValue({
        practices_attended: 1,
        hours_attended: 9.5,
      })
      mount()
      await flush()

      expect(statValue('Часов')).toBe('9,5')
    })
  })

  // ===========================================================================
  describe('displayName (.vue:148-152)', () => {
    it('joins first + last name', async () => {
      useAuthStore().user = user({ first_name: 'Аня', last_name: 'Иванова' })
      mount()
      await flush()

      expect(host?.querySelector('.profile__name')?.textContent?.trim()).toBe('Аня Иванова')
    })

    it('only the first name present: shows it alone', async () => {
      useAuthStore().user = user({ first_name: 'Аня', last_name: null })
      mount()
      await flush()

      expect(host?.querySelector('.profile__name')?.textContent?.trim()).toBe('Аня')
    })

    it('neither name present: falls back to "Пользователь"', async () => {
      useAuthStore().user = user({ first_name: null, last_name: null })
      mount()
      await flush()

      expect(host?.querySelector('.profile__name')?.textContent?.trim()).toBe('Пользователь')
    })
  })

  // ===========================================================================
  describe('role branching: "Вернуться в режим ..." row (.vue:88-104, 200-208)', () => {
    it('role "user": the row is NOT rendered at all', async () => {
      useAuthStore().user = user({ role: 'user' })
      mount()
      await flush()

      expect(menuRowByLabel('Вернуться в режим мастера')).toBeUndefined()
      expect(menuRowByLabel('Вернуться в режим администратора')).toBeUndefined()
      // RoleSwitchSection stays empty too (role_switch: null fixture, see banner).
      expect(roleSwitchSectionCount()).toBe(0)
    })

    it('role "master": labelled for master, resets uiMode and pushes master-dashboard', async () => {
      useAuthStore().user = user({ role: 'master' })
      useUiStore().setUiMode('user')
      mount()
      await flush()

      expect(roleSwitchSectionCount()).toBe(0)
      const row = menuRowByLabel('Вернуться в режим мастера')
      expect(row).toBeDefined()
      expect(menuRowByLabel('Вернуться в режим администратора')).toBeUndefined()

      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()

      expect(useUiStore().uiMode).toBe('default')
      expect(push).toHaveBeenCalledWith({ name: 'master-dashboard' })
    })

    it('role "admin": labelled for admin, resets uiMode and pushes admin-dashboard', async () => {
      useAuthStore().user = user({ role: 'admin' })
      useUiStore().setUiMode('user')
      mount()
      await flush()

      expect(roleSwitchSectionCount()).toBe(0)
      const row = menuRowByLabel('Вернуться в режим администратора')
      expect(row).toBeDefined()
      expect(menuRowByLabel('Вернуться в режим мастера')).toBeUndefined()

      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()

      expect(useUiStore().uiMode).toBe('default')
      expect(push).toHaveBeenCalledWith({ name: 'admin-dashboard' })
    })
  })

  // ===========================================================================
  describe('menu navigation', () => {
    const CASES: Array<[string, string]> = [
      ['Редактировать профиль', 'user-edit-profile'],
      ['Сообщения', 'user-messages'],
      ['Уведомления', 'user-notifications'],
      ['Язык / Часовой пояс', 'user-language-timezone'],
      ['Поддержка', 'user-support'],
    ]

    for (const [label, routeName] of CASES) {
      it(`"${label}" pushes { name: '${routeName}' }`, async () => {
        mount()
        await flush()

        menuRowByLabel(label)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await flush()

        expect(push).toHaveBeenCalledWith({ name: routeName })
      })
    }

    it('"Мои бронирования" pushes { name: \'user-bookings\' } (inline handler, not a named fn)', async () => {
      mount()
      await flush()

      menuRowByLabel('Мои бронирования')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'user-bookings' })
    })

    it('"Поделиться" toasts the stub message and does NOT navigate', async () => {
      mount()
      await flush()

      menuRowByLabel('Поделиться')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()

      expect(toastInfo).toHaveBeenCalledWith('Поделиться будет доступно в следующем обновлении')
      expect(push).not.toHaveBeenCalled()
    })
  })

  // ===========================================================================
  describe('logout (.vue:195-198)', () => {
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

      menuRowByLabel('Выйти')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()

      expect(order).toEqual(['logout', 'replace'])
      expect(replace).toHaveBeenCalledWith({ path: '/' })
    })
  })
})
