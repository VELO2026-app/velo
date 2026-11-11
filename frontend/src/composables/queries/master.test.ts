// =============================================================================
// VELO Frontend -- the master profile on Colada (FE-166 step 5)
// =============================================================================
//
// `GET /masters/me` and the master's own practice lists used to live in
// stores/master.ts (fetchMyProfile, two usePagination cursors); now Colada
// entries read by the router guards and the master screens
// (composables/queries/master.ts). Real Pinia and Colada, mocked API seam.
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
//   5. The practice lists: two independent buckets, each loaded only when a
//      screen needs it (T22-3/T22-5); the dashboard's ask-on-every-mount
//      (FE-53); a practice change refetches them even off screen.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { PiniaColada, useQueryCache } from '@pinia/colada'
import { coladaOptions, useQueryScopeStore } from '@/composables/queries/setup'
import {
  cachedMasterProfile,
  cachedMyPractice,
  loadMasterProfile,
  myPracticesChanged,
  setMasterProfile,
  useMasterProfile,
  useMyPractices,
  type MyPracticesBucket,
  type UseMyPracticesOptions,
} from '@/composables/queries/master'
import { keys } from '@/composables/queries/keys'
import { ApiResponseError } from '@/api/client'
import * as mastersApi from '@/api/masters'
import type { MasterProfileResponse, PracticeResponse } from '@/api/types'

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

function fakePractice(id: string): PracticeResponse {
  return { id, scheduled_at: '2026-06-15T12:00:00Z' } as PracticeResponse
}

