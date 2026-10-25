// =============================================================================
// VELO Frontend -- SupportTicketsPanel Tests (PROMPT №713; tickets FE-100 A; «Модерация» FE-100 B)
// =============================================================================
//
// Was AdminSupportView.test.ts: the list moved into «Модерация» as the
// «Обращения» tab (owner ruling 25.10), its own screen and route are gone.
// What stayed the same is asserted the same way (opener fallbacks, the claim
// line, the status badge, the cursor, the hand-off); what changed is said at
// each test.
//
// Seams mocked: @/api/support (listAdminTickets), @/stores/auth (id and
// timezone -- the day filter is the admin's own day), and DatePickerSheet
// (a stub that picks a fixed day: the calendar itself is not this file's
// subject). The filter sheet (VModal) is driven through the real UI --
// closing IS applying, as in «Жалобы».
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import SupportTicketsPanel from '@/components/admin/SupportTicketsPanel.vue'
import * as supportApi from '@/api/support'
import type { AdminSupportTicket } from '@/api/support'

vi.mock('@/api/support')

const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
}))

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, info: vi.fn(), success: vi.fn() }),
}))

const authState: { user: { id: string; timezone: string } | null } = {
  user: { id: 'admin_me', timezone: 'Europe/Berlin' },
}
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    get user() {
      return authState.user
    },
  }),
}))

let pickedDay = '2026-10-20'
vi.mock('@/components/shared/DatePickerSheet.vue', () => ({
  default: defineComponent({
    props: { open: Boolean, modelValue: String },
    emits: ['update:modelValue', 'close'],
    setup(props, { emit }) {
      return () =>
        props.open
          ? h(
              'button',
              {
                class: 'day-stub',
                onClick: () => {
                  emit('update:modelValue', pickedDay)
                  emit('close')
                },
              },
              'pick',
            )
          : null
    },
  }),
}))

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function ticket(overrides: Partial<AdminSupportTicket> = {}): AdminSupportTicket {
  return {
    id: 't_1',
    topic: 'payment',
    category: 'payments',
    status: 'open',
    created_at: new Date(Date.now() - 60 * 60000).toISOString(),
    status_changed_at: new Date(Date.now() - 60 * 60000).toISOString(),
    opener: { user_id: 'u_1', name: 'Алекс', avatar_url: null },
    claimed_by: null,
    history_thread_id: null,
    ...overrides,
  }
}

function page(tickets: AdminSupportTicket[], next_cursor: string | null = null) {
  return { tickets, next_cursor }
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(SupportTicketsPanel).use(createTestI18n())
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function cards(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.scard') ?? [])
}
function onlyCard(): HTMLElement {
  const [c] = cards()
  if (!c) throw new Error('no card rendered')
  return c
}
function btnByText(text: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (b) => b.textContent?.trim() === text,
  )
}
function lastQuery(): supportApi.AdminTicketQuery | undefined {
  return vi.mocked(supportApi.listAdminTickets).mock.lastCall?.[0]
}

// The filter sheet is teleported (VModal) -- query the document, never `host`.
function overlay(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('.v-modal__overlay')
}
function chip(label: string): HTMLElement | undefined {
  return Array.from(overlay()?.querySelectorAll<HTMLElement>('.v-chip') ?? []).find(
    (c) => c.textContent?.trim() === label,
  )
}
async function openFilter(): Promise<void> {
  host?.querySelector<HTMLButtonElement>('.tickets__filter')?.click()
  await flush()
}
async function closeFilter(): Promise<void> {
  overlay()?.querySelector<HTMLButtonElement>('.v-modal__close')?.click()
  await flush()
}
async function applyChips(...labels: string[]): Promise<void> {
  await openFilter()
  for (const label of labels) chip(label)?.click()
  await flush()
  await closeFilter()
}

beforeEach(() => {
  push.mockReset()
  toastError.mockReset()
  authState.user = { id: 'admin_me', timezone: 'Europe/Berlin' }
  pickedDay = '2026-10-20'
  vi.mocked(supportApi.listAdminTickets)
    .mockReset()
    .mockResolvedValue(page([ticket()]))
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  document.body.querySelectorAll('.v-modal__overlay').forEach((el) => el.remove())
  vi.restoreAllMocks()
})

