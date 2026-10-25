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
import { useAuth, initDataUserId, loginNoticeFor, type LoginNotice } from '@/composables/useAuth'
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
        return {
          session_token: 'new_tok',
          user: user({ id: 'user_other' }),
          bot_access_granted: true,
        }
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

// The initData of the person who opened the Mini App: Telegram user 1001.
const TG_INIT_DATA = `user=${encodeURIComponent(JSON.stringify({ id: 1001, first_name: 'B' }))}&auth_date=1&hash=x`

describe('initAuth inside Telegram', () => {
  beforeEach(() => {
    platformName = 'telegram'
    initData = TG_INIT_DATA
  })

  it('a browser token in localStorage is never read: initData decides', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 'browser_tok_of_another_account')
    vi.mocked(api.post).mockResolvedValue({ session_token: 'tg_tok', user: user() })

    const auth = await run()

    expect(usersApi.getMe).not.toHaveBeenCalled()
    expect(vi.mocked(api.post)).toHaveBeenCalledWith('/api/v1/auth/telegram', {
      init_data: TG_INIT_DATA,
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

  // Observation 2 (Standalone F3 tails): a restored session is used only if
  // its telegram_id equals the initData user. Before, ANY restored session
  // won -- right while one tab never changed hands, wrong in Telegram Web,
  // where an account switch keeps the iframe's sessionStorage. The session
  // here belongs to 1001, the initData user, so it is still restored.
  it("this run's session of the SAME Telegram user is restored first (a reload inside the Mini App)", async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'run_tok')
    vi.mocked(usersApi.getMe).mockResolvedValue(user({ telegram_id: 1001 }))

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

// Observation 2 (Standalone F3 tails): Telegram Web keeps the iframe's
// sessionStorage across an account switch in one tab. A restored session is
// used only if it belongs to the initData user; otherwise it is revoked on
// the server and initData decides.
describe('initAuth inside Telegram -- whose session is restored', () => {
  const TG_LOGIN = '/api/v1/auth/telegram'

  beforeEach(() => {
    platformName = 'telegram'
    initData = TG_INIT_DATA // Telegram user 1001 opened the app
  })

  it("account A's session, B opened the app: A revoked on the server, B signed in", async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'tok_A')
    vi.mocked(usersApi.getMe).mockResolvedValue(user({ id: 'user_A', telegram_id: 2002 }))
    vi.mocked(api.post).mockImplementation(async (path: string) => {
      if (path === TG_LOGIN)
        return { session_token: 'tok_B', user: user({ id: 'user_B', telegram_id: 1001 }) }
      return undefined
    })

    const auth = await run()

    expect(vi.mocked(api.post).mock.calls.map((c) => c[0])).toEqual([LOGOUT, TG_LOGIN])
    expect(useAuthStore().token).toBe('tok_B')
    expect(useAuthStore().user?.telegram_id).toBe(1001)
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBe('tok_B')
    expect(auth.isAuthenticated.value).toBe(true)
  })

  it('revoking A fails (no answer): B is still signed in', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'tok_A')
    vi.mocked(usersApi.getMe).mockResolvedValue(user({ telegram_id: 2002 }))
    vi.mocked(api.post).mockImplementation(async (path: string) => {
      if (path === TG_LOGIN) return { session_token: 'tok_B', user: user({ telegram_id: 1001 }) }
      throw new ApiNetworkError()
    })

    await run()

    expect(useAuthStore().token).toBe('tok_B')
  })

  it('a session with no telegram_id is not trusted: revoked, initData decides', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'tok_X')
    vi.mocked(usersApi.getMe).mockResolvedValue(user({ telegram_id: null }))
    vi.mocked(api.post).mockImplementation(async (path: string) => {
      if (path === TG_LOGIN) return { session_token: 'tok_B', user: user({ telegram_id: 1001 }) }
      return undefined
    })

    await run()

    expect(vi.mocked(api.post).mock.calls.map((c) => c[0])).toEqual([LOGOUT, TG_LOGIN])
    expect(useAuthStore().token).toBe('tok_B')
  })

  it.each([
    ['no user field', 'auth_date=1&hash=x'],
    ['user not JSON', 'user=%7Bbroken&auth_date=1&hash=x'],
    ['user without id', `user=${encodeURIComponent('{"first_name":"B"}')}&auth_date=1&hash=x`],
  ])(
    'initData naming nobody (%s): the restored session is NOT used -- revoked, stub',
    async (_label, data) => {
      initData = data
      sessionStorage.setItem(SESSION_TOKEN_KEY, 'tok_A')
      vi.mocked(usersApi.getMe).mockResolvedValue(user({ telegram_id: 2002 }))
      vi.mocked(api.post).mockImplementation(async (path: string) => {
        if (path === TG_LOGIN)
          throw new ApiResponseError(400, 'Missing user in initData', 'bad_request')
        return undefined
      })

      const auth = await run()

      expect(postsTo(LOGOUT)).toHaveLength(1)
      expect(auth.isAuthenticated.value).toBe(false) // App.vue -> TelegramStubView
      expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull()
    },
  )

  it('the same person reopening: no revoke, no initData sign-in', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'tok_B')
    vi.mocked(usersApi.getMe).mockResolvedValue(user({ telegram_id: 1001 }))

    await run()

    expect(vi.mocked(api.post)).not.toHaveBeenCalled()
    expect(useAuthStore().token).toBe('tok_B')
  })

  it('nothing restored: initData sign-in, nothing to revoke', async () => {
    vi.mocked(api.post).mockResolvedValue({
      session_token: 'tok_B',
      user: user({ telegram_id: 1001 }),
    })

    await run()

    expect(postsTo(LOGOUT)).toHaveLength(0)
    expect(postsTo(TG_LOGIN)).toHaveLength(1)
  })
})

describe('initDataUserId', () => {
  const enc = (v: unknown) => encodeURIComponent(JSON.stringify(v))
  it.each<[string, string | null, number | null]>([
    ['the user id', `user=${enc({ id: 1001 })}&auth_date=1`, 1001],
    ['a large id', `user=${enc({ id: 7_000_000_001 })}`, 7_000_000_001],
    ['null initData', null, null],
    ['empty initData', '', null],
    ['no user', 'auth_date=1&hash=x', null],
    ['empty user', 'user=&auth_date=1', null],
    ['user not JSON', 'user=%7Bnope', null],
    ['user is null', `user=${enc(null)}`, null],
    ['no id', `user=${enc({ first_name: 'B' })}`, null],
    ['id as a string', `user=${enc({ id: '1001' })}`, null],
    ['id not an integer', `user=${enc({ id: 1.5 })}`, null],
  ])('%s', (_label, data, expected) => {
    expect(initDataUserId(data)).toBe(expected)
  })
})

describe('startBrowserLogin', () => {
  it('remembers { state, mark } and leaves for Telegram', async () => {
    vi.mocked(api.post).mockResolvedValue({
      url: 'https://oauth.telegram.org/auth?x=1',
      state: 'S9',
    })
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