function page(items: PracticeResponse[], total = items.length, offset = 0) {
  return { items, total, limit: 20, offset }
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
  vi.mocked(mastersApi.getMyPractices).mockReset().mockResolvedValue(page([]))
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

describe('useMyPractices (the practice lists)', () => {
  let lists: Record<string, ReturnType<typeof useMyPractices>>
  let listsApp: App | null = null

  /** A screen that reads some of the lists. */
  function mountLists(wanted: Array<[MyPracticesBucket, UseMyPracticesOptions?]>): void {
    const Screen = defineComponent({
      setup() {
        lists = {}
        for (const [bucket, options] of wanted) lists[bucket] = useMyPractices(bucket, options)
        return () => h('div')
      },
    })
    listsApp = createApp(Screen).use(pinia)
    listsApp.mount(document.createElement('div'))
  }

  function unmountLists(): void {
    listsApp?.unmount()
    listsApp = null
  }

  afterEach(unmountLists)

  it('the upcoming list asks the upcoming bucket only; the past one is never touched', async () => {
    const items = [fakePractice('u1'), fakePractice('u2')]
    vi.mocked(mastersApi.getMyPractices).mockResolvedValue(page(items, 2))
    mountLists([['upcoming']])
    await flush()

    expect(mastersApi.getMyPractices).toHaveBeenCalledTimes(1)
    expect(mastersApi.getMyPractices).toHaveBeenCalledWith('upcoming', 20, 0)
    expect(lists.upcoming!.practices.value).toEqual(items)
    expect(lists.upcoming!.total.value).toBe(2)
  })

  it('a list turned off is not asked for until it is turned on (the past tab)', async () => {
    const open = ref(false)
    vi.mocked(mastersApi.getMyPractices).mockResolvedValue(page([fakePractice('p1')]))
    mountLists([['past', { enabled: open }]])
    await flush()
    expect(mastersApi.getMyPractices).not.toHaveBeenCalled()

    open.value = true
    await flush()

    expect(mastersApi.getMyPractices).toHaveBeenCalledWith('past', 20, 0)
    expect(lists.past!.practices.value.map((p) => p.id)).toEqual(['p1'])
  })

  it('a remount within the staleness window asks nothing -- even for zero practices (W-4)', async () => {
    mountLists([['upcoming']])
    await flush()
    unmountLists()
    mountLists([['upcoming']])
    await flush()

    expect(mastersApi.getMyPractices).toHaveBeenCalledTimes(1)
  })

  it("refetchOnMount 'always' asks on every mount and keeps the cards up meanwhile (FE-53)", async () => {
    vi.mocked(mastersApi.getMyPractices).mockResolvedValueOnce(page([fakePractice('old')]))
    mountLists([['upcoming', { refetchOnMount: 'always' }]])
    await flush()
    unmountLists()

    let answer: (value: ReturnType<typeof page>) => void = () => {}
    vi.mocked(mastersApi.getMyPractices).mockReturnValueOnce(
      new Promise((resolve) => (answer = resolve)),
    )
    mountLists([['upcoming', { refetchOnMount: 'always' }]])
    await flush()
    expect(mastersApi.getMyPractices).toHaveBeenCalledTimes(2)
    expect(lists.upcoming!.practices.value.map((p) => p.id)).toEqual(['old'])
    expect(lists.upcoming!.loading.value).toBe(false)

    answer(page([fakePractice('fresh')]))
    await flush()
    expect(lists.upcoming!.practices.value.map((p) => p.id)).toEqual(['fresh'])
  })

  it('a failed refetch keeps the list on screen (no error state)', async () => {
    vi.mocked(mastersApi.getMyPractices).mockResolvedValueOnce(page([fakePractice('kept')]))
    mountLists([['upcoming', { refetchOnMount: 'always' }]])
    await flush()
    unmountLists()
    vi.mocked(mastersApi.getMyPractices).mockRejectedValue(new Error('network down'))
    mountLists([['upcoming', { refetchOnMount: 'always' }]])
    await flush()

    expect(lists.upcoming!.practices.value.map((p) => p.id)).toEqual(['kept'])
    expect(lists.upcoming!.failed.value).toBe(false)
  })

  it('a failed first load is the error state', async () => {
    vi.mocked(mastersApi.getMyPractices).mockRejectedValue(new Error('network down'))
    mountLists([['upcoming']])
    await flush()

    expect(lists.upcoming!.failed.value).toBe(true)
    expect(lists.upcoming!.error.value).toBeInstanceOf(Error)
  })

  it('loadMore asks the next offset and appends; a failed next page rejects and keeps the list', async () => {
    const first = Array.from({ length: 20 }, (_, i) => fakePractice(`a${i}`))
    vi.mocked(mastersApi.getMyPractices).mockResolvedValueOnce(page(first, 21))
    mountLists([['past']])
    await flush()
    expect(lists.past!.hasMore.value).toBe(true)

    vi.mocked(mastersApi.getMyPractices).mockRejectedValueOnce(new Error('page 2 down'))
    await expect(lists.past!.loadMore()).rejects.toThrow('page 2 down')
    expect(lists.past!.practices.value).toHaveLength(20)

    vi.mocked(mastersApi.getMyPractices).mockResolvedValueOnce(page([fakePractice('b0')], 21, 20))
    await lists.past!.loadMore()
    expect(mastersApi.getMyPractices).toHaveBeenLastCalledWith('past', 20, 20)
    expect(lists.past!.practices.value).toHaveLength(21)
    expect(lists.past!.hasMore.value).toBe(false)
  })

  it('cachedMyPractice finds a practice in either loaded list, without a request', async () => {
    vi.mocked(mastersApi.getMyPractices).mockImplementation((bucket) =>
      Promise.resolve(page([fakePractice(bucket === 'upcoming' ? 'u1' : 'p1')])),
    )
    mountLists([['upcoming'], ['past']])
    await flush()
    vi.mocked(mastersApi.getMyPractices).mockClear()

    expect(cachedMyPractice(useQueryCache(), 'p1')?.id).toBe('p1')
    expect(cachedMyPractice(useQueryCache(), 'u1')?.id).toBe('u1')
    expect(cachedMyPractice(useQueryCache(), 'nope')).toBeUndefined()
    expect(mastersApi.getMyPractices).not.toHaveBeenCalled()
  })

  it('myPracticesChanged refetches my lists even off screen, and marks other practice lists stale', async () => {
    mountLists([['upcoming'], ['past']])
    await flush()
    unmountLists()
    // Another practice list (a school feed) and a practice detail, fresh.
    const queryCache = useQueryCache()
    const feed = queryCache.ensure({
      key: keys.practices.schoolFeed('s1', 3),
      query: async () => [],
    })
    await queryCache.fetch(feed)
    vi.mocked(mastersApi.getMyPractices).mockClear()
    vi.mocked(mastersApi.getMyPractices).mockResolvedValue(page([fakePractice('new')]))

    await myPracticesChanged(queryCache)

    expect(mastersApi.getMyPractices).toHaveBeenCalledWith('upcoming', 20, 0)
    expect(mastersApi.getMyPractices).toHaveBeenCalledWith('past', 20, 0)
    expect(cachedMyPractice(queryCache, 'new')?.id).toBe('new')
    expect(feed.stale).toBe(true)
  })

  it('myPracticesChanged leaves a list nobody has loaded unasked (the unopened past tab)', async () => {
    mountLists([['upcoming'], ['past', { enabled: false }]])
    await flush()
    unmountLists()
    vi.mocked(mastersApi.getMyPractices).mockClear()

    await myPracticesChanged(useQueryCache())

    expect(mastersApi.getMyPractices).toHaveBeenCalledTimes(1)
    expect(mastersApi.getMyPractices).toHaveBeenCalledWith('upcoming', 20, 0)
  })

  it('a load-more during a refetch waits for it instead of cancelling it', async () => {
    const first = Array.from({ length: 20 }, (_, i) => fakePractice(`a${i}`))
    vi.mocked(mastersApi.getMyPractices).mockResolvedValueOnce(page(first, 40))
    mountLists([['upcoming']])
    await flush()

    let answer: (value: ReturnType<typeof page>) => void = () => {}
    vi.mocked(mastersApi.getMyPractices).mockReturnValueOnce(
      new Promise((resolve) => (answer = resolve)),
    )
    const refetch = lists.upcoming!.refetch()
    const more = lists.upcoming!.loadMore()
    answer(page([fakePractice('fresh'), ...first.slice(1)], 40))
    await refetch
    await more

    // The refetch's page 1 landed (not dropped as cancelled).
    expect(lists.upcoming!.practices.value[0]?.id).toBe('fresh')
  })

  it('myPracticesChanged never rejects when a refetch fails', async () => {
    mountLists([['upcoming']])
    await flush()
    unmountLists()
    vi.mocked(mastersApi.getMyPractices).mockRejectedValue(new Error('network down'))

    await expect(myPracticesChanged(useQueryCache())).resolves.toBeUndefined()
  })

  it('the end of a session forgets the lists', async () => {
    vi.mocked(mastersApi.getMyPractices).mockResolvedValue(page([fakePractice('x')]))
    mountLists([['upcoming']])
    await flush()
    unmountLists()

    useQueryScopeStore().$reset()

    expect(cachedMyPractice(useQueryCache(), 'x')).toBeUndefined()
  })
})
