// =============================================================================
// VELO Frontend -- the diary on Colada (FE-166 step 8, FE-182)
// =============================================================================
//
// The feed, the search jump window, an entry and a practice's insights used to
// live in stores/diary.ts (useCursorPagination, refs, a reactive Map); now
// Colada entries (composables/queries/diary.ts). Real Pinia and Colada, mocked
// API seam.
//
// What is under test, and why:
//   1. A change made in this app reloads the FIRST page only and makes it the
//      whole feed -- never a Colada refetch, which would reload every page the
//      reader scrolled through, one after another (the ADR's diary limit).
//   2. That write bypasses Colada's page bookkeeping, so "more?" is read off the
//      data: a feed that had reached its end must page again after the swap.
//   3. The write is the last word: an older page in flight, an older reload,
//      a session that ended meanwhile -- none of them may land over it.
//   4. Which feeds a change touches: the one on screen and the held unfiltered
//      one are reloaded; other filtered feeds are dropped.
//   5. A filter change keeps the previous answer on screen until the new one
//      lands, and a failed new answer shows no stale results.
//   6. Once per session: the feed is not asked again on a revisit, the
//      prefetch fills what the screen reads, insights load once.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive, type App } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { PiniaColada, useQueryCache } from '@pinia/colada'
import { coladaOptions, useQueryScopeStore } from '@/composables/queries/setup'
import {
  diaryFeedChanged,
  prefetchDiaryFeed,
  useDiaryFeed,
  useDiaryJump,
  usePracticeInsights,
  type DiaryFeedData,
  type DiaryJumpTarget,
} from '@/composables/queries/diary'
import { keys } from '@/composables/queries/keys'
import * as diaryApi from '@/api/diary'
import type {
  DiaryFeedFilters,
  DiaryFeedItem,
  DiaryFeedResponse,
  PracticeInsightsResponse,
} from '@/api/types'

vi.mock('@/api/diary')

function item(id: string, occurred_at = '2026-07-16T10:00:00Z'): DiaryFeedItem {
  return {
    id,
    kind: 'note',
    occurred_at,
    source_type: 'diary_entry',
    source_id: `src_${id}`,
    snapshot: {},
    created_at: occurred_at,
  }
}

function page(ids: string[], next_cursor: string | null = null): DiaryFeedResponse {
  return { items: ids.map((id) => item(id)), next_cursor }
}

/** A request that answers when the test says so. */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let pinia: Pinia
let app: App | null = null
let feed: ReturnType<typeof useDiaryFeed>
let jump: ReturnType<typeof useDiaryJump>
const filters = reactive<DiaryFeedFilters>({})
const jumpTarget = reactive<{ value: DiaryJumpTarget | null }>({ value: null })

/** The diary screen's readers: the feed under `filters`, the jump around `jumpTarget`. */
function mountScreen(): void {
  const Screen = defineComponent({
    setup() {
      feed = useDiaryFeed(() => filters)
      jump = useDiaryJump(() => jumpTarget.value)
      return () => h('div')
    },
  })
  app = createApp(Screen).use(pinia).use(PiniaColada, coladaOptions)
  app.mount(document.createElement('div'))
}

function unmountScreen(): void {
  app?.unmount()
  app = null
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Ids on screen, newest first. */
function ids(): string[] {
  return feed.items.value.map((i) => i.id)
}

/** The feed entry's data under the given filters. */
function feedData(f: DiaryFeedFilters = {}): DiaryFeedData | undefined {
  return useQueryCache().getQueryData<DiaryFeedData>(keys.diary.feed(f))
}

/** A feed of two pages, the second one the end: n3 n2 | n1. */
async function mountTwoPageFeed(): Promise<void> {
  vi.mocked(diaryApi.listDiaryFeed).mockImplementation(async (params) =>
    params?.cursor === 'c1' ? page(['n1']) : page(['n3', 'n2'], 'c1'),
  )
  mountScreen()
  await flush()
  await feed.loadMore()
  await flush()
  expect(ids()).toEqual(['n3', 'n2', 'n1'])
  expect(feed.hasMore.value).toBe(false)
  vi.mocked(diaryApi.listDiaryFeed).mockClear()
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  for (const k of Object.keys(filters)) delete (filters as Record<string, unknown>)[k]
  jumpTarget.value = null
  vi.mocked(diaryApi.listDiaryFeed).mockReset().mockResolvedValue(page([]))
  vi.mocked(diaryApi.getPracticeInsights).mockReset()
})

