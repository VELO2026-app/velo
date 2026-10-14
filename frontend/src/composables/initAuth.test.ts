// =============================================================================
// VELO Frontend -- initAuth() and the browser sign-in (Standalone phase 3)
// =============================================================================
//
// The REAL auth store and the REAL token carriers (platform/session-token.ts)
// and return reader (platform/browser-login.ts); only the network (@/api) and
// the platform's identity (@/platform: name, initData) are stand-ins. The
// return from Telegram is opened on happy-dom's window the way a browser
// lands on it, and initAuth() runs as App.vue runs it.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { api, ApiNetworkError, ApiResponseError, ApiTimeoutError } from '@/api/client'
import * as usersApi from '@/api/users'
import { useAuthStore } from '@/stores/auth'
import { useAuth, loginNoticeFor, type LoginNotice } from '@/composables/useAuth'
import { LOGIN_MARK_KEY, RETURN_PATH, rememberLoginMark } from '@/platform/browser-login'
import { SESSION_TOKEN_KEY } from '@/platform/session-token'
import type { UserResponse } from '@/api/types'

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>()
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  }
})
vi.mock('@/api/users')

let platformName: 'telegram' | 'standalone' = 'standalone'
let initData: string | null = null
vi.mock('@/platform', async () => {
  const { sessionTokenStore } = await import('@/platform/session-token')
  const carriers = {
    telegram: sessionTokenStore(() => sessionStorage),
    standalone: sessionTokenStore(() => localStorage),
  }
  return {
    get platform() {
      return {
        name: platformName,
        init: async () => {},
        getStartParam: () => null,
        getInitData: () => initData,
        close: () => {},
        readSessionToken: () => carriers[platformName].read(),
        writeSessionToken: (token: string | null) => carriers[platformName].write(token),
      }
    },
  }
})

const COMPLETE = '/api/v1/auth/telegram/browser/complete'
const LOGOUT = '/api/v1/auth/logout'

function user(overrides: Partial<UserResponse> = {}): UserResponse {
  return {
    id: 'user_1',
    role: 'user',
    first_name: 'Test',
    last_name: null,
    onboarding_completed: true,
    ...overrides,
  } as UserResponse
}

function openReturn(query: string): void {
  window.history.replaceState(null, '', `${RETURN_PATH}?${query}`)
}

function postsTo(path: string): unknown[][] {
  return vi.mocked(api.post).mock.calls.filter((call) => call[0] === path)
}

async function run(): Promise<ReturnType<typeof useAuth>> {
  const auth = useAuth()
  await auth.initAuth()
  return auth
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState(null, '', '/')
  vi.mocked(api.post).mockReset()
  vi.mocked(usersApi.getMe).mockReset()
  platformName = 'standalone'
  initData = null
})

