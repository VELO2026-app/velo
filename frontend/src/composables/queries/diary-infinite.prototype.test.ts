// =============================================================================
// VELO Frontend -- prototype: the diary feed on useInfiniteQuery (FE-157 4F)
// =============================================================================
//
// Not a test of app code: it pins the Colada behavior the ADR's diary
// decision rests on, so an upgrade that changes it fails here first.
//
// The diary (stores/diary.ts, useCursorPagination) is a chat-like timeline:
// GET /diary/feed answers newest first, `next_cursor` walks into the past,
// and the screen draws the oldest entry on top and loads more when the user
// scrolls UP. In useInfiniteQuery terms "up" is simply the NEXT page (older),
// rendered reversed -- getPreviousPageParam is not needed, because the API
// has no cursor towards newer entries. What the prototype shows:
//   1. loadNextPage() adds the older page, and the reversed list grows at
//      the top (the scroll anchoring stays useChatScroll's job);
//   2. hasNextPage ends with next_cursor null;
//   3. a refetch (invalidation, focus) reloads EVERY loaded page, one after
//      another -- the cost the migration must avoid;
//   4. maxPages is NOT the cap for the diary: loading older pages drops the
//      NEWEST ones -- today's end of the timeline -- and the API has no
//      cursor back towards it. The diary needs `refetchOnWindowFocus: false`
//      and setQueryData into the first page for its own mutations, not an
//      invalidation of the whole feed.
// =============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createPinia } from 'pinia'
import { PiniaColada, useInfiniteQuery, type UseInfiniteQueryReturn } from '@pinia/colada'
import { coladaOptions } from '@/composables/queries/setup'

interface Page {
  items: Array<{ id: string }>
  next_cursor: string | null
}

/** Twelve events, e12 the newest; pages of four, newest first, like the API. */
const EVENTS = Array.from({ length: 12 }, (_, i) => ({ id: `e${12 - i}` }))
const listDiaryFeed = vi.fn(async ({ cursor }: { cursor: string | null }): Promise<Page> => {
  const from = cursor === null ? 0 : Number(cursor)
  const items = EVENTS.slice(from, from + 4)
  return { items, next_cursor: from + 4 < EVENTS.length ? String(from + 4) : null }
})

let app: App | null = null

function mountFeed(maxPages?: number): {
  feed: UseInfiniteQueryReturn<Page, Error, string | null>
  timeline: () => string[]
} {
  let feed!: UseInfiniteQueryReturn<Page, Error, string | null>
  let timeline!: () => string[]
  const Screen = defineComponent({
    setup() {
      feed = useInfiniteQuery({
        key: ['diary', 'feed', {}],
        query: ({ pageParam }) => listDiaryFeed({ cursor: pageParam }),
        initialPageParam: null as string | null,
        getNextPageParam: (last) => last.next_cursor,
        maxPages,
      })
      // Oldest on top, today at the bottom -- the DiaryTimeline order.
      const ordered = computed(() =>
        (feed.data.value?.pages ?? []).flatMap((p) => p.items).reverse(),
      )
      timeline = () => ordered.value.map((e) => e.id)
      return () => h('div')
    },
  })
  app = createApp(Screen).use(createPinia()).use(PiniaColada, coladaOptions)
  app.mount(document.createElement('div'))
  return { feed, timeline }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  app?.unmount()
  app = null
  listDiaryFeed.mockClear()
})

describe('prototype: the diary feed on useInfiniteQuery', () => {
  it('scrolling up is loadNextPage(): the older page lands on top', async () => {
    const { feed, timeline } = mountFeed()
    await flush()
    expect(timeline()).toEqual(['e9', 'e10', 'e11', 'e12'])

    await feed.loadNextPage()
    await flush()

    expect(timeline()).toEqual(['e5', 'e6', 'e7', 'e8', 'e9', 'e10', 'e11', 'e12'])
    expect(feed.hasNextPage.value).toBe(true)
  })

  it('the past ends where next_cursor is null', async () => {
    const { feed, timeline } = mountFeed()
    await flush()
    await feed.loadNextPage()
    await feed.loadNextPage()
    await flush()

    expect(timeline()[0]).toBe('e1')
    expect(feed.hasNextPage.value).toBe(false)
  })

  it('a refetch reloads every loaded page in turn (the cost to cap)', async () => {
    const { feed } = mountFeed()
    await flush()
    await feed.loadNextPage()
    await feed.loadNextPage()
    listDiaryFeed.mockClear()

    await feed.refetch()

    expect(listDiaryFeed.mock.calls.map(([params]) => params.cursor)).toEqual([null, '4', '8'])
  })

  it('maxPages drops the newest pages, so it cannot cap the diary', async () => {
    const { feed, timeline } = mountFeed(2)
    await flush()
    await feed.loadNextPage()
    await feed.loadNextPage()
    await flush()

    // Today's page fell out of the bottom of the timeline.
    expect(timeline()).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8'])
    expect(feed.hasPreviousPage.value).toBe(false)
  })
})