afterEach(() => {
  unmountScreen()
})

describe('diaryFeedChanged: the first page becomes the whole feed', () => {
  it('asks for the first page only, not every page the reader loaded', async () => {
    await mountTwoPageFeed()
    vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(page(['n4', 'n3'], 'c2'))

    await diaryFeedChanged(useQueryCache())
    await flush()

    expect(vi.mocked(diaryApi.listDiaryFeed).mock.calls).toEqual([[{ limit: 40 }]])
    expect(ids()).toEqual(['n4', 'n3'])
    expect(feedData()?.pages).toHaveLength(1)
  })

  it('a feed that had reached its end pages again after the swap', async () => {
    await mountTwoPageFeed()
    vi.mocked(diaryApi.listDiaryFeed).mockImplementation(async (params) =>
      params?.cursor === 'c2' ? page(['n2', 'n1']) : page(['n4', 'n3'], 'c2'),
    )

    await diaryFeedChanged(useQueryCache())
    await flush()

    expect(feed.hasMore.value).toBe(true)
    await feed.loadMore()
    await flush()
    expect(ids()).toEqual(['n4', 'n3', 'n2', 'n1'])
    expect(vi.mocked(diaryApi.listDiaryFeed).mock.calls.at(-1)?.[0]).toMatchObject({
      cursor: 'c2',
    })
  })

  it('a failed reload keeps the feed on screen, with no error', async () => {
    await mountTwoPageFeed()
    vi.mocked(diaryApi.listDiaryFeed).mockRejectedValue(new Error('offline'))

    await diaryFeedChanged(useQueryCache())
    await flush()

    expect(ids()).toEqual(['n3', 'n2', 'n1'])
    expect(feed.error.value).toBeNull()
  })

  it('an older page still in flight does not land over the reloaded feed', async () => {
    await mountTwoPageFeed()
    // The first page reloaded meanwhile is the end of a short feed; the older
    // page was asked from the previous pages and must not be glued to it.
    const older = deferred<DiaryFeedResponse>()
    vi.mocked(diaryApi.listDiaryFeed).mockImplementation((params) =>
      params?.cursor ? older.promise : Promise.resolve(page(['n9'])),
    )
    useQueryCache().setQueryData<DiaryFeedData>(keys.diary.feed({}), {
      pages: [page(['n3', 'n2'], 'c1')],
      pageParams: [null],
    })
    const loading = feed.loadMore().catch(() => {})
    await flush()

    await diaryFeedChanged(useQueryCache())
    older.resolve(page(['n1']))
    await loading
    await flush()

    expect(ids()).toEqual(['n9'])
  })

  it('of two reloads in flight, the later one is the last word', async () => {
    await mountTwoPageFeed()
    const first = deferred<DiaryFeedResponse>()
    vi.mocked(diaryApi.listDiaryFeed)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(page(['new']))

    const a = diaryFeedChanged(useQueryCache())
    const b = diaryFeedChanged(useQueryCache())
    await b
    first.resolve(page(['old']))
    await a
    await flush()

    expect(ids()).toEqual(['new'])
  })

  it('a reload answering after the session ended writes nothing', async () => {
    await mountTwoPageFeed()
    const answer = deferred<DiaryFeedResponse>()
    vi.mocked(diaryApi.listDiaryFeed).mockReturnValueOnce(answer.promise)

    const reload = diaryFeedChanged(useQueryCache())
    useQueryScopeStore().$reset()
    answer.resolve(page(['previous_account']))
    await reload
    await flush()

    expect(ids()).not.toContain('previous_account')
  })

  it('a feed dropped while its reload was in flight is not written back', async () => {
    await mountTwoPageFeed()
    unmountScreen()
    const answer = deferred<DiaryFeedResponse>()
    vi.mocked(diaryApi.listDiaryFeed).mockReturnValueOnce(answer.promise)
    const cache = useQueryCache()

    const reload = diaryFeedChanged(cache)
    cache.remove(cache.get(keys.diary.feed({}))!)
    answer.resolve(page(['orphan']))
    await reload

    expect(cache.get(keys.diary.feed({}))).toBeUndefined()
  })

  it('reloads the feed on screen and the held unfiltered one; drops other filtered feeds', async () => {
    const cache = useQueryCache()
    // Off screen: the unfiltered feed and a search the reader left.
    await mountTwoPageFeed()
    filters.search = 'сон'
    await flush()
    filters.search = undefined
    filters.categories = ['dreams']
    await flush()
    // On screen now: the dreams filter.
    vi.mocked(diaryApi.listDiaryFeed)
      .mockClear()
      .mockResolvedValue(page(['fresh']))

    await diaryFeedChanged(cache)
    await flush()

    const asked = vi.mocked(diaryApi.listDiaryFeed).mock.calls.map(([p]) => p)
    expect(asked).toEqual(
      expect.arrayContaining([{ limit: 40 }, { categories: ['dreams'], limit: 40 }]),
    )
    expect(asked).toHaveLength(2)
    expect(cache.get(keys.diary.feed({ search: 'сон' }))).toBeUndefined()
    expect(feedData()?.pages).toEqual([page(['fresh'])])
  })
})

