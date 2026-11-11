// =============================================================================
// VELO Frontend -- practice queries for Pinia Colada (FE-166 step 2)
// =============================================================================
//
// One practice by id (`GET /practices/{id}`). Today only the practices store
// (stores/practices.ts) reads it -- the route preload fills the entry, lists
// seed it, the store writes every answer it fetches -- so the booking
// mutations' invalidation (./invalidation.ts, `keys.practices.root()`) marks
// a known practice stale and its next open refetches it.
// =============================================================================

import { defineQueryOptions } from '@pinia/colada'
import { getPractice } from '@/api/practices'
import { keys } from '@/composables/queries/keys'

/** How long an unread practice detail stays in memory after its last write (ms). */
export const PRACTICE_GC_MS = 30 * 60_000

/** Query options for one practice (`GET /practices/{id}`). */
export const practiceDetailQuery = defineQueryOptions((practiceId: string) => ({
  key: keys.practices.detail(practiceId),
  query: () => getPractice(practiceId),
  // Nothing subscribes to these entries (the store copies the practice out),
  // so they live gcTime after their last write. 30 min instead of Colada's
  // 5: a practice opened a while ago reopens without a skeleton, as it did
  // in the in-house cache (which kept up to 120 of them).
  gcTime: PRACTICE_GC_MS,
}))
