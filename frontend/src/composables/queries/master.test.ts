// =============================================================================
// VELO Frontend -- the master profile on Colada (FE-166 step 5)
// =============================================================================
//
// `GET /masters/me` used to live in stores/master.ts (fetchMyProfile and its
// flags); now one Colada entry read by the router guards and the master
// screens (composables/queries/master.ts). Real Pinia and Colada, mocked API
// seam.
//
// What is under test, and why:
//   1. "No application at all" is keyed on the machine code
//      (master_profile_not_found, №257), never on a missing profile: a
//      pending application or a network error must not send a real master
//      into the apply wizard.
//   2. One answer per session: a second load asks nothing; `force` does; a
//      failed load is asked again by the next reader.
//   3. A screen with the reader turned off never sends the request (an
//      account that is not a master gets a 403 for it).
//   4. Writes from a mutation's answer, and the end of a session.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { PiniaColada, useQueryCache } from '@pinia/colada'
import { coladaOptions, useQueryScopeStore } from '@/composables/queries/setup'
import {
  cachedMasterProfile,
  loadMasterProfile,
  setMasterProfile,
  useMasterProfile,
} from '@/composables/queries/master'
import { ApiResponseError } from '@/api/client'
import * as mastersApi from '@/api/masters'
import type { MasterProfileResponse } from '@/api/types'

vi.mock('@/api/masters')

function fakeProfile(overrides: Partial<MasterProfileResponse> = {}): MasterProfileResponse {
  return {
    user_id: 'master_1',
    status: 'verified',
    display_name: 'Test Master',
    frozen_cents: 0,
    available_cents: 10000,
    min_withdrawal_cents: 5000,
    withdrawal_fee_cents: 0,
    created_at: '2026-01-01T00:00:00Z',
    rejection_reason: null,
    ...overrides,
  }
}

let pinia: Pinia
let app: App | null = null
let screen: ReturnType<typeof useMasterProfile>

/** A screen that reads the profile. */
function mountScreen(enabled = true): void {
  const Screen = defineComponent({
    setup() {
      screen = useMasterProfile(enabled)
      return () => h('div')
    },
  })
  app = createApp(Screen).use(pinia)
  app.mount(document.createElement('div'))
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  pinia = createPinia()
  createApp({}).use(pinia).use(PiniaColada, coladaOptions)
  setActivePinia(pinia)
  vi.mocked(mastersApi.getMyMasterProfile).mockReset()
})

afterEach(() => {
  app?.unmount()
  app = null
})

describe('loadMasterProfile (the guards)', () => {
  it('on success: the profile is held and nothing is missing', async () => {
    vi.mocked(mastersApi.getMyMasterProfile).mockResolvedValue(fakeProfile())

    const result = await loadMasterProfile()

    expect(result).toEqual({ profile: fakeProfile(), missing: false })
    expect(cachedMasterProfile()).toEqual({ profile: fakeProfile(), missing: false })
  })

  it('403 master_profile_not_found reads as missing (the apply wizard)', async () => {
    vi.mocked(mastersApi.getMyMasterProfile).mockRejectedValue(
      new ApiResponseError(403, 'Профиль мастера не найден', 'master_profile_not_found'),
    )

    expect(await loadMasterProfile()).toEqual({ profile: null, missing: true })
  })

  it('403 master_profile_not_verified (a pending application) is not missing', async () => {
    vi.mocked(mastersApi.getMyMasterProfile).mockRejectedValue(
      new ApiResponseError(403, 'Профиль ожидает проверки', 'master_profile_not_verified'),
    )

    expect(await loadMasterProfile()).toEqual({ profile: null, missing: false })
  })

  it('a network failure is not missing -- only the specific 403 code is', async () => {
    vi.mocked(mastersApi.getMyMasterProfile).mockRejectedValue(new Error('network down'))

    expect(await loadMasterProfile()).toEqual({ profile: null, missing: false })
  })

  it('a held profile is not asked for again; force asks', async () => {
    vi.mocked(mastersApi.getMyMasterProfile).mockResolvedValue(fakeProfile())

    await loadMasterProfile()
    await loadMasterProfile()
    expect(mastersApi.getMyMasterProfile).toHaveBeenCalledTimes(1)

    await loadMasterProfile(undefined, { force: true })
    expect(mastersApi.getMyMasterProfile).toHaveBeenCalledTimes(2)
  })

  it('a failed load is asked again by the next reader, and a success clears missing', async () => {
    vi.mocked(mastersApi.getMyMasterProfile).mockRejectedValueOnce(
      new ApiResponseError(403, 'Профиль мастера не найден', 'master_profile_not_found'),
    )
    expect((await loadMasterProfile()).missing).toBe(true)

    vi.mocked(mastersApi.getMyMasterProfile).mockResolvedValue(fakeProfile())
    expect(await loadMasterProfile()).toEqual({ profile: fakeProfile(), missing: false })
    expect(mastersApi.getMyMasterProfile).toHaveBeenCalledTimes(2)
  })

  it('a failed refetch keeps the profile held before it', async () => {
    vi.mocked(mastersApi.getMyMasterProfile).mockResolvedValueOnce(fakeProfile())
    await loadMasterProfile()
    vi.mocked(mastersApi.getMyMasterProfile).mockRejectedValue(new Error('network down'))

    expect(await loadMasterProfile(undefined, { force: true })).toEqual({
      profile: fakeProfile(),
      missing: false,
    })
  })
})