describe('the feed off screen', () => {
  it('reloads the feed under the filters the diary reads with, though no screen holds it', async () => {
    // The diary under a filter, then an entry opened over it (the feed unmounts).
    filters.categories = ['dreams']
    vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(page(['n1']))
    mountScreen()
    await flush()
    unmountScreen()
    vi.mocked(diaryApi.listDiaryFeed)
      .mockClear()
      .mockResolvedValue(page(['edited']))

    await diaryFeedChanged(useQueryCache(), { categories: ['dreams'] })

    expect(feedData({ categories: ['dreams'] })?.pages).toEqual([page(['edited'])])
    expect(diaryApi.listDiaryFeed).toHaveBeenCalledWith({ categories: ['dreams'], limit: 40 })
  })
})

describe('the feed on screen', () => {
  it('an older page cancelled by a reload and then failing tells nothing', async () => {
    vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(page(['n2'], 'c1'))
    mountScreen()
    await flush()
    const older = deferred<DiaryFeedResponse>()
    vi.mocked(diaryApi.listDiaryFeed).mockImplementation((params) =>
      params?.cursor ? older.promise : Promise.resolve(page(['n3'])),
    )
    const loading = feed.loadMore()
    await flush()

    await diaryFeedChanged(useQueryCache())
    older.reject(new Error('offline'))

    // The pages it was asked from are gone: nothing on screen failed.
    await expect(loading).resolves.toBeUndefined()
    expect(ids()).toEqual(['n3'])
  })

  it('a failed older page does not make the next visit reload every page', async () => {
    vi.mocked(diaryApi.listDiaryFeed).mockImplementation(async (params) =>
      params?.cursor === 'c1' ? page(['n1'], 'c2') : page(['n3', 'n2'], 'c1'),
    )
    mountScreen()
    await flush()
    await feed.loadMore()
    vi.mocked(diaryApi.listDiaryFeed).mockRejectedValue(new Error('offline'))
    await expect(feed.loadMore()).rejects.toThrow('offline')
    await flush()
    expect(ids()).toEqual(['n3', 'n2', 'n1'])
    unmountScreen()
    vi.mocked(diaryApi.listDiaryFeed).mockClear()

    mountScreen()
    await flush()

    expect(diaryApi.listDiaryFeed).not.toHaveBeenCalled()
    expect(ids()).toEqual(['n3', 'n2', 'n1'])
  })

  it('a filter change keeps the previous answer until the new one lands', async () => {
    vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(page(['n2', 'n1']))
    mountScreen()
    await flush()
    const search = deferred<DiaryFeedResponse>()
    vi.mocked(diaryApi.listDiaryFeed).mockReturnValueOnce(search.promise)

    filters.search = 'сон'
    await flush()

    // No "nothing found" or loader under the keystroke: the old answer stays.
    expect(ids()).toEqual(['n2', 'n1'])
    expect(feed.loaded.value).toBe(false)
    search.resolve(page(['n1']))
    await flush()
    expect(ids()).toEqual(['n1'])
    expect(feed.loaded.value).toBe(true)
  })

  it('a failed new answer shows no stale results', async () => {
    vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(page(['n2', 'n1']))
    mountScreen()
    await flush()
    vi.mocked(diaryApi.listDiaryFeed).mockRejectedValueOnce(new Error('offline'))

    filters.search = 'сон'
    await flush()

    expect(ids()).toEqual([])
    expect(feed.failed.value).toBe(true)
  })

  it('a revisit reads the held feed: nothing asked again', async () => {
    vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(page(['n1']))
    mountScreen()
    await flush()
    unmountScreen()
    vi.mocked(diaryApi.listDiaryFeed).mockClear()

    mountScreen()
    await flush()

    expect(ids()).toEqual(['n1'])
    expect(diaryApi.listDiaryFeed).not.toHaveBeenCalled()
  })
})