describe('initAuth outside Telegram', () => {
  it('nothing saved, no return: ready, not signed in, no notice -- the login screen', async () => {
    const auth = await run()

    expect(auth.isReady.value).toBe(true)
    expect(auth.isAuthenticated.value).toBe(false)
    expect(auth.loginNotice.value).toBeNull()
    expect(auth.restoreUnreachable.value).toBe(false)
  })

  it('a saved session survives a relaunch of the installed app', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 'kept_tok')
    vi.mocked(usersApi.getMe).mockResolvedValue(user())

    const auth = await run()

    expect(auth.isAuthenticated.value).toBe(true)
    expect(useAuthStore().token).toBe('kept_tok')
  })

  it('a saved session the server cannot be asked about: the "try again" screen, token kept', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 'kept_tok')
    vi.mocked(usersApi.getMe).mockRejectedValue(new ApiNetworkError())

    const auth = await run()

    expect(auth.isAuthenticated.value).toBe(false)
    expect(auth.restoreUnreachable.value).toBe(true)
    expect(localStorage.getItem(SESSION_TOKEN_KEY)).toBe('kept_tok')
  })

  it('the return with a matching mark: signed in, address wiped, mark spent', async () => {
    rememberLoginMark({ state: 'S1', mark: 'M1' })
    openReturn('code=C1&state=S1')
    vi.mocked(api.post).mockResolvedValue({
      session_token: 'new_tok',
      user: user({ onboarding_completed: false }),
      bot_access_granted: true,
    })

    const auth = await run()

    expect(postsTo(COMPLETE)).toHaveLength(1)
    const body = postsTo(COMPLETE)[0]?.[1] as Record<string, unknown>
    expect(body).toMatchObject({ code: 'C1', state: 'S1', mark: 'M1' })
    expect(body.language).toBe(window.navigator.language)
    expect(auth.isAuthenticated.value).toBe(true)
    expect(localStorage.getItem(SESSION_TOKEN_KEY)).toBe('new_tok')
    expect(window.location.pathname).toBe('/')
    expect(window.location.search).toBe('')
    expect(localStorage.getItem(LOGIN_MARK_KEY)).toBeNull()
    expect(auth.botAccessHint.value).toBe(false)
    // The sign-in finished BEFORE readiness: the stage sees the user.
    expect(auth.isReady.value).toBe(true)
    expect(useAuthStore().user?.onboarding_completed).toBe(false)
  })

  it('bot access not granted: the hint is raised for this sign-in', async () => {
    rememberLoginMark({ state: 'S1', mark: 'M1' })
    openReturn('code=C1&state=S1')
    vi.mocked(api.post).mockResolvedValue({
      session_token: 'new_tok',
      user: user(),
      bot_access_granted: false,
    })

    const auth = await run()

    expect(auth.botAccessHint.value).toBe(true)
  })

  it('a return this browser holds NO mark for: refused, the backend is never called', async () => {
    openReturn('code=ATTACKER&state=ATTACKER_STATE')

    const auth = await run()

    expect(vi.mocked(api.post)).not.toHaveBeenCalled()
    expect(auth.isAuthenticated.value).toBe(false)
    expect(auth.loginNotice.value).toBe('foreign')
  })

  it('a mark for ANOTHER state: refused, not called, the mark spent anyway', async () => {
    rememberLoginMark({ state: 'MINE', mark: 'M1' })
    openReturn('code=ATTACKER&state=ATTACKER_STATE')

    const auth = await run()

    expect(postsTo(COMPLETE)).toHaveLength(0)
    expect(auth.loginNotice.value).toBe('foreign')
    expect(localStorage.getItem(LOGIN_MARK_KEY)).toBeNull()
  })

  it('a foreign return while already signed in: the session stays, nothing to show', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 'mine_tok')
    vi.mocked(usersApi.getMe).mockResolvedValue(user())
    openReturn('code=ATTACKER&state=ATTACKER_STATE')

    const auth = await run()

    expect(postsTo(COMPLETE)).toHaveLength(0)
    expect(auth.isAuthenticated.value).toBe(true)
    expect(useAuthStore().token).toBe('mine_tok')
    expect(auth.loginNotice.value).toBeNull()
  })

  it('declined on Telegram\'s page: "cancelled", nothing called, mark spent', async () => {
    rememberLoginMark({ state: 'S1', mark: 'M1' })
    openReturn('error=access_denied&state=S1')

    const auth = await run()

    expect(vi.mocked(api.post)).not.toHaveBeenCalled()
    expect(auth.loginNotice.value).toBe('cancelled')
    expect(localStorage.getItem(LOGIN_MARK_KEY)).toBeNull()
  })

  it('a state without a code: Telegram did not confirm, nothing called', async () => {
    rememberLoginMark({ state: 'S1', mark: 'M1' })
    openReturn('state=S1')

    const auth = await run()

    expect(vi.mocked(api.post)).not.toHaveBeenCalled()
    expect(auth.loginNotice.value).toBe('telegram_failed')
  })

  it('a reload after a refused return shows a clean login screen -- the used state is not replayed', async () => {
    // First load: the return, refused by the backend (the state expired).
    rememberLoginMark({ state: 'S1', mark: 'M1' })
    openReturn('code=C1&state=S1')
    vi.mocked(api.post).mockRejectedValue(
      new ApiResponseError(400, 'The sign-in link has expired.', 'login_expired'),
    )
    const first = await run()
    expect(first.loginNotice.value).toBe('expired')

    // The person reloads the page.
    setActivePinia(createPinia())
    const second = await run()

    expect(postsTo(COMPLETE)).toHaveLength(1)
    expect(second.loginNotice.value).toBeNull()
  })

  it('signing in over a saved session closes the old one on the server first', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 'old_tok')
    rememberLoginMark({ state: 'S1', mark: 'M1' })
    openReturn('code=C1&state=S1')
    vi.mocked(api.post).mockImplementation(async (path: string) => {
      if (path === COMPLETE) {
        return { session_token: 'new_tok', user: user({ id: 'user_other' }), bot_access_granted: true }
      }
      return undefined
    })

    const auth = await run()

    expect(postsTo(LOGOUT)).toHaveLength(1)
    const order = vi.mocked(api.post).mock.calls.map((call) => call[0])
    expect(order).toEqual([COMPLETE, LOGOUT])
    expect(auth.isAuthenticated.value).toBe(true)
    expect(useAuthStore().token).toBe('new_tok')
    expect(localStorage.getItem(SESSION_TOKEN_KEY)).toBe('new_tok')
  })

  it('the old session already gone (401 on logout): the new sign-in still stands', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 'old_tok')
    rememberLoginMark({ state: 'S1', mark: 'M1' })
    openReturn('code=C1&state=S1')
    vi.mocked(api.post).mockImplementation(async (path: string) => {
      if (path === COMPLETE) {
        return { session_token: 'new_tok', user: user(), bot_access_granted: true }
      }
      throw new ApiResponseError(401, 'Session expired', 'unauthorized')
    })

    const auth = await run()

    expect(auth.isAuthenticated.value).toBe(true)
    expect(localStorage.getItem(SESSION_TOKEN_KEY)).toBe('new_tok')
  })

  it('a failed completion leaves a saved session as it was', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 'old_tok')
    vi.mocked(usersApi.getMe).mockResolvedValue(user())
    rememberLoginMark({ state: 'S1', mark: 'M1' })
    openReturn('code=C1&state=S1')
    vi.mocked(api.post).mockRejectedValue(new ApiNetworkError())

    const auth = await run()

    expect(postsTo(LOGOUT)).toHaveLength(0)
    expect(useAuthStore().token).toBe('old_tok')
    expect(auth.isAuthenticated.value).toBe(true)
  })
})

