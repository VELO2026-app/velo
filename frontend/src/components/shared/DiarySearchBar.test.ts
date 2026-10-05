// =============================================================================
// VELO Frontend -- DiarySearchBar tests (live search, 2026-09-09)
// =============================================================================
//
// The bar's three channels, in the order they matter:
//   - `live`: debounced USER input only (300ms), trimmed; the programmatic
//     `initial` sync must NOT arm it (reopening the bar with an active query
//     is not typing -- it must keep the cancel scrim up and fetch nothing);
//   - `search`: the commit (Enter / magnifier / a recent) -- immediate,
//     records the recent, and DROPS a pending live emit (no trailing
//     duplicate);
//   - the x: emits live('') as a UI-state signal and never cancels the
//     committed search (owner 2026-09-07).
//
// Fake timers own the debounce; flush() advances them.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import DiarySearchBar from '@/components/shared/DiarySearchBar.vue'

const DEBOUNCE_MS = 300

let app: App | null = null
let host: HTMLElement | null = null
const events: { live: string[]; close: number[]; cancel: number[] } = {
  live: [],
  close: [],
  cancel: [],
}

function mount(props: Record<string, unknown> = {}): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(DiarySearchBar, {
    ...props,
    onLive: (q: string) => events.live.push(q),
    onCancel: () => events.cancel.push(1),
    onClose: () => events.close.push(1),
  })
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick()
}

function typeInto(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input'))
}

async function advanceDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
  await flush()
}

function input(): HTMLInputElement {
  const el = host?.querySelector('input')
  if (!el) throw new Error('search input did not render')
  return el
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  events.live = []
  events.close = []
  events.cancel = []
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.useRealTimers()
})

describe('DiarySearchBar', () => {
  it('typing emits live once per debounce window, trimmed', async () => {
    mount()
    await flush()
    typeInto(input(), 'с')
    await vi.advanceTimersByTimeAsync(100)
    typeInto(input(), 'см')
    await vi.advanceTimersByTimeAsync(100)
    typeInto(input(), ' сон ')
    await advanceDebounce()

    expect(events.live).toEqual(['сон'])
  })

  it('the programmatic initial sync does NOT arm the live emit', async () => {
    mount({ initial: 'сон' })
    await advanceDebounce()
    expect(events.live).toEqual([])
  })

  it('Enter flushes a pending live pass immediately and records the recent', async () => {
    mount()
    await flush()
    typeInto(input(), 'сон')
    // No debounce advance: Enter must not depend on the timer -- a query
    // typed and committed inside the debounce window is fetched NOW.
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flush()
    await advanceDebounce()

    expect(events.live).toEqual(['сон']) // flushed by Enter, not dropped
    expect(JSON.parse(localStorage.getItem('velo:diary:recent-searches') ?? '[]')).toEqual(['сон'])
  })

  it('a recent tap applies the query immediately (no debounce) and re-records it first', async () => {
    localStorage.setItem('velo:diary:recent-searches', JSON.stringify(['сон', 'море']))
    mount()
    await flush()

    const rows = Array.from(host?.querySelectorAll('.diary-search__recent-item') ?? [])
    const sea = rows.find((r) => r.textContent?.includes('море')) as HTMLButtonElement | undefined
    sea?.click()
    await flush()

    expect(events.live).toEqual(['море'])
    expect(input().value).toBe('море')
    const recents: string[] = JSON.parse(localStorage.getItem('velo:diary:recent-searches') ?? '[]')
    expect(recents[0]).toBe('море')
  })

  it('Esc emits close', async () => {
    mount()
    await flush()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flush()
    expect(events.close).toHaveLength(1)
  })

  it('a pending debounce is cleared on unmount (no emit after the bar is gone)', async () => {
    mount()
    await flush()
    typeInto(input(), 'сон')
    app?.unmount()
    app = null
    await advanceDebounce()
    expect(events.live).toEqual([])
  })

  it("the small inner x empties the field and debounces live('') -- the filter drop is the parent's to apply", async () => {
    mount({ initial: 'сон' })
    await flush()
    host?.querySelector<HTMLButtonElement>('.diary-search__clear')?.click()
    await advanceDebounce()

    expect(input().value).toBe('')
    expect(events.live).toEqual([''])
    expect(events.cancel).toEqual([])
  })

  it("backspacing to empty also emits live('') -- an empty field is one state, whatever emptied it", async () => {
    mount()
    await flush()
    typeInto(input(), 'сон')
    await advanceDebounce()
    typeInto(input(), '')
    await advanceDebounce()

    expect(events.live).toEqual(['сон', ''])
  })

  it('the outer x closes the search as a whole (cancel)', async () => {
    mount({ initial: 'сон' })
    await flush()

    const close = host?.querySelector<HTMLButtonElement>('.diary-search__close')
    expect(close?.getAttribute('aria-label')).toBe('Закрыть поиск')
    close?.click()
    await flush()

    expect(events.cancel).toHaveLength(1)
    expect(events.live).toEqual([]) // closing is not a query change
  })

  it('the retired go disc is really gone -- submit is Enter / a recent', async () => {
    mount()
    await flush()
    expect(host?.querySelector('.diary-search__go')).toBeNull()
    expect(host?.querySelector('.diary-search__close')).not.toBeNull()
  })
})
