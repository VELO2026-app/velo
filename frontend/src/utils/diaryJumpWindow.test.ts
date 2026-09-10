// =============================================================================
// VELO Frontend -- diaryJumpWindow tests (diary search jump, 2026-09-09)
// =============================================================================
//
// Pure merge: the jump window's ordering contract. The timeline renders a
// REVERSED copy (chat-mode), so the output must be newest-first exactly like
// a feed page, with the target event present exactly once (it is inside BOTH
// windows -- both date bounds are inclusive server-side).

import { describe, it, expect } from 'vitest'
import { mergeJumpWindow } from '@/utils/diaryJumpWindow'
import type { DiaryFeedItem } from '@/api/types'

function item(id: string, occurredAt: string): DiaryFeedItem {
  return {
    id,
    kind: 'note',
    occurred_at: occurredAt,
    source_type: 'diary_entry',
    source_id: `src_${id}`,
    snapshot: {},
    created_at: occurredAt,
  }
}

describe('mergeJumpWindow', () => {
  const T = '2026-07-10T12:00:00Z'
  // Exactly what the API returns: each window DESC, target inside both.
  const older = [
    item('x', T), // the target itself
    item('o1', '2026-07-10T08:00:00Z'),
    item('o2', '2026-07-09T20:00:00Z'),
  ]
  const newer = [
    item('n2', '2026-07-12T09:00:00Z'),
    item('n1', '2026-07-11T15:00:00Z'),
    item('x', T), // the same target, again
  ]

  it('dedupes the target and merges newest-first', () => {
    const merged = mergeJumpWindow(older, newer)
    expect(merged.map((i) => i.id)).toEqual(['n2', 'n1', 'x', 'o1', 'o2'])
  })

  it('keeps the target present exactly once even with same-instant siblings split across windows', () => {
    // SW12 shape: two events share occurred_at; one landed in each window.
    const tie = '2026-07-10T12:00:00Z'
    const merged = mergeJumpWindow(
      [item('x', tie), item('o_tie', tie)],
      [item('n_tie', tie), item('x', tie)],
    )
    const ids = merged.map((i) => i.id)
    expect(ids.filter((id) => id === 'x')).toHaveLength(1)
    // Deterministic: newer-window members first among the ties (stable sort).
    expect(ids).toEqual(['n_tie', 'x', 'o_tie'])
  })

  it('degrades to the single target when the diary has no neighbours', () => {
    expect(mergeJumpWindow([item('x', T)], [item('x', T)]).map((i) => i.id)).toEqual(['x'])
  })
})