describe('prefetchDiaryFeed', () => {
  it('fills the feed the screen reads, which then asks nothing', async () => {
    vi.mocked(diaryApi.listDiaryFeed).mockResolvedValue(page(['n2', 'n1'], 'c1'))

    await prefetchDiaryFeed(useQueryCache(), {})
    expect(diaryApi.listDiaryFeed).toHaveBeenCalledTimes(1)
    mountScreen()
    await flush()

    expect(ids()).toEqual(['n2', 'n1'])
    expect(feed.hasMore.value).toBe(true)
    expect(diaryApi.listDiaryFeed).toHaveBeenCalledTimes(1)
  })

  it('leaves a held feed alone (the reader may have scrolled further)', async () => {
    await mountTwoPageFeed()

    await prefetchDiaryFeed(useQueryCache(), {})

    expect(diaryApi.listDiaryFeed).not.toHaveBeenCalled()
    expect(ids()).toEqual(['n3', 'n2', 'n1'])
  })

  it('a prefetch answering after the screen does not replace what it loaded', async () => {
    const prefetched = deferred<DiaryFeedResponse>()
    vi.mocked(diaryApi.listDiaryFeed).mockReturnValueOnce(prefetched.promise)
    const prefetch = prefetchDiaryFeed(useQueryCache(), {})
    await mountTwoPageFeed()

    prefetched.resolve(page(['stale']))
    await prefetch
    await flush()

    expect(ids()).toEqual(['n3', 'n2', 'n1'])
  })
})

describe('prefetchDiaryFeed and a change made meanwhile', () => {
  it('a prefetch asked before the diary moved does not write its older answer', async () => {
    const prefetched = deferred<DiaryFeedResponse>()
    vi.mocked(diaryApi.listDiaryFeed).mockReturnValueOnce(prefetched.promise)
    const prefetch = prefetchDiaryFeed(useQueryCache(), {})

    // A check-in lands while the prefetch is in flight (no feed held yet).
    await diaryFeedChanged(useQueryCache())
    prefetched.resolve(page(['before_the_checkin']))
    await prefetch

    expect(feedData()).toBeUndefined()
  })
})

describe('the search jump window', () => {
  it('opens on the merged window around the event, then walks into the past', async () => {
    const at = '2026-07-10T12:00:00Z'
    vi.mocked(diaryApi.listDiaryFeed).mockImplementation(async (params) => {
      if (params?.date_to) {
        return { items: [item('t1', at), item('o1', '2026-07-09T12:00:00Z')], next_cursor: 'older' }
      }
      if (params?.date_from) {
        return { items: [item('w1', '2026-07-11T12:00:00Z'), item('t1', at)], next_cursor: null }
      }
      if (params?.cursor === 'older') {
        return { items: [item('o2', '2026-07-08T12:00:00Z')], next_cursor: null }
      }
      return page([])
    })
    mountScreen()
    await flush()

    jumpTarget.value = { id: 't1', occurred_at: at }
    await flush()

    expect(jump.items.value.map((i) => i.id)).toEqual(['w1', 't1', 'o1'])
    expect(jump.hasMore.value).toBe(true)
    await jump.loadMore()
    await flush()
    expect(jump.items.value.map((i) => i.id)).toEqual(['w1', 't1', 'o1', 'o2'])
    expect(jump.hasMore.value).toBe(false)
  })
})

