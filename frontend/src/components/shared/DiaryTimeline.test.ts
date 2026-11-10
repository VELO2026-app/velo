// =============================================================================
// VELO Frontend -- DiaryTimeline unit tests (FE-157 s1: per-row work)
// =============================================================================

import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import DiaryTimeline from '@/components/shared/DiaryTimeline.vue'
import type { DiaryFeedItem } from '@/api/types'

const stubs = { DiaryThreadCard: { template: '<div class="card-stub" />' } }

function item(id: string, occurredAt: string): DiaryFeedItem {
  return { id, occurred_at: occurredAt } as unknown as DiaryFeedItem
}
// Newest-first, as the feed arrives: two on 2026-03-02, one on 2026-03-01.
const items = [
  item('c', '2026-03-02T12:00:00Z'),
  item('b', '2026-03-02T09:00:00Z'),
  item('a', '2026-03-01T09:00:00Z'),
]

const ids = (w: { findAll: (s: string) => { attributes: (n: string) => string | undefined }[] }) =>
  w.findAll('[data-entry-id]').map((e) => e.attributes('data-entry-id'))

describe('DiaryTimeline', () => {
  it('groups chronologically into one wrapper per day', () => {
    const w = mount(DiaryTimeline, { props: { items, timezone: 'UTC' }, global: { stubs } })
    const days = w.findAll('.timeline__day')
    expect(days).toHaveLength(2)
    expect(ids(days[0]!)).toEqual(['a'])
    expect(ids(days[1]!)).toEqual(['b', 'c'])
  })

  it('resolves pendingState once per row and renders it', () => {
    const pendingState = vi.fn((i: DiaryFeedItem) =>
      i.id === 'c' ? ('failed' as const) : undefined,
    )
    const w = mount(DiaryTimeline, {
      props: { items, timezone: 'UTC', pendingState },
      global: { stubs },
    })
    expect(pendingState).toHaveBeenCalledTimes(items.length)
    const failed = w.find('[data-entry-id="c"]')
    expect(failed.attributes('data-state')).toBe('failed')
    expect(failed.classes()).toContain('timeline__row--failed')
    expect(failed.find('.timeline__not-sent').exists()).toBe(true)
    expect(w.find('[data-entry-id="a"]').find('.timeline__not-sent').exists()).toBe(false)
  })
})
