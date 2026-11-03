// =============================================================================
// VELO Frontend -- diary compose target (T5 filter-aware input routing)
// =============================================================================
//
// Decides where a new diary entry goes (and whether writing is allowed at all)
// from the active feed-filter categories. Pure + unit-tested
// (diaryComposeTarget.test.ts) so the rules stay locked.
//
// Rules (operator-confirmed 2026-06-02):
//   - Writing is allowed ONLY for the diary feed (entries,
//     i18n:diary.categories.entries) and the dream feed (dreams,
//     i18n:diary.categories.dreams).
//   - The read-only categories (practices / checkins / feedbacks) block input
//     entirely -> the composer is hidden and the keyboard never opens.
//   - Truth table:
//       []                         -> 'note'   (all, i18n:common.all /
//                                               root = diary feed)
//       [entries]                  -> 'note'
//       [dreams]                   -> 'dream'  (dream feed only)
//       [entries, dreams]          -> 'note'   (defaults to the diary feed)
//       any with a blocked category-> null     (including mixed, e.g.
//                                               [entries, feedbacks])
// =============================================================================

import type { DiaryFeedCategory } from '@/api/types'

export type DiaryWriteTarget = 'note' | 'dream' | null

/** Categories you cannot author from the diary composer (read-only feeds). */
export const DIARY_WRITE_BLOCKED: DiaryFeedCategory[] = ['practices', 'checkins', 'feedbacks']

/**
 * Resolve the diary entry_type for the active filter.
 *
 * @returns Null when writing is blocked (a read-only category is selected)
 *  -- null hides the composer.
 */
export function diaryWriteTarget(categories: DiaryFeedCategory[]): DiaryWriteTarget {
  if (categories.some((c) => DIARY_WRITE_BLOCKED.includes(c))) return null
  if (categories.length === 1 && categories[0] === 'dreams') return 'dream'
  return 'note'
}
