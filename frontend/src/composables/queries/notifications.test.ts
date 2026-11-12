// =============================================================================
// VELO Frontend -- the user-zone bell's unread badge on Colada (FE-11/FE-12; FE-166 step 6)
// =============================================================================
//
// The badge used to be stores/notifications.ts; now one Colada entry shared
// by the dashboard bell and the inbox (composables/queries/notifications.ts).
// Real Pinia and Colada, mocked API seam.
//
// What is under test, and why:
//   1. The badge is the `unread` riding the feed response (the comms
//      contract: no separate unread endpoint exists).
//   2. A FAILED refresh keeps the last known value and never throws -- the
//      dot is a courtesy, never a reason to break the screen that hosts it.
//   3. applyUnread takes a server-confirmed badge as-is (list / mark-read /
//      mark-all responses all carry the fresh number), and its entry is a
//      real one (options: garbage-collected, refetchable).
//   4. A resume within UNREAD_STALE_MS asks nothing; the poll asks always.
//   5. The end of a session forgets the badge.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { PiniaColada, useQueryCache } from '@pinia/colada'
import { coladaOptions, useQueryScopeStore } from '@/composables/queries/setup'
import { keys } from '@/composables/queries/keys'
import { applyUnread, refreshUnread, useUnreadBadge } from '@/composables/queries/notifications'
import * as notificationsApi from '@/api/notifications'

vi.mock('@/api/notifications')

let pinia: Pinia
let app: App | null = null
let badge: ReturnType<typeof useUnreadBadge>

function feed(unread: number) {
  return { items: [], next_cursor: null, unread }
}

function mountBell(): void {
  const Bell = defineComponent({
    setup() {
      badge = useUnreadBadge()
      return () => h('div')
    },
  })
  app = createApp(Bell).use(pinia)
  app.mount(document.createElement('div'))
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  pinia = createPinia()
  createApp({}).use(pinia).use(PiniaColada, coladaOptions)
  setActivePinia(pinia)
  vi.mocked(notificationsApi.listNotifications).mockReset().mockResolvedValue(feed(0))
})

afterEach(() => {
  app?.unmount()
  app = null
})

describe('the unread badge', () => {
  it('starts at 0 (no dot before any answer) and reads the badge riding the feed response', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue(feed(3))
    mountBell()
    expect(badge.unread.value).toBe(0)
    await flush()

    expect(notificationsApi.listNotifications).toHaveBeenCalledTimes(1)
    expect(badge.unread.value).toBe(3)
  })

  it('a failed refresh keeps the last known value and never throws', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue(feed(2))
    mountBell()
    await flush()

    vi.mocked(notificationsApi.listNotifications).mockRejectedValue(new Error('boom'))
    await expect(badge.refetch()).resolves.toBeDefined()
    await expect(refreshUnread(useQueryCache())).resolves.toBeUndefined()

    expect(badge.unread.value).toBe(2)
  })

  it('applyUnread takes a server-confirmed badge as-is, into an entry with options', async () => {
    mountBell()
    await flush()

    applyUnread(useQueryCache(), 5)
    expect(badge.unread.value).toBe(5)
    applyUnread(useQueryCache(), 0)
    expect(badge.unread.value).toBe(0)
  })

  it('applyUnread with no bell mounted still creates a real entry (options: collectable)', () => {
    applyUnread(useQueryCache(), 4)

    const entry = useQueryCache().get(keys.notifications.unread())
    expect(entry?.state.value.data).toBe(4)
    expect(entry?.options).not.toBeNull()
  })

  it('a resume within UNREAD_STALE_MS asks nothing; the poll asks always', async () => {
    await refreshUnread(useQueryCache()) // the idle prefetch
    mountBell()
    await flush()
    await badge.refresh() // the dashboard's resume
    expect(notificationsApi.listNotifications).toHaveBeenCalledTimes(1)

    await badge.refetch() // a poll tick
    expect(notificationsApi.listNotifications).toHaveBeenCalledTimes(2)
  })

  it('the end of a session forgets the badge', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue(feed(7))
    await refreshUnread(useQueryCache())

    useQueryScopeStore().$reset()

    expect(useQueryCache().getQueryData(keys.notifications.unread())).toBeUndefined()
  })
})