describe('initAuth inside Telegram -- unchanged by Standalone phase 3', () => {
  beforeEach(() => {
    platformName = 'telegram'
    initData = 'init_data_payload'
  })

  it('a browser token in localStorage is never read: initData decides', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 'browser_tok_of_another_account')
    vi.mocked(api.post).mockResolvedValue({ session_token: 'tg_tok', user: user() })

    const auth = await run()

    expect(usersApi.getMe).not.toHaveBeenCalled()
    expect(vi.mocked(api.post)).toHaveBeenCalledWith('/api/v1/auth/telegram', {
      init_data: 'init_data_payload',
    })
    expect(useAuthStore().token).toBe('tg_tok')
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBe('tg_tok')
    expect(localStorage.getItem(SESSION_TOKEN_KEY)).toBe('browser_tok_of_another_account')
    expect(auth.isAuthenticated.value).toBe(true)
  })

  it('a return address inside Telegram is not read as a browser return', async () => {
    rememberLoginMark({ state: 'S1', mark: 'M1' })
    openReturn('code=C1&state=S1')
    vi.mocked(api.post).mockResolvedValue({ session_token: 'tg_tok', user: user() })

    await run()

    expect(postsTo(COMPLETE)).toHaveLength(0)
  })

  it('this run\'s session is restored first, as before (a reload inside the Mini App)', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'run_tok')
    vi.mocked(usersApi.getMe).mockResolvedValue(user())

    await run()

    expect(vi.mocked(api.post)).not.toHaveBeenCalled()
    expect(useAuthStore().token).toBe('run_tok')
  })

  it('restore unreachable: falls to initData as before, no "try again" screen', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'run_tok')
    vi.mocked(usersApi.getMe).mockRejectedValue(new ApiNetworkError())
    vi.mocked(api.post).mockResolvedValue({ session_token: 'tg_tok', user: user() })

    const auth = await run()

    expect(auth.restoreUnreachable.value).toBe(false)
    expect(useAuthStore().token).toBe('tg_tok')
  })
})

describe('startBrowserLogin', () => {
  it('remembers { state, mark } and leaves for Telegram', async () => {
    vi.mocked(api.post).mockResolvedValue({ url: 'https://oauth.telegram.org/auth?x=1', state: 'S9' })
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})

    await useAuthStore().startBrowserLogin()

    const [path, body] = vi.mocked(api.post).mock.calls[0] as [string, { mark: string }]
    expect(path).toBe('/api/v1/auth/telegram/browser/start')
    const kept = JSON.parse(localStorage.getItem(LOGIN_MARK_KEY) ?? 'null')
    expect(kept).toEqual({ state: 'S9', mark: body.mark })
    expect(assign).toHaveBeenCalledWith('https://oauth.telegram.org/auth?x=1')
    assign.mockRestore()
  })

  it('a refused start keeps no mark and goes nowhere', async () => {
    vi.mocked(api.post).mockRejectedValue(
      new ApiResponseError(404, 'not configured', 'login_not_configured'),
    )
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})

    await expect(useAuthStore().startBrowserLogin()).rejects.toBeInstanceOf(ApiResponseError)

    expect(localStorage.getItem(LOGIN_MARK_KEY)).toBeNull()
    expect(assign).not.toHaveBeenCalled()
    assign.mockRestore()
  })
})

describe('loginNoticeFor', () => {
  it.each<[string, unknown, LoginNotice]>([
    ['404', new ApiResponseError(404, 'x', 'login_not_configured'), 'not_configured'],
    ['400 expired', new ApiResponseError(400, 'x', 'login_expired'), 'expired'],
    ['400 foreign', new ApiResponseError(400, 'x', 'login_foreign'), 'foreign'],
    ['400 telegram', new ApiResponseError(400, 'x', 'telegram_failed'), 'telegram_failed'],
    ['400 other', new ApiResponseError(400, 'x', 'whatever'), 'telegram_failed'],
    ['422', new ApiResponseError(422, 'x', 'validation_error'), 'telegram_failed'],
    ['403', new ApiResponseError(403, 'x', 'account_deactivated'), 'deactivated'],
    ['429', new ApiResponseError(429, 'x', 'too_many_requests'), 'rate_limited'],
    ['503', new ApiResponseError(503, 'x', 'service_unavailable'), 'unavailable'],
    ['500', new ApiResponseError(500, 'x', 'internal'), 'unavailable'],
    ['network', new ApiNetworkError(), 'network'],
    ['timeout', new ApiTimeoutError(), 'network'],
    ['anything else', new Error('boom'), 'telegram_failed'],
  ])('%s -> %s', (_label, error, notice) => {
    expect(loginNoticeFor(error)).toBe(notice)
  })
})
