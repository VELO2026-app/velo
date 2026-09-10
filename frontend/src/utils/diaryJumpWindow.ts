// =============================================================================
// VELO Frontend -- diaryJumpWindow (diary search jump, 2026-09-09)
// =============================================================================
//
// Pure merge for the Telegram-style "scroll to the found entry": the store
// loads TWO windows around the target event X (occurred_at = T) -- `older` =
// date_to=T (X + older events, DESC) and `newer` = date_from=T (newer + X,
// DESC) -- and this merges them into ONE newest-first page, the exact order
// the feed API itself returns (DiaryTimeline reverses it for chat rendering).
//
// Dedupe is by id: both date bounds are inclusive, so X itself is inside BOTH
// windows. Ordering is a stable sort on occurred_at DESC -- each window
// already arrives in the backend's total (occurred_at, id) order and
// Array#sort is stable, so the sort only fixes the one seam concatenation can
// get wrong: a same-instant event split across the two windows (SW12: series
// cancellations deliberately share occurred_at). Cross-window ties keep the
// newer window's member first; day grouping and rendering are unaffected.

import type { DiaryFeedItem } from '@/api/types'

export function mergeJumpWindow(older: DiaryFeedItem[], newer: DiaryFeedItem[]): DiaryFeedItem[] {
  const seen = new Set<string>()
  const merged: DiaryFeedItem[] = []
  for (const item of [...newer, ...older]) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    merged.push(item)
  }
  return merged.sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))
}
