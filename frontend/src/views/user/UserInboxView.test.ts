// =============================================================================
// VELO Frontend -- UserInboxView Screen Tests (FE-11 bell)
// =============================================================================
//
// The user's bell feed over GET /api/v1/notifications -- a deliberate mirror
// of MasterInboxView.test.ts (T-26): same seams, same cases, because the
// screens share one contract by design. The seam is @/api/notifications,
// mocked whole (house pattern).
//
// What is under test, and why:
//   1. The four list states (loading / error+retry / empty / rows) are
//      distinct.
//   2. TAPPING AN UNREAD ROW marks it read: optimistic dot-clear + a real
//      call to markNotificationRead, reverted on failure.
//   3. TAPPING AN ALREADY-READ ROW is a no-op -- no network call.
//   4. "ПРОЧИТАТЬ ВСЁ" only renders when unread > 0, marks every row read,
//      and reverts EVERY row (not just the failing one) on failure.
//   5. DEEP LINKS (FE-11 owner ruling): a tap navigates by action_data.action
//      -- velo's own action vocabulary -- AND marks the row read:
//      open_practice / confirm_waitlist -> practice-detail (+ practice_id),
//      open_feedback -> user-feedback, open_wallet -> user-topup, msg.* (no
//      velo action) -> the messages list. Unmapped action / malformed id ->
//      mark-read only, never a broken route. A READ row still navigates.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import UserInboxView from '@/views/user/UserInboxView.vue'
import * as notificationsApi from '@/api/notifications'
import * as cgApi from '@/api/curatorGroups'
import type { NotificationItem } from '@/api/notifications'
import type { CuratorGroupMineItem } from '@/api/types'
import { useNotificationsStore } from '@/stores/notifications'
import { useAuthStore } from '@/stores/auth'

vi.mock('@/api/notifications')
vi.mock('@/api/curatorGroups')

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
    title: 'Запись подтверждена',
    body: 'Вы записались на «Утренняя практика»',
    action_data: { action: 'open_practice', params: { practice_id: 'pr_1' } },
    priority: 5,
    sent_at: '2026-08-14T10:00:00Z',
    read_at: null,
    created_at: '2026-08-14T10:00:00Z',
    ...overrides,
  }
}

/** One /curator-groups/mine row: a curated school the removed inbox mocks would
 *  have minted an invite for -- the «nothing but the feed» test seeds it. */
function mineItem(overrides: Partial<CuratorGroupMineItem> = {}): CuratorGroupMineItem {
  return {
    id: 'g1',
    name: 'Тихая школа',
    description: null,
    curator: { user_id: 'u1', display_name: 'Мария', avatar_url: null },
    masters_count: 1,
    students_count: 3,
    relation: 'curator',
    ...overrides,
  } as CuratorGroupMineItem
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(UserInboxView)
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
  // The view reads the notifications store (the dock bell's dot) -- give it a
  // fresh Pinia per test, same house pattern as UserDashboardView.test.ts.
  setActivePinia(createPinia())
  push.mockReset()
  back.mockReset()
  toastError.mockReset()
  vi.mocked(notificationsApi.listNotifications).mockReset()
  vi.mocked(notificationsApi.markNotificationRead).mockReset()
  vi.mocked(notificationsApi.markAllNotificationsRead).mockReset()
  vi.mocked(cgApi.getMyCuratorGroups)
    .mockReset()
    .mockResolvedValue({
      items: [],
    } as never)
  vi.mocked(cgApi.createCuratorGroupInvite)
    .mockReset()
    .mockResolvedValue({
      invite_url: 'https://t.me/velobot?start=curator_group_invite__tok123',
    } as never)
})

afterEach(() => {
  app?.unmount()
  app = null
  host?.remove()
  host = null
})

// -----------------------------------------------------------------------------

