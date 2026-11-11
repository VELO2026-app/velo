// =============================================================================
// VELO Frontend -- the bookings queries and the flag mutations (FE-166 step 3)
// =============================================================================
//
// What moved out of stores/bookings.ts: the paginated list (useMyBookings),
// the dashboard's upcoming slice (upcomingBookingsQuery, persisted), and the
// join / skip-check-in actions (useJoinBooking, useSkipCheckin). Colada and
// persistedCache are real; only the HTTP layer is mocked.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, onMounted, type App } from 'vue'
import { createPinia } from 'pinia'
import { PiniaColada, useQuery, useQueryCache, type QueryCache } from '@pinia/colada'
import { coladaOptions, useQueryScopeStore } from '@/composables/queries/setup'
import { keys } from '@/composables/queries/keys'
import { persistSlot } from '@/composables/queries/persist'
import { invalidateAfter } from '@/composables/queries/invalidation'
import {
  BOOKINGS_PAGE_SIZE,
  upcomingBookingsQuery,
  useJoinBooking,
  useMyBookings,
  useSkipCheckin,
} from '@/composables/queries/bookings'
import {
  flushPersisted,
  readPersisted,
  setPersistOwner,
  writePersisted,
} from '@/composables/persistedCache'
import { ApiResponseError } from '@/api/client'
import * as bookingsApi from '@/api/bookings'
import type { BookingWithPracticeResponse } from '@/api/types'

vi.mock('@/api/bookings')

const booking = (id: string) => ({ id, practice_id: `p-${id}` }) as BookingWithPracticeResponse

/** One page of `GET /bookings/me` out of `total`, starting at `offset`. */
function page(ids: string[], total: number, offset = 0) {
  return { items: ids.map(booking), total, limit: BOOKINGS_PAGE_SIZE, offset }
}

let app: App | null = null
let list: ReturnType<typeof useMyBookings>
let queryCache: QueryCache

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Mount a screen that runs `setup` inside a Pinia with Colada, as app.ts installs it. */
function mount(setup: () => void): void {
  const Screen = defineComponent({
    setup() {
      queryCache = useQueryCache()
      setup()
      return () => h('div')
    },
  })
  app = createApp(Screen).use(createPinia()).use(PiniaColada, coladaOptions)
  app.mount(document.createElement('div'))
}

beforeEach(() => {
  vi.mocked(bookingsApi.getMyBookings).mockReset()
  vi.mocked(bookingsApi.getUpcomingBookings).mockReset().mockResolvedValue([])
  vi.mocked(bookingsApi.joinBooking)
    .mockReset()
    .mockResolvedValue({} as never)
  vi.mocked(bookingsApi.skipCheckin)
    .mockReset()
    .mockResolvedValue({} as never)
})

afterEach(() => {
  app?.unmount()
  app = null
})

describe('useMyBookings', () => {
  it('loads the first page, then appends the next one by offset until the total', async () => {
    vi.mocked(bookingsApi.getMyBookings)
      .mockResolvedValueOnce(page(['b1', 'b2'], 3))
      .mockResolvedValueOnce(page(['b3'], 3, 2))
    mount(() => {
      list = useMyBookings()
    })
    await flush()

    expect(bookingsApi.getMyBookings).toHaveBeenCalledWith(undefined, BOOKINGS_PAGE_SIZE, 0)
    expect(list.bookings.value.map((b) => b.id)).toEqual(['b1', 'b2'])
    expect(list.hasMore.value).toBe(true)

    await list.loadMore()
    await flush()

    expect(bookingsApi.getMyBookings).toHaveBeenLastCalledWith(undefined, BOOKINGS_PAGE_SIZE, 2)
    expect(list.bookings.value.map((b) => b.id)).toEqual(['b1', 'b2', 'b3'])
    expect(list.hasMore.value).toBe(false)
  })

  it('a failed first page: nothing to show, the raw error kept for the screen to word', async () => {
    const error = new ApiResponseError(500, 'boom', 'internal')
    vi.mocked(bookingsApi.getMyBookings).mockRejectedValue(error)
    mount(() => {
      list = useMyBookings()
    })
    await flush()

    expect(list.failed.value).toBe(true)
    expect(list.settled.value).toBe(true)
    expect(list.error.value).toBe(error)
  })

  it('a failed next page rejects loadMore and keeps the list on screen', async () => {
    vi.mocked(bookingsApi.getMyBookings)
      .mockResolvedValueOnce(page(['b1'], 2))
      .mockRejectedValueOnce(new Error('offline'))
    mount(() => {
      list = useMyBookings()
    })
    await flush()

    await expect(list.loadMore()).rejects.toThrow('offline')
    await flush()

    expect(list.bookings.value.map((b) => b.id)).toEqual(['b1'])
    expect(list.failed.value).toBe(false)
  })

  it('a screen that refetches on mount unless a request runs sends ONE request on a cold start', async () => {
    // PracticeDetailView / MyBookingsView (B30): `if (!fetching) refetch()` in
    // onMounted relies on the first load already running by then.
    vi.mocked(bookingsApi.getMyBookings).mockResolvedValue(page(['b1'], 1))
    mount(() => {
      list = useMyBookings()
      onMounted(() => {
        if (!list.fetching.value) void list.refetch()
      })
    })
    await flush()

    expect(bookingsApi.getMyBookings).toHaveBeenCalledTimes(1)
  })

  it('is not settled until the first page answered (a gate on it waits)', async () => {
    vi.mocked(bookingsApi.getMyBookings).mockReturnValue(new Promise(() => {}))
    mount(() => {
      list = useMyBookings()
    })
    await flush()

    expect(list.settled.value).toBe(false)
    expect(list.loading.value).toBe(true)
  })
})