describe('useMasterProfile (the screens)', () => {
  it('a mounted screen loads the profile once; a second screen reuses it', async () => {
    vi.mocked(mastersApi.getMyMasterProfile).mockResolvedValue(fakeProfile())
    mountScreen()
    expect(screen.loading.value).toBe(true)
    await flush()

    expect(screen.profile.value).toEqual(fakeProfile())
    expect(screen.loaded.value).toBe(true)
    expect(screen.loading.value).toBe(false)

    app?.unmount()
    mountScreen()
    await flush()
    expect(mastersApi.getMyMasterProfile).toHaveBeenCalledTimes(1)
  })

  it('turned off, it reads what is held and sends nothing until reload()', async () => {
    vi.mocked(mastersApi.getMyMasterProfile).mockResolvedValue(fakeProfile())
    mountScreen(false)
    await flush()

    expect(mastersApi.getMyMasterProfile).not.toHaveBeenCalled()
    expect(screen.profile.value).toBeNull()

    const state = await screen.reload()
    expect(state.status).toBe('success')
    expect(screen.profile.value).toEqual(fakeProfile())
  })

  it('reload() resolves with the error state and never rejects; missing follows the code', async () => {
    vi.mocked(mastersApi.getMyMasterProfile).mockRejectedValue(
      new ApiResponseError(403, 'Профиль мастера не найден', 'master_profile_not_found'),
    )
    mountScreen(false)

    const state = await screen.reload()

    expect(state.status).toBe('error')
    expect(screen.missing.value).toBe(true)
    expect(screen.failed.value).toBe(true)
  })

  it('the profile survives the screen: the guards read it with nobody holding the entry', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(mastersApi.getMyMasterProfile).mockResolvedValue(fakeProfile())
      mountScreen()
      await vi.runOnlyPendingTimersAsync()
      app?.unmount()
      app = null

      // Colada's default gcTime is 5 minutes; this entry is kept for the session.
      await vi.advanceTimersByTimeAsync(60 * 60_000)

      expect(cachedMasterProfile().profile).toEqual(fakeProfile())
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('writes and the session', () => {
  it('setMasterProfile writes a mutation answer into the held profile', async () => {
    vi.mocked(mastersApi.getMyMasterProfile).mockResolvedValue(fakeProfile())
    await loadMasterProfile()

    setMasterProfile(useQueryCache(), (p) => ({ ...p, display_name: 'Renamed' }))

    expect(cachedMasterProfile().profile?.display_name).toBe('Renamed')
  })

  it('setMasterProfile does nothing while no profile is held', () => {
    setMasterProfile(useQueryCache(), (p) => ({ ...p, display_name: 'Renamed' }))

    expect(useQueryCache().getEntries({ key: ['masters'] })).toHaveLength(0)
  })

  it('the end of a session forgets the profile: the next account asks again', async () => {
    vi.mocked(mastersApi.getMyMasterProfile).mockResolvedValue(fakeProfile())
    await loadMasterProfile()

    useQueryScopeStore().$reset()

    expect(cachedMasterProfile().profile).toBeNull()
    await loadMasterProfile()
    expect(mastersApi.getMyMasterProfile).toHaveBeenCalledTimes(2)
  })
})