describe('UserInboxView', () => {
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

  it('a tap navigates by action_data AND marks read: open_practice -> practice-detail', async () => {
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
    expect(push).toHaveBeenCalledWith({ name: 'practice-detail', params: { id: 'pr_1' } })
  })

  it('a msg.* row with open_thread goes straight INTO that dialog', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      items: [
        item({
          id: 'g',
          type: 'msg.participant_message',
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

    expect(push).toHaveBeenCalledWith({ name: 'user-chat', params: { id: 'th_9' } })
  })

  it('a msg.* row (no velo action) goes to the messages list', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      items: [item({ id: 'b', type: 'msg.participant_message', action_data: null })],
      next_cursor: null,
      unread: 1,
    })
    vi.mocked(notificationsApi.markNotificationRead).mockResolvedValue({ unread: 0 })
    mount()
    await flush()

    row(0).click()
    await flush()

    expect(push).toHaveBeenCalledWith({ name: 'user-messages' })
  })

  it('open_wallet -> the top-up screen', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      items: [
        item({ id: 'c', type: 'finance', action_data: { action: 'open_wallet', params: {} } }),
      ],
      next_cursor: null,
      unread: 1,
    })
    vi.mocked(notificationsApi.markNotificationRead).mockResolvedValue({ unread: 0 })
    mount()
    await flush()

    row(0).click()
    await flush()

    expect(push).toHaveBeenCalledWith({ name: 'user-topup' })
  })

  it('curator_group.master_offered rides open_curator_group into the consent screen (BE-59)', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      items: [
        item({
          id: 'mo',
          type: 'curator_group.master_offered',
          title: 'Вас приглашают вести школу',
          body: 'Мария Иванова предлагает вам стать мастером школы «Тихая школа».',
          action_data: { action: 'open_curator_group', params: { group_id: 'g1' } },
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

    expect(push).toHaveBeenCalledWith({
      name: 'curator-group-master-offer',
      params: { id: 'g1' },
    })
  })

  it('another school event with the same open_curator_group action stays mark-read-only', async () => {
    // The master-offer mapping keys on the TYPE, not the action: every
    // curator_group.* event carries open_curator_group, and only the
    // appointment prompt has a consent screen.
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      items: [
        item({
          id: 'tr',
          type: 'curator_group.transfer_offered',
          action_data: { action: 'open_curator_group', params: { group_id: 'g1' } },
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

    expect(notificationsApi.markNotificationRead).toHaveBeenCalledWith('tr')
    expect(push).not.toHaveBeenCalled()
  })

  it('open_master_application -> the apply wizard (BE-59 verification prompt)', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      items: [
        item({
          id: 'mv',
          type: 'curator_group.master_verification_required',
          action_data: { action: 'open_master_application', params: { group_id: 'g1' } },
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

    expect(push).toHaveBeenCalledWith({ name: 'master-apply' })
  })

  async function tapOne(type: string, action: string): Promise<void> {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      items: [item({ id: 'be104', type, action_data: { action, params: {} } })],
      next_cursor: null,
      unread: 1,
    })
    vi.mocked(notificationsApi.markNotificationRead).mockResolvedValue({ unread: 0 })
    mount()
    await flush()
    row(0).click()
    await flush()
  }

  function seedAllowedRoles(roles: string[]): void {
    useAuthStore().user = { role: 'user', role_switch: { allowed_roles: roles } } as never
  }

  // BE-104: the master-status vocabulary. The TYPE sends a rejection to its
  // verdict screen; the same verb from any other type keeps the wizard.
  it('BE-104: master.rejected + open_master_application -> master-pending (reason + reapply)', async () => {
    await tapOne('master.rejected', 'open_master_application')
    expect(push).toHaveBeenCalledWith({ name: 'master-pending' })
  })

  it('BE-104: master.application_submitted + open_master_application keeps master-apply', async () => {
    await tapOne('master.application_submitted', 'open_master_application')
    expect(push).toHaveBeenCalledWith({ name: 'master-apply' })
  })

  it('BE-104: open_master_zone with the master capability -> master-pending (switch offer)', async () => {
    seedAllowedRoles(['user', 'master'])
    await tapOne('master.verified', 'open_master_zone')
    expect(push).toHaveBeenCalledWith({ name: 'master-pending' })
  })

  it('BE-104: open_master_zone WITHOUT the capability -> mark-read only, NO navigation', async () => {
    seedAllowedRoles(['user'])
    await tapOne('master.verified', 'open_master_zone')
    expect(notificationsApi.markNotificationRead).toHaveBeenCalledWith('be104')
    expect(push).not.toHaveBeenCalled()
  })

  it('BE-104: open_support -> user-support', async () => {
    await tapOne('master.suspended', 'open_support')
    expect(push).toHaveBeenCalledWith({ name: 'user-support' })
  })

  it('unmapped action and not msg.* -> mark-read only, NO navigation', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      items: [item({ id: 'd', type: 'practice.cancelled', action_data: null })],
      next_cursor: null,
      unread: 1,
    })
    vi.mocked(notificationsApi.markNotificationRead).mockResolvedValue({ unread: 0 })
    mount()
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
          action_data: { action: 'open_practice', params: { practice_id: 42 } },
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
    expect(push).toHaveBeenCalledWith({ name: 'practice-detail', params: { id: 'pr_1' } })
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

  it('server-confirmed badges reach the dock-bell store (the dot tracks this screen)', async () => {
    vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
      items: [item({ id: 'a', read_at: null })],
      next_cursor: null,
      unread: 1,
    })
    vi.mocked(notificationsApi.markAllNotificationsRead).mockResolvedValue({ unread: 0 })
    mount()
    await flush()

    // load() applied the feed badge...
    expect(useNotificationsStore().unread).toBe(1)

    readAllButton()?.click()
    await flush()

    // ...and mark-all applied the fresh one -- the dock dot clears with it.
    expect(useNotificationsStore().unread).toBe(0)
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
  describe('type slider (Все / Сообщения / Мероприятия / Другое)', () => {
    // One row per bucket + one "other" kind: the buckets are PREFIX rules over
    // velo's emit vocabulary (msg.* / booking.* / practice.* / waitlist.*),
    // and finance is the complement case -- «Другое» owns every kind with no
    // bucket of its own (owner ask).
    function mixed(): NotificationItem[] {
      return [
        item({ id: 'a', type: 'booking.confirmed' }),
        item({ id: 'b', type: 'msg.participant_message' }),
        item({ id: 'c', type: 'practice.cancelled' }),
        item({ id: 'd', type: 'waitlist.spot_available' }),
        item({ id: 'e', type: 'finance' }),
      ]
    }

    function segment(label: string): HTMLButtonElement | undefined {
      return Array.from(
        host?.querySelectorAll<HTMLButtonElement>('.v-segment-track__btn') ?? [],
      ).find((b) => b.textContent?.trim() === label)
    }

    it('«Все» is the default and shows every row, slider rendered', async () => {
      vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
        items: mixed(),
        next_cursor: null,
        unread: 5,
      })
      mount()
      await flush()

      expect(rows()).toHaveLength(5)
      expect(segment('Все')).toBeDefined()
      expect(segment('Сообщения')).toBeDefined()
      expect(segment('Мероприятия')).toBeDefined()
      expect(segment('Другое')).toBeDefined()
    })

    it('«Сообщения» shows only msg.* rows', async () => {
      vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
        items: mixed(),
        next_cursor: null,
        unread: 5,
      })
      mount()
      await flush()

      segment('Сообщения')?.click()
      await flush()

      expect(rows()).toHaveLength(1)
      expect(rows()[0]?.textContent).toContain('Запись подтверждена') // the msg fixture's title
    })

    it('«Мероприятия» keeps practice-life rows in, msg and finance out', async () => {
      vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
        items: mixed(),
        next_cursor: null,
        unread: 5,
      })
      mount()
      await flush()

      segment('Мероприятия')?.click()
      await flush()

      expect(rows()).toHaveLength(3) // booking.* + practice.* + waitlist.*
    })

    it('«Другое» shows the complement only: finance in, msg and practice-life out', async () => {
      vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
        items: mixed(),
        next_cursor: null,
        unread: 5,
      })
      mount()
      await flush()

      segment('Другое')?.click()
      await flush()

      expect(rows()).toHaveLength(1) // the finance fixture only
      expect(rows()[0]?.textContent).toContain('Запись подтверждена') // its title
    })

    it('a filter with no matches shows the per-filter note, NOT the global empty state', async () => {
      vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
        items: [item({ id: 'a', type: 'booking.confirmed' })],
        next_cursor: null,
        unread: 1,
      })
      mount()
      await flush()

      segment('Сообщения')?.click()
      await flush()

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

      expect(segment('Все')).toBeUndefined()
      expect(host?.textContent).toContain(
        'Здесь появятся уведомления о записях, сообщениях и операциях',
      )
    })
  })

  // ===========================================================================
  // The bell is ONLY the server (owner 2026-10-02): the client-side invite
  // mocks for telegram 388101199 were removed. The account that used to see
  // them now sees exactly the server page and the server badge, and opening
  // the bell calls nothing but the feed -- the mocks used to mint a real
  // school invite token (createCuratorGroupInvite) on every open.
  // ===========================================================================
  describe('the former simulation account sees only the server', () => {
    function seedTelegram(telegramId: number): void {
      useAuthStore().user = { id: 'u_sim', telegram_id: telegramId, role: 'user' } as never
    }

    it('telegram 388101199: rows and badge are exactly the server page', async () => {
      seedTelegram(388101199)
      // A curated school exists -- the removed mock would have used it.
      vi.mocked(cgApi.getMyCuratorGroups).mockResolvedValue({
        items: [mineItem({ relation: 'curator' })],
      } as never)
      vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
        items: [item({ id: 'a', read_at: '2026-01-01T00:00:00Z' })],
        next_cursor: null,
        unread: 0,
      })
      mount()
      await flush()

      expect(rows()).toHaveLength(1)
      expect(isUnread(row(0))).toBe(false)
      expect(useNotificationsStore().unread).toBe(0)
      expect(readAllButton()).toBeFalsy()
      // The only API the bell touched is the feed.
      expect(notificationsApi.listNotifications).toHaveBeenCalledTimes(1)
      expect(cgApi.getMyCuratorGroups).not.toHaveBeenCalled()
      expect(cgApi.createCuratorGroupInvite).not.toHaveBeenCalled()
    })

    it('telegram 388101199: a tap marks read on the SERVER (no client-only rows)', async () => {
      seedTelegram(388101199)
      vi.mocked(notificationsApi.listNotifications).mockResolvedValue({
        items: [item({ id: 'srv' })],
        next_cursor: null,
        unread: 1,
      })
      vi.mocked(notificationsApi.markNotificationRead).mockResolvedValue({ unread: 0 })
      mount()
      await flush()

      expect(rows()).toHaveLength(1)
      row(0).click()
      await flush()

      expect(notificationsApi.markNotificationRead).toHaveBeenCalledWith('srv')
      expect(useNotificationsStore().unread).toBe(0)
    })
  })
})
