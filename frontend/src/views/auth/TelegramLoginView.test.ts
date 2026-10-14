// =============================================================================
// VELO Frontend -- TelegramLoginView (Standalone phase 3)
// =============================================================================
//
// The login screen outside Telegram: one button, and the reason the last
// attempt did not get in -- always a phrase, never an error code.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import TelegramLoginView from '@/views/auth/TelegramLoginView.vue'
import { loginNotice, type LoginNotice } from '@/composables/useAuth'
import { ApiResponseError } from '@/api/client'

const startBrowserLogin = vi.fn()
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ startBrowserLogin }),
}))

const ALL_NOTICES: LoginNotice[] = [
  'cancelled',
  'foreign',
  'expired',
  'telegram_failed',
  'not_configured',
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
  startBrowserLogin.mockReset()
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
    startBrowserLogin.mockImplementation(() => new Promise(() => {})) // navigating away
    const w = mount(TelegramLoginView)

    await button(w).trigger('click')
    await flushPromises()

    expect(startBrowserLogin).toHaveBeenCalledTimes(1)
    expect(loginNotice.value).toBeNull()
    expect(button(w).attributes('disabled')).toBeDefined()
    expect(button(w).text()).toBe('Открываем Telegram…')
  })

  it('a refused start says why and lets the person try again', async () => {
    startBrowserLogin.mockRejectedValue(new ApiResponseError(404, 'x', 'login_not_configured'))
    const w = mount(TelegramLoginView)

    await button(w).trigger('click')
    await flushPromises()

    expect(w.find('[role="alert"]').text()).toBe('Вход через браузер на этом сервере не настроен.')
    expect(button(w).attributes('disabled')).toBeUndefined()
    expect(button(w).text()).toBe('Войти через Telegram')
  })
})
