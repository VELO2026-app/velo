// =============================================================================
// VELO Frontend -- Notifications Store Tests (FE-11/FE-12)
// =============================================================================
//
// The store exists for one consumer pair: the dock bell's presence dot
// (UserShell reads `unread`) and the inbox screen (applies server-confirmed
// badges). Real Pinia, mocked API seam (velo-idiom §4/§5) -- the store is the
// thing under test, so only the network boundary is faked.
//
// What is under test, and why:
//   1. refreshUnread reads the `unread` riding the feed response (the comms
//      contract: no separate unread endpoint exists).
//   2. A FAILED refresh keeps the last known value and never throws -- the
//      dot is a courtesy, never a reason to break the shell that hosts it.
//   3. applyUnread takes a server-confirmed badge as-is (list / mark-read /
//      mark-all responses all carry the fresh number).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useNotificationsStore } from '@/stores/notifications'
import * as notificationsApi from '@/api/notifications'

vi.mock('@/api/notifications')

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(notificationsApi.listNotifications).mockReset()
})

describe('notifications store', () => {
  it('starts at 0 unread (no dot before any fetch)', () => {
    expect(useNotificationsStore().unread).toBe(0)
  })

  it('refreshUnread reads the badge riding the feed response', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      items: [],
      next_cursor: null,
      unread: 3,
    })
    const store = useNotificationsStore()

    await store.refreshUnread()

    expect(notificationsApi.listNotifications).toHaveBeenCalledTimes(1)
    expect(store.unread).toBe(3)
  })

  it('a failed refresh keeps the last known value and never throws', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      items: [],
      next_cursor: null,
      unread: 2,
    })
    const store = useNotificationsStore()
    await store.refreshUnread()

    vi.mocked(notificationsApi.listNotifications).mockRejectedValue(new Error('boom'))
    await store.refreshUnread() // must not reject into the host screen

    expect(store.unread).toBe(2)
  })

  it('applyUnread takes a server-confirmed badge as-is', () => {
    const store = useNotificationsStore()

    store.applyUnread(0)

    expect(store.unread).toBe(0)

    store.applyUnread(5)

    expect(store.unread).toBe(5)
  })
})
