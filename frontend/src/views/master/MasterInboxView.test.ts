// =============================================================================
// VELO Frontend -- MasterInboxView Screen Tests (T-26 bell, PROMPT №704)
// =============================================================================
//
// The master's bell feed over GET /api/v1/notifications. The seam is
// @/api/notifications, mocked whole -- same house pattern as
// UserMessagesView.test.ts (raw createApp, every test its own mount).
//
// What is under test, and why:
//   1. The four list states (loading / error+retry / empty / rows) are
//      distinct, mirroring UserMessagesView's ladder exactly.
//   2. TAPPING AN UNREAD ROW marks it read: optimistic dot-clear + a real
//      call to markNotificationRead, reverted on failure (same shape as
//      NotificationsView.vue's toggle revert, T-26).
//   3. TAPPING AN ALREADY-READ ROW is a no-op -- no network call. Nothing
//      to mark, nothing to revert.
//   4. "ПРОЧИТАТЬ ВСЁ" only renders when unread > 0, marks every row read,
//      and reverts EVERY row (not just the failing one) on failure.
//   5. DEEP LINKS (master parity 2026-09-08 -- the T-26 tap=read boundary
//      is lifted): a tap navigates by action_data.action, same vocabulary
//      as the user map but into MASTER-zone routes -- open_practice ->
//      master-practice-detail, open_wallet -> master-finance, open_thread
//      -> that dialog (master-chat), msg.* (no velo action) -> the master
//      messages list. Unmapped action / malformed id -> mark-read only,
//      never a broken route. A READ row still navigates.
//   6. TYPE SLIDER (Сообщения / Практики / Финансы / Другое): prefix
//      buckets over the emit vocabulary, «Сообщения» first/default, the
//      per-filter empty note, and no slider over an empty feed.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import MasterInboxView from '@/views/master/MasterInboxView.vue'
import * as notificationsApi from '@/api/notifications'
import type { NotificationItem } from '@/api/notifications'

vi.mock('@/api/notifications')

const back = vi.fn()
const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ back, push }),
}))

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, info: vi.fn(), success: vi.fn() }),
}))

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function item(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'n1',
    // The default tab is «Сообщения», so the DEFAULT fixture is a msg row --
    // the base states (loading/error/empty/mark-read/mark-all) all see
    // their rows without touching the slider. Non-msg cases switch the tab
    // or override the type.
    type: 'msg.support_message',
    title: 'Сообщение от Ани',
    body: 'Доброе утро! Можно вопрос по практике?',
    action_data: null,
    priority: 5,
    sent_at: '2026-08-14T10:00:00Z',
    read_at: null,
    created_at: '2026-08-14T10:00:00Z',
    ...overrides,
  }
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(MasterInboxView)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await nextTick()
}

function rows(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.notif-row') ?? [])
}

function row(i: number): HTMLElement {
  const el = rows()[i]
  if (!el) throw new Error(`no notification row #${i}`)
  return el
}

function isUnread(el: HTMLElement): boolean {
  return !el.classList.contains('notif-row--read')
}

function readAllButton(): HTMLElement | undefined {
  return Array.from(host?.querySelectorAll('button') ?? []).find(
    (b) => b.textContent?.trim() === 'Прочитать всё',
  )
}

function segment(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-segment-track__btn') ?? []).find(
    (b) => b.textContent?.trim() === label,
  )
}

beforeEach(() => {
  push.mockReset()
  back.mockReset()
  toastError.mockReset()
  vi.mocked(notificationsApi.listNotifications).mockReset()
  vi.mocked(notificationsApi.markNotificationRead).mockReset()
  vi.mocked(notificationsApi.markAllNotificationsRead).mockReset()
})

afterEach(() => {
  app?.unmount()
  app = null
  host?.remove()
  host = null
})

// -----------------------------------------------------------------------------

