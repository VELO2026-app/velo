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
//   5. THE SCOPE BOUNDARY the header documents: opening a row never
//      navigates -- action_data is read by nothing here, deliberately.
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
    type: 'booking.confirmed',
    title: 'Новая запись',
    body: 'Аня записалась на «Утренняя практика»',
    action_data: { action: 'open_booking', params: { booking_id: 'b1' } },
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

  it('a row never navigates on tap -- action_data is read by nothing here', async () => {
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

    expect(push).not.toHaveBeenCalled()
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
})
