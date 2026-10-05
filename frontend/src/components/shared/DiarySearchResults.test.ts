// =============================================================================
// VELO Frontend -- DiarySearchResults tests (live search, 2026-09-09)
// =============================================================================
//
// Observable contract of the compact jump list:
//   - one row per item, with the shared card model's derived title;
//   - the count line is honest about the missing `total` (N / N+);
//   - the needle is emphasised in real DOM nodes (mark.dsr-row__hit),
//     never v-html;
//   - a row tap emits `jump` with the tapped item.
//
// The row's model derivation itself (kind -> title/icon) is useDiaryCardModel's
// own tested territory; here it is exercised through the real row component.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import DiarySearchResults from '@/components/shared/DiarySearchResults.vue'
import type { DiaryFeedItem } from '@/api/types'

function feedItem(id: string, occurredAt: string, preview: string): DiaryFeedItem {
  return {
    id,
    kind: 'note',
    occurred_at: occurredAt,
    source_type: 'diary_entry',
    source_id: `src_${id}`,
    snapshot: { content_preview: preview },
    created_at: occurredAt,
  }
}

const ITEMS: DiaryFeedItem[] = [
  feedItem('r2', '2026-07-12T09:00:00Z', 'Сон про море'),
  feedItem('r1', '2026-07-10T12:00:00Z', 'Длинный сон о полёте'),
]

let app: App | null = null
let host: HTMLElement | null = null
const jumps: DiaryFeedItem[] = []

function mount(props: Record<string, unknown>): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(DiarySearchResults, {
    ...props,
    onJump: (item: DiaryFeedItem) => jumps.push(item),
  })
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick()
}

function rows(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.dsr-row') ?? [])
}

function countText(): string {
  return host?.querySelector('.dsr__count')?.textContent?.trim() ?? ''
}

beforeEach(() => {
  jumps.length = 0
  vi.setSystemTime(new Date('2026-07-16T12:00:00Z'))
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.useRealTimers()
})

describe('DiarySearchResults', () => {
  it('renders one row per item with the matched previews and the plain count', async () => {
    mount({ items: ITEMS, query: 'сон', hasMore: false })
    await flush()

    expect(rows()).toHaveLength(2)
    expect(countText()).toBe('Найдено: 2')
    expect(rows()[0]!.textContent).toContain('Сон про море')
    expect(rows()[1]!.textContent).toContain('Длинный сон о полёте')
  })

  it('the count ceiling is marked while more pages remain (no total in the API)', async () => {
    mount({ items: ITEMS, query: '', hasMore: true })
    await flush()
    expect(countText()).toBe('Найдено: 2+')
  })

  it('emphasises the needle as real mark nodes, case-insensitively', async () => {
    mount({ items: ITEMS, query: 'СОН', hasMore: false })
    await flush()

    const marks = Array.from(host?.querySelectorAll('mark.dsr-row__hit') ?? [])
    expect(marks.map((m) => m.textContent)).toEqual(['Сон', 'сон'])
  })

  it('no query -> no marks, plain rows', async () => {
    mount({ items: ITEMS, query: '', hasMore: false })
    await flush()
    expect(host?.querySelectorAll('mark.dsr-row__hit')).toHaveLength(0)
  })

  it('a row tap emits `jump` with the tapped item', async () => {
    mount({ items: ITEMS, query: 'сон', hasMore: false })
    await flush()

    rows()[1]!.click()
    await flush()
    expect(jumps).toHaveLength(1)
    expect(jumps[0]!.id).toBe('r1')
  })
})