describe('MasterInboxView', () => {
  it('renders one row per item, unread/read distinguished by class', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      items: [item({ id: 'a', read_at: null }), item({ id: 'b', read_at: '2026-08-14T09:00:00Z' })],
      next_cursor: null,
      unread: 1,
    })
    mount()
    await flush()

    expect(rows()).toHaveLength(2)
    expect(isUnread(row(0))).toBe(true)
    expect(isUnread(row(1))).toBe(false)
  })

  it('empty list shows the confirmed empty-state, not fake rows', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      items: [],
      next_cursor: null,
      unread: 0,
    })
    mount()
    await flush()

    expect(rows()).toHaveLength(0)
    expect(host?.textContent).toContain(
      'Здесь появятся уведомления о записях, сообщениях и операциях',
    )
  })

  it('a failed load shows the retry state, and «Повторить» actually refetches', async () => {
    vi.mocked(notificationsApi.listNotifications)
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({ items: [item()], next_cursor: null, unread: 1 })
    mount()
    await flush()

    expect(host?.textContent).toContain('Не удалось загрузить')

    const retry = Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
      b.textContent?.includes('Повторить'),
    )
    retry?.click()
    await flush()

    expect(rows()).toHaveLength(1)
  })

  it('tapping an UNREAD row marks it read: dot clears, server called', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      items: [item({ id: 'a', read_at: null })],
      next_cursor: null,
      unread: 1,
    })
    vi.mocked(notificationsApi.markNotificationRead).mockResolvedValue({ unread: 0 })
    mount()
    await flush()

    row(0).click()
    await flush()

    expect(notificationsApi.markNotificationRead).toHaveBeenCalledWith('a')
    expect(isUnread(row(0))).toBe(false)
  })

  it('a failed mark-read reverts the row and toasts', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      items: [item({ id: 'a', read_at: null })],
      next_cursor: null,
      unread: 1,
    })
    vi.mocked(notificationsApi.markNotificationRead).mockRejectedValue(new Error('boom'))
    mount()
    await flush()

    row(0).click()
    await flush()

    expect(isUnread(row(0))).toBe(true) // reverted, not left read
    expect(toastError).toHaveBeenCalledWith('Не удалось отметить прочитанным')
  })

  it('tapping an ALREADY-READ row is a no-op -- no network call', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      items: [item({ id: 'a', read_at: '2026-08-14T09:00:00Z' })],
      next_cursor: null,
      unread: 0,
    })
    mount()
    await flush()

    row(0).click()
    await flush()

    expect(notificationsApi.markNotificationRead).not.toHaveBeenCalled()
  })

  it('a tap navigates by action_data AND marks read: open_practice -> master-practice-detail', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      items: [
        item({
          id: 'a',
          type: 'booking.cancelled_by_user',
          action_data: { action: 'open_practice', params: { practice_id: 'pr_1' } },
        }),
      ],
      next_cursor: null,
      unread: 1,
    })
    vi.mocked(notificationsApi.markNotificationRead).mockResolvedValue({ unread: 0 })
    mount()
    await flush()

    segment('Практики')?.click()
    await flush()

    row(0).click()
    await flush()

    expect(notificationsApi.markNotificationRead).toHaveBeenCalledWith('a')
    expect(push).toHaveBeenCalledWith({ name: 'master-practice-detail', params: { id: 'pr_1' } })
  })

  it('a msg.* row with open_thread goes straight INTO that dialog', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      items: [
        item({
          id: 'g',
          action_data: { action: 'open_thread', params: { thread_id: 'th_9' } },
        }),
      ],
      next_cursor: null,
      unread: 1,
    })
    vi.mocked(notificationsApi.markNotificationRead).mockResolvedValue({ unread: 0 })
    mount()
    await flush()

    row(0).click()
    await flush()

    expect(push).toHaveBeenCalledWith({ name: 'master-chat', params: { id: 'th_9' } })
  })

  it('a msg.* row (no velo action) goes to the master messages list', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      items: [item({ id: 'b', action_data: null })],
      next_cursor: null,
      unread: 1,
    })
    vi.mocked(notificationsApi.markNotificationRead).mockResolvedValue({ unread: 0 })
    mount()
    await flush()

    row(0).click()
    await flush()

    expect(push).toHaveBeenCalledWith({ name: 'master-messages' })
  })

  it('open_wallet -> the master finance screen', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      items: [
        item({
          id: 'c',
          type: 'wallet.withdrawal_approved',
          action_data: { action: 'open_wallet', params: {} },
        }),
      ],
      next_cursor: null,
      unread: 1,
    })
    vi.mocked(notificationsApi.markNotificationRead).mockResolvedValue({ unread: 0 })
    mount()
    await flush()

    segment('Финансы')?.click()
    await flush()

    row(0).click()
    await flush()

    expect(push).toHaveBeenCalledWith({ name: 'master-finance' })
  })

  it('unmapped action and not msg.* -> mark-read only, NO navigation', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      items: [item({ id: 'd', type: 'practice.cancelled_by_curator', action_data: null })],
      next_cursor: null,
      unread: 1,
    })
    vi.mocked(notificationsApi.markNotificationRead).mockResolvedValue({ unread: 0 })
    mount()
    await flush()

    segment('Практики')?.click()
    await flush()

    row(0).click()
    await flush()

    expect(notificationsApi.markNotificationRead).toHaveBeenCalledWith('d')
    expect(push).not.toHaveBeenCalled()
  })

  it('a malformed practice_id never becomes an undefined route param', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      items: [
        item({
          id: 'e',
          type: 'booking.cancelled_by_user',
          action_data: { action: 'open_practice', params: { practice_id: 42 } },
        }),
      ],
      next_cursor: null,
      unread: 1,
    })
    vi.mocked(notificationsApi.markNotificationRead).mockResolvedValue({ unread: 0 })
    mount()
    await flush()

    segment('Практики')?.click()
    await flush()

    row(0).click()
    await flush()

    expect(push).not.toHaveBeenCalled() // mark-read only -- honest fallback
  })

  it('tapping an ALREADY-READ row still navigates, without a redundant read call', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      items: [item({ id: 'f', read_at: '2026-08-14T09:00:00Z' })],
      next_cursor: null,
      unread: 0,
    })
    mount()
    await flush()

    row(0).click()
    await flush()

    expect(notificationsApi.markNotificationRead).not.toHaveBeenCalled()
    expect(push).toHaveBeenCalledWith({ name: 'master-messages' })
  })

  it('«Прочитать всё» is absent when unread is 0', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      items: [item({ read_at: '2026-08-14T09:00:00Z' })],
      next_cursor: null,
      unread: 0,
    })
    mount()
    await flush()

    expect(readAllButton()).toBeUndefined()
  })

  it('«Прочитать всё» marks every row read in one call', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      items: [item({ id: 'a', read_at: null }), item({ id: 'b', read_at: null })],
      next_cursor: null,
      unread: 2,
    })
    vi.mocked(notificationsApi.markAllNotificationsRead).mockResolvedValue({ unread: 0 })
    mount()
    await flush()

    readAllButton()?.click()
    await flush()

    expect(notificationsApi.markAllNotificationsRead).toHaveBeenCalledTimes(1)
    expect(notificationsApi.markNotificationRead).not.toHaveBeenCalled()
    expect(isUnread(row(0))).toBe(false)
    expect(isUnread(row(1))).toBe(false)
  })

  it('a failed «Прочитать всё» reverts EVERY row, not just one', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      items: [item({ id: 'a', read_at: null }), item({ id: 'b', read_at: null })],
      next_cursor: null,
      unread: 2,
    })
    vi.mocked(notificationsApi.markAllNotificationsRead).mockRejectedValue(new Error('boom'))
    mount()
    await flush()

    readAllButton()?.click()
    await flush()

    expect(isUnread(row(0))).toBe(true)
    expect(isUnread(row(1))).toBe(true)
    expect(toastError).toHaveBeenCalledWith('Не удалось отметить прочитанным')
  })

  it('the back button calls router.back()', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      items: [],
      next_cursor: null,
      unread: 0,
    })
    mount()
    await flush()

    host?.querySelector<HTMLElement>('.v-back')?.click()
    await flush()

    expect(back).toHaveBeenCalled()
  })

  // ===========================================================================
  describe('type slider (Сообщения / Практики / Финансы / Другое)', () => {
    // One row per bucket + the "other" case: the buckets are PREFIX rules
    // over velo's emit vocabulary (msg.* / booking.* / practice.* /
    // waitlist.* / wallet.*), and «Другое» owns every kind with no bucket
    // of its own (announcements and future kinds).
    function mixed(): NotificationItem[] {
      return [
        item({ id: 'a', type: 'msg.support_message' }),
        item({ id: 'b', type: 'booking.cancelled_by_user' }),
        item({ id: 'c', type: 'practice.cancelled_by_curator' }),
        item({ id: 'd', type: 'waitlist.expired' }),
        item({ id: 'e', type: 'wallet.withdrawal_approved' }),
        item({ id: 'f', type: 'system.announcement' }),
      ]
    }

    it('«Сообщения» is the default and shows only msg.* rows, slider rendered', async () => {
      vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
        items: mixed(),
        next_cursor: null,
        unread: 6,
      })
      mount()
      await flush()

      expect(rows()).toHaveLength(1)
      expect(rows()[0]?.textContent).toContain('Сообщение от Ани')
      expect(segment('Сообщения')).toBeDefined()
      expect(segment('Практики')).toBeDefined()
      expect(segment('Финансы')).toBeDefined()
      expect(segment('Другое')).toBeDefined()
    })

    it('«Практики» keeps practice-life rows in, msg and wallet out', async () => {
      vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
        items: mixed(),
        next_cursor: null,
        unread: 6,
      })
      mount()
      await flush()

      segment('Практики')?.click()
      await flush()

      expect(rows()).toHaveLength(3) // booking.* + practice.* + waitlist.*
    })

    it('«Финансы» shows the wallet rows only', async () => {
      vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
        items: mixed(),
        next_cursor: null,
        unread: 6,
      })
      mount()
      await flush()

      segment('Финансы')?.click()
      await flush()

      expect(rows()).toHaveLength(1)
    })

    it('«Другое» shows the complement: the announcement in, every bucket out', async () => {
      vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
        items: mixed(),
        next_cursor: null,
        unread: 6,
      })
      mount()
      await flush()

      segment('Другое')?.click()
      await flush()

      expect(rows()).toHaveLength(1)
    })

    it('a filter with no matches shows the per-filter note, NOT the global empty state', async () => {
      vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
        items: [item({ id: 'a', type: 'wallet.withdrawal_approved' })],
        next_cursor: null,
        unread: 1,
      })
      mount()
      await flush()

      // default tab «Сообщения» has nothing to show
      expect(rows()).toHaveLength(0)
      expect(host?.textContent).toContain('В этой категории пока нет уведомлений')
      expect(host?.textContent).not.toContain('Здесь появятся уведомления')
    })

    it('the slider is absent while the whole feed is empty', async () => {
      vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
        items: [],
        next_cursor: null,
        unread: 0,
      })
      mount()
      await flush()

      expect(segment('Сообщения')).toBeUndefined()
      expect(host?.textContent).toContain(
        'Здесь появятся уведомления о записях, сообщениях и операциях',
      )
    })
  })
})
