// =============================================================================
// VELO Frontend -- the user-zone bell's unread badge on Pinia Colada (FE-166 step 6)
// =============================================================================
//
// One number: the user-zone bell's unread presence (FE-11/FE-12; it used to
// be stores/notifications.ts). The bell lives in the user dashboard's
// floating header, while the inbox -- a different screen -- confirms badges
// after its own actions, so the number lives in one cache entry above both.
// Writers:
//   - UserDashboardView on every resume and its foreground-only 60 s poll
//     while the screen is visible (the comms `unread` rides the bell feed
//     response; no separate unread endpoint exists, T-26 recon №703), and
//     the idle tab prefetch (router/dataPrefetch.ts);
//   - UserInboxView after load / mark-read / mark-all (applyUnread with the
//     server-confirmed badge from those responses).
// A failed refresh keeps the previous value silently: the dot is a courtesy,
// never a reason to break a screen. The MASTER inbox / bell does not use
// this entry: the master dashboard fetches its own badge on mount.
// =============================================================================

import { computed } from 'vue'
import { defineQueryOptions, useQuery, type QueryCache } from '@pinia/colada'
import { listNotifications } from '@/api/notifications'
import { keys } from '@/composables/queries/keys'

/**
 * A badge answered this recently is not asked for again by a resume: the
 * idle prefetch and the dashboard's mount share it. The poll and a return to
 * the foreground ask regardless.
 */
export const UNREAD_STALE_MS = 10_000

/** Query options for the user-zone bell's unread badge. */
export const unreadBadgeQuery = defineQueryOptions(() => ({
  key: keys.notifications.unread(),
  query: async (): Promise<number> => (await listNotifications()).unread,
  staleTime: UNREAD_STALE_MS,
  // The dashboard drives its own foreground refresh (its visibility handler).
  refetchOnWindowFocus: false,
}))

/**
 * Ask for the badge unless answered within UNREAD_STALE_MS, outside a
 * component (the idle prefetch). Never rejects: a failure keeps the last
 * known value.
 */
export async function refreshUnread(queryCache: QueryCache): Promise<void> {
  await queryCache.refresh(queryCache.ensure(unreadBadgeQuery())).catch(() => {})
}

/** Write a server-confirmed badge (list / mark-read / mark-all responses carry the fresh number). */
export function applyUnread(queryCache: QueryCache, value: number): void {
  queryCache.setQueryData(queryCache.ensure(unreadBadgeQuery()).key, value)
}

/** The bell's badge for a screen: the number (0 = no dot), and its two refreshes. Neither rejects. */
export function useUnreadBadge() {
  const query = useQuery(() => unreadBadgeQuery())
  return {
    /** Unread bell items; 0 = no dot (presence only -- no number by ruling). */
    unread: computed(() => query.data.value ?? 0),
    /** Ask unless answered within UNREAD_STALE_MS (a resume). */
    refresh: () => query.refresh(),
    /** Ask now (the poll tick, a return to the foreground). */
    refetch: () => query.refetch(),
  }
}
