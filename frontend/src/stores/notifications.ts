// =============================================================================
// VELO Frontend -- Notifications Store (FE-11/FE-12)
// =============================================================================
//
// One number: the user-zone bell's unread presence. The bell lives in the
// tab dock (UserShell's 5th button), which persists across screens -- so the
// state must live above any single view, here. Writers:
//   - UserShell on mount (refreshUnread -- the comms `unread` rides the bell
//     feed response; no separate unread endpoint exists, T-26 recon №703)
//   - UserInboxView after load / mark-read / mark-all (applyUnread with the
//     server-confirmed badge from those responses)
// A failed refresh keeps the previous value silently: the dot is a courtesy,
// never a reason to break a screen (same disposition as the master dashboard
// bell). The MASTER inbox/bell deliberately does not use this store -- its
// own fetch lives in MasterDashboardView (T-26 boundary).

import { defineStore } from 'pinia'
import { ref } from 'vue'
import { listNotifications } from '@/api/notifications'

export const useNotificationsStore = defineStore('notifications', () => {
  /** Unread bell items; 0 = no dot (presence only -- no number by ruling). */
  const unread = ref(0)

  /** Refetch the badge riding the feed response. Silent on failure: keeps
   *  the last known value, never throws into a host screen. */
  async function refreshUnread(): Promise<void> {
    try {
      unread.value = (await listNotifications()).unread
    } catch {
      // silent by design
    }
  }

  /** Apply a server-confirmed badge (list / mark-read / mark-all responses). */
  function applyUnread(value: number): void {
    unread.value = value
  }

  return { unread, refreshUnread, applyUnread }
})
