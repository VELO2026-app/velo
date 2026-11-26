// useAllPages: a new read drops the one before it, a dropped read neither
// fills the list nor fails it, and leaving the screen drops the read in
// flight (FE-260). The page reader here answers like the API client: a
// request whose signal aborts rejects.
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { useAllPages, type AllPagesState, type PageReader } from '@/composables/useAllPages'

type Row = { id: string }

/** A request held open until the test answers it; its signal rejects it, as fetch does. */
interface Held {
  offset: number
  signal: AbortSignal
  answer: (rows: Row[], total?: number) => void
  fail: (error: Error) => void
}

let held: Held[] = []
const reader: PageReader<Row> = (_limit, offset, signal) =>
  new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    held.push({
      offset,
      signal,
      answer: (rows, total = rows.length) => resolve({ items: rows, total }),
      fail: reject,
    })
  })

let app: App | null = null

function mount(read: PageReader<Row> = reader): AllPagesState<Row> {
  let state: AllPagesState<Row> | undefined
  const Host = defineComponent({
    setup() {
      state = useAllPages(read)
      return () => h('div')
    },
  })
  app = createApp(Host)
  app.mount(document.createElement('div'))
  if (!state) throw new Error('not mounted')
  return state
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  app?.unmount()
  app = null
  held = []
})

describe('useAllPages', () => {
  it('a second read drops the first: the list is the second answer, the first one is ignored', async () => {
    const list = mount()
    const first = list.load()
    const second = list.load()
    const [one, two] = held

    expect(one?.signal.aborted).toBe(true)
    expect(two?.signal.aborted).toBe(false)

    two?.answer([{ id: 'b' }])
    await second
    expect(list.items.value).toEqual([{ id: 'b' }])
    expect(list.loading.value).toBe(false)

    // The first request answers late: nothing changes, nothing fails.
    one?.answer([{ id: 'a' }])
    await first
    await settle()
    expect(list.items.value).toEqual([{ id: 'b' }])
    expect(list.failed.value).toBe(false)
    expect(list.loading.value).toBe(false)
  })

  it('an answer that lands after its read was dropped is not shown', async () => {
    // A reader that does not hear the signal: its answer still arrives.
    const late: Array<(rows: Row[]) => void> = []
    const deaf: PageReader<Row> = () =>
      new Promise((resolve) => late.push((rows) => resolve({ items: rows, total: rows.length })))
    const list = mount(deaf)
    const first = list.load()
    const second = list.load()

    late[1]?.([{ id: 'b' }])
    await second
    late[0]?.([{ id: 'a' }])
    await first

    expect(list.items.value).toEqual([{ id: 'b' }])
    expect(list.loading.value).toBe(false)
  })

  it('only the latest read takes the loader down', async () => {
    const list = mount()
    const first = list.load()
    void list.load()

    await first // rejected by its own abort, caught inside
    expect(list.loading.value).toBe(true)
    expect(list.failed.value).toBe(false)

    held[1]?.answer([])
    await settle()
    expect(list.loading.value).toBe(false)
  })

  it('a failed read is told and keeps what was shown', async () => {
    const list = mount()
    const ok = list.load()
    held[0]?.answer([{ id: 'a' }])
    await ok

    const again = list.load()
    held[1]?.fail(new Error('down'))
    await again

    expect(list.failed.value).toBe(true)
    expect(list.items.value).toEqual([{ id: 'a' }])
    expect(list.loading.value).toBe(false)
  })

  it('reads on to the total and says whether all came', async () => {
    const list = mount()
    const read = list.load()
    held[0]?.answer(
      Array.from({ length: 100 }, (_, i) => ({ id: `r${i}` })),
      120,
    )
    await settle()
    expect(held[1]?.offset).toBe(100)
    held[1]?.answer(
      Array.from({ length: 20 }, (_, i) => ({ id: `r${100 + i}` })),
      120,
    )
    await read

    expect(list.items.value).toHaveLength(120)
    expect(list).toMatchObject({ total: { value: 120 }, complete: { value: true } })
  })

  it('leaving the screen drops the read in flight', async () => {
    const list = mount()
    void list.load()

    app?.unmount()
    app = null

    expect(held[0]?.signal.aborted).toBe(true)
    await settle()
    expect(list.failed.value).toBe(false)
  })
})