describe('the search jump window, held', () => {
  const at = '2026-07-10T12:00:00Z'
  const target = { id: 't1', occurred_at: at }

  beforeEach(() => {
    vi.mocked(diaryApi.listDiaryFeed).mockImplementation(async (params) =>
      params?.date_to || params?.date_from
        ? { items: [item('t1', at)], next_cursor: null }
        : page([]),
    )
  })

  it('a return from an entry opened inside the window reads it without asking', async () => {
    jumpTarget.value = target
    mountScreen()
    await flush()
    unmountScreen()
    vi.mocked(diaryApi.listDiaryFeed).mockClear()

    mountScreen()
    await flush()

    expect(jump.items.value.map((i) => i.id)).toEqual(['t1'])
    expect(diaryApi.listDiaryFeed).not.toHaveBeenCalledWith(
      expect.objectContaining({ date_to: at }),
    )
  })

  it('a failed older page of the window does not make a return reload it', async () => {
    vi.mocked(diaryApi.listDiaryFeed).mockImplementation(async (params) =>
      params?.date_to ? { items: [item('t1', at)], next_cursor: 'older' } : page([]),
    )
    jumpTarget.value = target
    mountScreen()
    await flush()
    vi.mocked(diaryApi.listDiaryFeed).mockRejectedValue(new Error('offline'))
    await expect(jump.loadMore()).rejects.toThrow('offline')
    unmountScreen()
    vi.mocked(diaryApi.listDiaryFeed).mockClear()

    mountScreen()
    await flush()

    expect(diaryApi.listDiaryFeed).not.toHaveBeenCalled()
    expect(jump.items.value.map((i) => i.id)).toEqual(['t1'])
  })

  it('a change in the diary makes a held window stale: the return asks again', async () => {
    jumpTarget.value = target
    mountScreen()
    await flush()
    unmountScreen()

    await diaryFeedChanged(useQueryCache())
    vi.mocked(diaryApi.listDiaryFeed).mockClear()
    mountScreen()
    await flush()

    expect(diaryApi.listDiaryFeed).toHaveBeenCalledWith(expect.objectContaining({ date_to: at }))
  })

  it('a change in the diary refetches the window on screen at once', async () => {
    jumpTarget.value = target
    mountScreen()
    await flush()
    vi.mocked(diaryApi.listDiaryFeed).mockClear()

    await diaryFeedChanged(useQueryCache())

    expect(diaryApi.listDiaryFeed).toHaveBeenCalledWith(expect.objectContaining({ date_to: at }))
  })

  it('a new tap on the same result asks anew', async () => {
    mountScreen()
    await flush()
    jumpTarget.value = target
    await flush()
    jumpTarget.value = null
    await flush()
    vi.mocked(diaryApi.listDiaryFeed).mockClear()

    jump.forget(target)
    jumpTarget.value = target
    await flush()

    expect(diaryApi.listDiaryFeed).toHaveBeenCalledWith(expect.objectContaining({ date_to: at }))
  })
})

describe('usePracticeInsights', () => {
  const INSIGHTS = { participants: 3 } as PracticeInsightsResponse

  it('loads a practice once per session', async () => {
    vi.mocked(diaryApi.getPracticeInsights).mockResolvedValue(INSIGHTS)
    const insights = usePracticeInsights(useQueryCache())

    await insights.load('p1')
    await insights.load('p1')

    expect(insights.get('p1')).toEqual(INSIGHTS)
    expect(insights.has('p1')).toBe(true)
    expect(diaryApi.getPracticeInsights).toHaveBeenCalledTimes(1)
  })

  it('a failed load is asked again by the next one', async () => {
    vi.mocked(diaryApi.getPracticeInsights)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(INSIGHTS)
    const insights = usePracticeInsights(useQueryCache())

    await insights.load('p1')
    expect(insights.has('p1')).toBe(false)
    await insights.load('p1')

    expect(insights.get('p1')).toEqual(INSIGHTS)
  })
})