describe('SupportTicketsPanel', () => {
  // ===========================================================================
  // Was: the opener's name was the title, the topic under it. Owner's mockup
  // 25.10 (FE-100): the topic is the title, «name • time» the subtitle.
  describe('one row', () => {
    it('the topic labelled from its code is the title; «name • time» under it', async () => {
      vi.mocked(supportApi.listAdminTickets).mockResolvedValue(
        page([
          ticket({
            topic: 'complaint_master',
            category: 'complaint_master',
            opener: { user_id: 'u_1', name: 'Дана', avatar_url: null },
          }),
        ]),
      )
      mount()
      await flush()

      expect(onlyCard().querySelector('.scard__title')?.textContent?.trim()).toBe(
        'Жалоба на мастера',
      )
      const sub = onlyCard().querySelector('.scard__sub')?.textContent?.trim() ?? ''
      expect(sub.startsWith('Дана • ')).toBe(true)
      expect(sub.length).toBeGreaterThan('Дана • '.length)
    })

    it('labels the master-only complaint code too («Жалоба на пользователя»)', async () => {
      vi.mocked(supportApi.listAdminTickets).mockResolvedValue(
        page([ticket({ topic: 'complaint_user', category: 'complaint_user' })]),
      )
      mount()
      await flush()

      expect(onlyCard().querySelector('.scard__title')?.textContent?.trim()).toBe(
        'Жалоба на пользователя',
      )
    })

    it.each([
      ['no opener', null],
      ['an opener without a name', { user_id: 'u_1', name: null, avatar_url: null }],
    ] as const)('%s -> «Пользователь» in the subtitle', async (_, opener) => {
      vi.mocked(supportApi.listAdminTickets).mockResolvedValue(page([ticket({ opener })]))
      mount()
      await flush()

      expect(onlyCard().querySelector('.scard__sub')?.textContent?.trim()).toMatch(
        /^Пользователь • /,
      )
    })

    it.each([
      ['open', 'Открыта'],
      ['resolved', 'Решена'],
      ['rejected', 'Отклонена'],
      ['duplicate', 'Дубликат'],
      ['spam', 'Спам'],
    ] as const)('status "%s" -> badge «%s»', async (status, label) => {
      vi.mocked(supportApi.listAdminTickets).mockResolvedValue(page([ticket({ status })]))
      mount()
      await flush()

      expect(onlyCard().querySelector('.v-badge')?.textContent?.trim()).toBe(label)
    })

    it.each([
      ['nobody', null, 'Не взято'],
      ['the viewing admin', { user_id: 'admin_me', name: 'Я', avatar_url: null }, 'У меня'],
      ['another admin', { user_id: 'a_2', name: 'Ольга', avatar_url: null }, 'Взял: Ольга'],
      [
        'another admin without a name',
        { user_id: 'a_2', name: null, avatar_url: null },
        'Взял: Администратор',
      ],
    ] as const)('taken by %s -> «%s»', async (_, claimed_by, line) => {
      vi.mocked(supportApi.listAdminTickets).mockResolvedValue(page([ticket({ claimed_by })]))
      mount()
      await flush()

      expect(onlyCard().querySelector('.scard__claim')?.textContent?.trim()).toBe(line)
    })
  })

  // ===========================================================================
  describe('the category glyph (FE-100)', () => {
    it.each([
      ['tech', 'var(--velo-pink-300)'],
      ['payments', 'var(--velo-analytics-neutral)'],
      ['practices', 'var(--velo-analytics-good)'],
      ['complaint_master', 'var(--velo-peach-300)'],
      ['complaint_user', 'var(--velo-peach-300)'],
      ['other', 'var(--velo-blue-200)'],
    ] as const)('category "%s" draws a glyph in %s', async (category, color) => {
      vi.mocked(supportApi.listAdminTickets).mockResolvedValue(page([ticket({ category })]))
      mount()
      await flush()

      const icon = onlyCard().querySelector<HTMLElement>('.scard__icon')
      expect(icon?.dataset.category).toBe(category)
      expect(icon?.getAttribute('style')).toContain(`color: ${color}`)
      expect(icon?.querySelector('svg')).not.toBeNull()
    })

    it('both complaints draw the SAME glyph', async () => {
      vi.mocked(supportApi.listAdminTickets).mockResolvedValue(
        page([
          ticket({ id: 'a', category: 'complaint_master' }),
          ticket({ id: 'b', category: 'complaint_user' }),
        ]),
      )
      mount()
      await flush()

      const [a, b] = cards().map((c) => c.querySelector('.scard__icon svg')?.outerHTML)
      expect(a).toBeDefined()
      expect(a).toBe(b)
    })

    it('different categories draw different glyphs', async () => {
      vi.mocked(supportApi.listAdminTickets).mockResolvedValue(
        page([
          ticket({ id: 'a', category: 'tech' }),
          ticket({ id: 'b', category: 'payments' }),
          ticket({ id: 'c', category: 'other' }),
        ]),
      )
      mount()
      await flush()

      const glyphs = new Set(cards().map((c) => c.querySelector('.scard__icon svg')?.outerHTML))
      expect(glyphs.size).toBe(3)
    })
  })

  // ===========================================================================
  describe('the query -- every filter reaches the request', () => {
    it('on arrival: no filter, the «Все» label -- the backend leaves spam out', async () => {
      mount()
      await flush()

      expect(lastQuery()).toEqual({ limit: 20 })
      expect(host?.querySelector('.tickets__active')?.textContent?.trim()).toBe('Все')
    })

    it.each([
      ['Оплаты', ['payments']],
      ['Практики', ['practices']],
      ['Тех. проблемы', ['tech']],
      ['Жалобы', ['complaint_master', 'complaint_user']],
      ['Другое', ['other']],
    ] as const)('the chip «%s» sends categories %j', async (label, categories) => {
      mount()
      await flush()

      await applyChips(label)

      expect(lastQuery()).toEqual({ limit: 20, categories })
      expect(host?.querySelector('.tickets__active')?.textContent?.trim()).toBe(label)
    })

    it.each([
      ['Открыта', 'open'],
      ['Решена', 'resolved'],
      ['Отклонена', 'rejected'],
      ['Дубликат', 'duplicate'],
    ] as const)('the status chip «%s» sends status "%s"', async (label, status) => {
      mount()
      await flush()

      await applyChips(label)

      expect(lastQuery()).toEqual({ limit: 20, status })
    })

    it('chips are single-choice: a second category replaces the first', async () => {
      mount()
      await flush()

      await applyChips('Оплаты', 'Другое')

      expect(lastQuery()?.categories).toEqual(['other'])
    })

    it('«Все» clears the category again', async () => {
      mount()
      await flush()
      await applyChips('Оплаты')

      await openFilter()
      overlay()
        ?.querySelectorAll<HTMLElement>('.sfilter__group')[0]
        ?.querySelector<HTMLElement>('.v-chip')
        ?.click()
      await flush()
      await closeFilter()

      expect(lastQuery()).toEqual({ limit: 20 })
    })

    it('a day is the ADMIN-zone day [00:00, next 00:00) with the offset', async () => {
      mount()
      await flush()

      await openFilter()
      overlay()?.querySelector<HTMLButtonElement>('.sfilter__date')?.click()
      await flush()
      document.body.querySelector<HTMLButtonElement>('.day-stub')?.click()
      await flush()
      await closeFilter()

      expect(lastQuery()).toEqual({
        limit: 20,
        createdFrom: '2026-10-20T00:00:00.000+02:00',
        createdTo: '2026-10-21T00:00:00.000+02:00',
      })
    })

    it('every filter at once reaches one request', async () => {
      mount()
      await flush()

      await openFilter()
      chip('Жалобы')?.click()
      chip('Решена')?.click()
      overlay()?.querySelector<HTMLButtonElement>('.sfilter__date')?.click()
      await flush()
      document.body.querySelector<HTMLButtonElement>('.day-stub')?.click()
      await flush()
      await closeFilter()

      expect(lastQuery()).toEqual({
        limit: 20,
        categories: ['complaint_master', 'complaint_user'],
        status: 'resolved',
        createdFrom: '2026-10-20T00:00:00.000+02:00',
        createdTo: '2026-10-21T00:00:00.000+02:00',
      })
    })

    it('«Сбросить» clears every group and the day; closing applies the empty filter', async () => {
      mount()
      await flush()
      await openFilter()
      chip('Жалобы')?.click()
      chip('Решена')?.click()
      overlay()?.querySelector<HTMLButtonElement>('.sfilter__date')?.click()
      await flush()
      document.body.querySelector<HTMLButtonElement>('.day-stub')?.click()
      await flush()
      await closeFilter()
      expect(lastQuery()?.status).toBe('resolved')

      await openFilter()
      const reset = Array.from(overlay()?.querySelectorAll<HTMLButtonElement>('.v-btn') ?? []).find(
        (b) => b.textContent?.trim() === 'Сбросить',
      )
      expect(reset?.disabled).toBe(false)
      reset?.click()
      await flush()
      expect(reset?.disabled).toBe(true)
      await closeFilter()

      expect(lastQuery()).toEqual({ limit: 20 })
      expect(host?.querySelector('.tickets__active')?.textContent?.trim()).toBe('Все')
    })
  })

  // ===========================================================================
  describe('the «Спам» tab', () => {
    it('asks for spam only, and keeps the category filter', async () => {
      mount()
      await flush()
      await applyChips('Оплаты')

      btnByText('Спам')?.click()
      await flush()

      expect(lastQuery()).toEqual({ limit: 20, categories: ['payments'], status: 'spam' })
    })

    it('a status chosen before does not leak into «Спам»; back on «Все» it applies again', async () => {
      mount()
      await flush()
      await applyChips('Решена')

      btnByText('Спам')?.click()
      await flush()
      expect(lastQuery()?.status).toBe('spam')

      btnByText('Все')?.click()
      await flush()
      expect(lastQuery()?.status).toBe('resolved')
    })

    it('the filter sheet hides the status group in «Спам»', async () => {
      mount()
      await flush()
      btnByText('Спам')?.click()
      await flush()

      await openFilter()

      expect(chip('Открыта')).toBeUndefined()
      expect(chip('Оплаты')).toBeDefined()
    })
  })

  // ===========================================================================
  describe('the ladder, the cursor, the stale answer', () => {
    it('a card click opens the ticket card with a deep-cloned state hand-off', async () => {
      const t = ticket({ id: 't_click' })
      vi.mocked(supportApi.listAdminTickets).mockResolvedValue(page([t]))
      mount()
      await flush()

      onlyCard().click()
      await flush()

      expect(push).toHaveBeenCalledWith({
        name: 'admin-support-detail',
        params: { id: 't_click' },
        state: { ticket: JSON.parse(JSON.stringify(t)) },
      })
    })

    it('a load failure shows the retry state, and retry loads again', async () => {
      vi.mocked(supportApi.listAdminTickets).mockRejectedValueOnce(new Error('boom'))
      mount()
      await flush()

      expect(toastError).toHaveBeenCalled()
      btnByText('Повторить')?.click()
      await flush()

      expect(cards()).toHaveLength(1)
    })

    it('no tickets -> the empty state', async () => {
      vi.mocked(supportApi.listAdminTickets).mockResolvedValue(page([]))
      mount()
      await flush()

      expect(host?.textContent).toContain('Обращений нет')
    })

    it('«Показать ещё» sends the cursor WITH the active filter', async () => {
      vi.mocked(supportApi.listAdminTickets).mockResolvedValue(page([ticket()], 'cursor-2'))
      mount()
      await flush()
      await applyChips('Практики')

      vi.mocked(supportApi.listAdminTickets).mockResolvedValueOnce(
        page([ticket({ id: 't_2' })], null),
      )
      btnByText('Показать ещё')?.click()
      await flush()

      expect(lastQuery()).toEqual({ limit: 20, categories: ['practices'], cursor: 'cursor-2' })
      expect(cards()).toHaveLength(2)
      expect(btnByText('Показать ещё')).toBeUndefined()
    })

    it('two «Показать ещё» taps before the page lands ask for ONE page', async () => {
      vi.mocked(supportApi.listAdminTickets).mockResolvedValueOnce(page([ticket()], 'cursor-2'))
      mount()
      await flush()

      let resolvePage!: (v: supportApi.AdminSupportTicketList) => void
      vi.mocked(supportApi.listAdminTickets).mockReturnValueOnce(
        new Promise((resolve) => {
          resolvePage = resolve
        }),
      )
      btnByText('Показать ещё')?.click()
      btnByText('Показать ещё')?.click()
      await flush()

      expect(supportApi.listAdminTickets).toHaveBeenCalledTimes(2)
      resolvePage(page([ticket({ id: 't_2' })], null))
      await flush()
    })

    it('a late answer of an older filter is dropped -- the newest wins', async () => {
      mount()
      await flush()

      let resolveOld!: (v: supportApi.AdminSupportTicketList) => void
      vi.mocked(supportApi.listAdminTickets).mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve
        }),
      )
      await applyChips('Оплаты')
      vi.mocked(supportApi.listAdminTickets).mockResolvedValueOnce(
        page([ticket({ id: 'new', topic: 'other', category: 'other' })]),
      )
      await applyChips('Другое')

      resolveOld(page([ticket({ id: 'old', topic: 'payment' })]))
      await flush()

      expect(cards()).toHaveLength(1)
      expect(onlyCard().querySelector('.scard__title')?.textContent?.trim()).toBe('Другое')
    })
  })
})
