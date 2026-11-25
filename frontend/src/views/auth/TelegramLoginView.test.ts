// =============================================================================
// VELO Frontend -- TelegramLoginView (Standalone phase 3)
// =============================================================================
//
// The login screen outside Telegram: one button, and the reason the last
// attempt did not get in -- always a phrase, never an error code.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import TelegramLoginView from '@/views/auth/TelegramLoginView.vue'
import { loginDestination, loginNotice, type LoginNotice } from '@/composables/useAuth'
import { api, ApiResponseError } from '@/api/client'
import { LOGIN_MARK_KEY } from '@/platform/browser-login'

// The real auth store; only the network and the page change are stand-ins.
vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>()
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }
})

const START = '/api/v1/auth/telegram/browser/start'

const ALL_NOTICES: LoginNotice[] = [
  'cancelled',
  'foreign',
  'expired',
  'telegram_failed',
  'deactivated',
  'rate_limited',
  'unavailable',
  'network',
]

function button(w: ReturnType<typeof mount>) {
  return w.find('button.login__button')
}

beforeEach(() => {
  setActivePinia(createPinia())
  loginNotice.value = null
  loginDestination.value = null
  localStorage.clear()
  vi.mocked(api.post).mockReset()
  vi.spyOn(window.location, 'assign').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TelegramLoginView', () => {
  it('offers «Войти через Telegram» and no other way in', () => {
    const w = mount(TelegramLoginView)
    expect(w.findAll('button').map((b) => b.text())).toEqual(['Войти через Telegram'])
    expect(w.find('input').exists()).toBe(false) // no e-mail, no password
    expect(w.find('[role="alert"]').exists()).toBe(false)
  })

  it.each(ALL_NOTICES)('notice "%s" is a human phrase, not the code', (notice) => {
    loginNotice.value = notice
    const w = mount(TelegramLoginView)
    const alert = w.find('[role="alert"]')
    expect(alert.exists()).toBe(true)
    expect(alert.text().length).toBeGreaterThan(5)
    expect(alert.text()).not.toContain(notice)
    expect(alert.text()).not.toMatch(/[a-z]+_[a-z]+/) // no snake_case code leaks
  })

  it('each notice has its own phrase', () => {
    const phrases = new Set(
      ALL_NOTICES.map((notice) => {
        loginNotice.value = notice
        return mount(TelegramLoginView).find('[role="alert"]').text()
      }),
    )
    expect(phrases.size).toBe(ALL_NOTICES.length)
  })

  it('pressing the button clears the old notice and starts; the button holds while leaving', async () => {
    loginNotice.value = 'expired'
    vi.mocked(api.post).mockImplementation(() => new Promise(() => {})) // navigating away
    const w = mount(TelegramLoginView)

    await button(w).trigger('click')
    await flushPromises()

    expect(vi.mocked(api.post).mock.calls.filter((call) => call[0] === START)).toHaveLength(1)
    expect(loginNotice.value).toBeNull()
    expect(button(w).attributes('disabled')).toBeDefined()
    expect(button(w).text()).toBe('Открываем Telegram…')
  })

  it('the sign-in carries the address the person was on', async () => {
    loginDestination.value = '/console'
    vi.mocked(api.post).mockResolvedValue({ url: 'https://oauth.telegram.org/auth', state: 'S9' })
    const w = mount(TelegramLoginView)

    await button(w).trigger('click')
    await flushPromises()

    const kept = JSON.parse(localStorage.getItem(LOGIN_MARK_KEY) ?? 'null')
    expect(kept).toMatchObject({ state: 'S9', destination: '/console' })
  })

  it('a refused start says why and lets the person try again', async () => {
    vi.mocked(api.post).mockRejectedValue(new ApiResponseError(503, 'x', 'service_unavailable'))
    const w = mount(TelegramLoginView)

    await button(w).trigger('click')
    await flushPromises()

    expect(w.find('[role="alert"]').text()).toBe(
      'Сервис временно недоступен. Попробуйте через минуту.',
    )
    expect(button(w).attributes('disabled')).toBeUndefined()
    expect(button(w).text()).toBe('Войти через Telegram')
  })
})