describe('upcomingBookingsQuery', () => {
  beforeEach(() => {
    setPersistOwner('user_1')
  })

  it('persists its answer, and a restart paints that copy at once, then revalidates', async () => {
    vi.mocked(bookingsApi.getUpcomingBookings).mockResolvedValue([booking('b1')])
    mount(() => {
      useQuery(() => upcomingBookingsQuery())
    })
    await flush()
    flushPersisted()
    app?.unmount()

    vi.mocked(bookingsApi.getUpcomingBookings).mockReturnValue(new Promise(() => {}))
    let data!: ReturnType<typeof useQuery>['data']
    mount(() => {
      data = useQuery(() => upcomingBookingsQuery()).data
    })
    await flush()

    expect((data.value as BookingWithPracticeResponse[]).map((b) => b.id)).toEqual(['b1'])
    expect(bookingsApi.getUpcomingBookings).toHaveBeenCalledTimes(2)
  })

  it('a booking mutation drops a persisted copy this session never loaded', async () => {
    const slot = persistSlot(JSON.stringify(keys.bookings.upcoming()))
    writePersisted(slot, [booking('cancelled')])
    mount(() => {})

    await invalidateAfter(queryCache, 'cancelBooking')

    expect(readPersisted(slot)).toBeUndefined()
  })

  it('...but leaves the copies of other domains alone', async () => {
    const slot = persistSlot(JSON.stringify(keys.schools.mine('participant', 'user')))
    writePersisted(slot, { schools: [], canCreate: false })
    mount(() => {})

    await invalidateAfter(queryCache, 'cancelBooking')

    expect(readPersisted(slot)).toBeDefined()
  })
})

describe('useJoinBooking / useSkipCheckin', () => {
  let join: (bookingId: string) => Promise<unknown>
  let skip: (bookingId: string) => Promise<unknown>

  function mountFlags(): void {
    mount(() => {
      join = useJoinBooking().mutateAsync
      skip = useSkipCheckin().mutateAsync
    })
    queryCache.setQueryData(keys.bookings.upcoming(), [])
  }

  it('join: calls the API and marks the booking keys stale', async () => {
    mountFlags()

    await join('b1')

    expect(bookingsApi.joinBooking).toHaveBeenCalledWith('b1')
    expect(queryCache.get(keys.bookings.upcoming())?.when).toBe(0)
  })

  it('skip: calls the API and marks the booking keys stale', async () => {
    mountFlags()

    await skip('b1')

    expect(bookingsApi.skipCheckin).toHaveBeenCalledWith('b1')
    expect(queryCache.get(keys.bookings.upcoming())?.when).toBe(0)
  })

  it('rejects with the raw API error (409 = already joined, for the screen) and marks nothing', async () => {
    const error = new ApiResponseError(409, 'Already joined', 'already_joined')
    vi.mocked(bookingsApi.joinBooking).mockRejectedValue(error)
    mountFlags()

    await expect(join('b1')).rejects.toBe(error)

    expect(queryCache.get(keys.bookings.upcoming())?.when).not.toBe(0)
  })

  it('an answer landing after the session ended marks nothing', async () => {
    let answer!: () => void
    vi.mocked(bookingsApi.skipCheckin).mockReturnValue(
      new Promise((resolve) => {
        answer = () => resolve({} as never)
      }),
    )
    mountFlags()
    const done = skip('b1')
    await flush()

    useQueryScopeStore(app!.config.globalProperties.$pinia).$reset()
    queryCache.setQueryData(keys.bookings.upcoming(), [])
    answer()
    await done
    await flush()

    expect(queryCache.get(keys.bookings.upcoming())?.when).not.toBe(0)
  })
})
