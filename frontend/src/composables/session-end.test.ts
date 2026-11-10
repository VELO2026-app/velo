// =============================================================================
// VELO Frontend -- composables that react to the end of the session
// =============================================================================
//
// stores/auth.ts no longer imports useAuth / useRoleFreshness on demand: they
// subscribe through onSessionEnd (platform/session.ts). These tests run the
// REAL auth store and composables and hold the behaviour the dynamic imports
// used to give: logout stops the role-freshness poll and, in Telegram only,
// arms the logout gate (before the session is cleared); a dropped session
// (a failed sign-in) stops the poll but never arms the gate.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, watch } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { accountScopePlugin } from '@/platform/session'
import { useAuth, resetAuthState } from '@/composables/useAuth'
import { startRoleFreshnessPoll, __resetRoleFreshnessForTest } from '@/composables/useRoleFreshness'
import { api } from '@/api/client'
import type { UserResponse } from '@/api/types'

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>()
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }
})
vi.mock('@/api/users')

let platformName: 'telegram' | 'standalone' = 'standalone'
vi.mock('@/platform', () => ({
  get platform() {
    return {
      name: platformName,
      close: vi.fn(),
      readSessionToken: () => null,
      writeSessionToken: () => undefined,
      getStartParam: () => null,
    }
  },
}))

const user = { id: 'user_1', role: 'user', first_name: 'T' } as UserResponse

describe('session end -> composables', () => {
  let fetchMe: ReturnType<typeof vi.spyOn>

  /** Whether the role-freshness poll still ticks fetchMe(). */
  function pollTicks(): boolean {
    fetchMe.mockClear()
    vi.advanceTimersByTime(120_000)
    return fetchMe.mock.calls.length > 0
  }

  beforeEach(() => {
    const pinia = createPinia().use(accountScopePlugin)
    createApp({}).use(pinia)
    setActivePinia(pinia)
    vi.useFakeTimers()
    vi.mocked(api.post).mockResolvedValue(undefined)
    resetAuthState()
    __resetRoleFreshnessForTest()
    platformName = 'standalone'
    const store = useAuthStore()
    store.token = 'tok'
    store.user = user
    fetchMe = vi.spyOn(store, 'fetchMe').mockResolvedValue(true)
  })

  afterEach(() => {
    __resetRoleFreshnessForTest()
    resetAuthState()
    vi.useRealTimers()
  })

  it('logout (standalone) stops the poll and leaves the gate down', async () => {
    startRoleFreshnessPoll()
    expect(pollTicks()).toBe(true)

    await useAuthStore().logout()

    expect(pollTicks()).toBe(false)
    expect(useAuth().isLoggingOut.value).toBe(false)
  })

  it('logout (Telegram) stops the poll and arms the gate before the session is cleared', async () => {
    platformName = 'telegram'
    startRoleFreshnessPoll()
    const store = useAuthStore()
    const { isLoggingOut } = useAuth()
    let gateWhenTokenCleared: boolean | null = null
    watch(
      () => store.token,
      (token) => {
        if (token === null) gateWhenTokenCleared = isLoggingOut.value
      },
      { flush: 'sync' },
    )

    await store.logout()

    expect(pollTicks()).toBe(false)
    expect(isLoggingOut.value).toBe(true)
    expect(gateWhenTokenCleared).toBe(true)
  })

  it('a dropped session stops the poll but never arms the gate, even in Telegram', async () => {
    platformName = 'telegram'
    startRoleFreshnessPoll()
    expect(pollTicks()).toBe(true)
    vi.mocked(api.post).mockRejectedValue(new Error('refused'))

    // A failed sign-in ends the session without a logout.
    await expect(useAuthStore().loginViaTelegram('bad')).resolves.toBe(false)

    expect(pollTicks()).toBe(false)
    expect(useAuth().isLoggingOut.value).toBe(false)
  })
})
