// =============================================================================
// VELO Frontend -- Notifications Store (FE-11/FE-12)
// =============================================================================
//
// One number: the user-zone bell's unread presence. The bell lives in the
// user dashboard's floating header, while the inbox -- a different
// screen -- confirms badges after its own actions, so the state must live
// above any single view, here. Writers:
//   - UserDashboardView on mount + its foreground-only 60s poll while the
//     screen is visible (refreshUnread -- the comms `unread` rides the bell
//     feed response; no separate unread endpoint exists, T-26 recon №703)
//   - UserInboxView after load / mark-read / mark-all (applyUnread with the
//     server-confirmed badge from those responses)
// A failed refresh keeps the previous value silently: the dot is a courtesy,
// never a reason to break a screen (same disposition as the master dashboard
// bell). The MASTER inbox/bell does not use this store either: the master
// dashboard fetches its own badge on mount and remounts (refetches) on
// return from the master inbox, so it needs no shared state.

import { defineStore } from 'pinia'
import { ref } from 'vue'
import { listNotifications } from '@/api/notifications'

/** The user-zone bell's unread presence, shared by the dashboard poll and the inbox actions. */
export const useNotificationsStore = defineStore('notifications', () => {
  /** Unread bell items; 0 = no dot (presence only -- no number by ruling). */
  const unread = ref(0)

  // Bumped by $reset: a badge that lands after it is the previous account's.
  let generation = 0

  /** Refetch the badge riding the feed response. Silent on failure: keeps
   *  the last known value, never throws into a host screen. */
  async function refreshUnread(): Promise<void> {
    const gen = generation
    try {
      const { unread: next } = await listNotifications()
      if (gen === generation) unread.value = next
    } catch {
      // silent by design
    }
  }

  /** Apply a server-confirmed badge (list / mark-read / mark-all responses). */
  function applyUnread(value: number): void {
    unread.value = value
  }

  /** Back to the initial state at the account boundary (platform/session.ts). */
  function $reset(): void {
    generation += 1
    unread.value = 0
  }

  return { unread, refreshUnread, applyUnread, $reset }
})
