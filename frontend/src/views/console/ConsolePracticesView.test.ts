// =============================================================================
// VELO Frontend -- ConsolePracticesView screen tests (FE-262, slice 3)
// =============================================================================
//
// The list is a Pinia Colada query per (scope, page) over getAdminPractices;
// the seam mocked here is @/api/admin. The screen mounts with a real router
// (memory history: the scope and the page live in the URL), a real Pinia and
// Colada, as in production. The clock is frozen so the relative day label of
// a row never depends on the day the suite runs.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { coladaOptions } from '@/composables/queries/setup'
import ConsolePracticesView from '@/views/console/ConsolePracticesView.vue'
import * as adminApi from '@/api/admin'
import { ApiResponseError } from '@/api/client'
import type { AdminPracticeListItem, PaginatedAdminPracticesResponse } from '@/api/types'

vi.mock('@/api/admin')

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, info: vi.fn(), success: vi.fn() }),
}))

// The window width classes (components/console/content/useConsoleWidth.ts):
// happy-dom is 1024 px wide, so the test sets them. Default: the wide layout.
const width = vi.hoisted(() => ({ narrow: false, medium: false }))
vi.mock('@/components/console/content/useConsoleWidth', async () => {
  const { ref } = await import('vue')
  return { useConsoleWidth: () => ({ narrow: ref(width.narrow), medium: ref(width.medium) }) }
})

const NOW = new Date('2026-11-24T10:00:00Z')

function practice(overrides: Partial<AdminPracticeListItem> = {}): AdminPracticeListItem {
  return {
    id: 'p_1',
    title: 'Утренняя медитация',
    direction: 'meditation',
    master_name: 'Анна Лебедева',
    master_verified: true,
    scheduled_at: '2026-12-20T07:00:00Z',
    duration_minutes: 60,
    booked: 5,
    capacity: 10,
    status: 'upcoming',
    timezone: 'Europe/Moscow',
    ...overrides,
  }
}

/** `count` distinguishable practices, ids and titles numbered from `from`. */
function items(count: number, from = 1): AdminPracticeListItem[] {
  return Array.from({ length: count }, (_, i) =>
    practice({ id: `p_${from + i}`, title: `Практика ${from + i}` }),
  )
}

function answer(
  list: AdminPracticeListItem[],
  total = list.length,
  offset = 0,
): PaginatedAdminPracticesResponse {
  return { items: list, total, limit: 20, offset }
}

let app: App | null = null
let host: HTMLElement | null = null
let router: Router

async function mount(url = '/console/practices'): Promise<HTMLElement> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/console/practices', name: 'console-practices', component: { render: () => null } },
      {
        path: '/console/practices/:id',
        name: 'console-practices-detail',
        component: { render: () => null },
      },
    ],
  })
  await router.push(url)
  await router.isReady()
  host = document.createElement('div')
  document.body.appendChild(host)
  const pinia = createPinia()
  setActivePinia(pinia)
  app = createApp(ConsolePracticesView)
    .use(createTestI18n())
    .use(router)
    .use(pinia)
    .use(PiniaColada, coladaOptions)
  app.mount(host)
  await flush()
  return host
}

async function flush(): Promise<void> {
  for (let n = 0; n < 6; n++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

function rowTitles(): string[] {
  return Array.from(
    host?.querySelectorAll('[data-testid="console-table-row"] .console-practices__title') ?? [],
  ).map((el) => el.textContent?.trim() ?? '')
}
function tab(label: string): HTMLButtonElement {
  const found = Array.from(host?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []).find(
    (el) => el.textContent?.trim().startsWith(label),
  )
  if (!found) throw new Error(`no tab ${label}`)
  return found
}
function pageButton(n: number): HTMLButtonElement | undefined {
  return host?.querySelector<HTMLButtonElement>(`button[aria-label="Страница ${n}"]`) ?? undefined
}

beforeEach(() => {
  width.narrow = false
  width.medium = false
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.mocked(adminApi.getAdminPractices)
    .mockReset()
    .mockResolvedValue(answer(items(2)))
  toastError.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.useRealTimers()
})

describe('ConsolePracticesView', () => {
  it('shows the first page of the upcoming practices: when, practice, master, seats', async () => {
    vi.mocked(adminApi.getAdminPractices).mockResolvedValue(
      answer([
        practice({ id: 'p_a', title: 'Утренняя медитация', booked: 5, capacity: 10 }),
        practice({
          id: 'p_b',
          title: 'Открытый круг',
          direction: null,
          master_name: 'Олег Ким',
          booked: 3,
          capacity: null,
          duration_minutes: 45,
        }),
      ]),
    )
    await mount()

    expect(adminApi.getAdminPractices).toHaveBeenCalledWith('upcoming', 20, 0)
    // One entry per cell; a cell's two lines are its spans.
    const rows = Array.from(host?.querySelectorAll('[data-testid="console-table-row"]') ?? []).map(
      (row) =>
        Array.from(row.querySelectorAll('[role="cell"]')).map((cell) =>
          Array.from(cell.querySelectorAll('span'))
            .filter((el) => el.children.length === 0 && el.textContent?.trim())
            .map((el) => el.textContent?.trim()),
        ),
    )
    expect(rows).toEqual([
      [
        ['20 декабря, 10:00', '60 мин'],
        ['Утренняя медитация', 'Медитация'],
        ['АЛ', 'Анна Лебедева'],
        ['5 / 10'],
      ],
      [['20 декабря, 10:00', '45 мин'], ['Открытый круг'], ['ОК', 'Олег Ким'], ['3 / ∞']],
    ])
    // The active tab carries the answer's total.
    expect(tab('Предстоящие').textContent).toContain('2')
  })

  it('on a narrow screen the master column goes and the master moves under the title', async () => {
    width.narrow = true
    await mount()

    const headers = Array.from(host?.querySelectorAll('[role="columnheader"]') ?? []).map((el) =>
      el.textContent?.trim(),
    )
    expect(headers).toEqual(['Когда', 'Практика', 'Записано'])
    const titleCell = host?.querySelectorAll('[data-testid="console-table-row"] [role="cell"]')[1]
    expect(titleCell?.querySelector('.console-practices__sub')?.textContent).toBe(
      'Медитация · Анна Лебедева',
    )
    expect(host?.querySelector('.v-avatar')).toBeNull()
  })

  it('a scope tab asks that scope from its first page; the old rows do not stand in', async () => {
    await mount('/console/practices?scope=upcoming&page=2')
    expect(adminApi.getAdminPractices).toHaveBeenLastCalledWith('upcoming', 20, 20)

    let resolvePast!: (value: PaginatedAdminPracticesResponse) => void
    vi.mocked(adminApi.getAdminPractices).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePast = resolve
        }),
    )
    tab('Прошедшие').click()
    await flush()

    expect(adminApi.getAdminPractices).toHaveBeenLastCalledWith('past', 20, 0)
    expect(router.currentRoute.value.query).toEqual({ scope: 'past' })
    expect(rowTitles()).toEqual([])
    expect(host?.querySelector('[data-testid="console-practices-loading"]')).not.toBeNull()

    resolvePast(answer([practice({ id: 'p_old', title: 'Прошлая практика', status: 'past' })]))
    await flush()
    expect(rowTitles()).toEqual(['Прошлая практика'])
  })

  it('pages: the summary and the buttons follow the total, a page button loads its offset', async () => {
    vi.mocked(adminApi.getAdminPractices).mockImplementation(async (_scope, _limit, offset) =>
      answer(items(20, (offset ?? 0) + 1), 45, offset ?? 0),
    )
    await mount()

    expect(host?.querySelector('[data-testid="console-pager-summary"]')?.textContent).toBe(
      'Показано 1–20 из 45',
    )
    expect(pageButton(3)).toBeDefined()
    expect(pageButton(4)).toBeUndefined()

    pageButton(2)?.click()
    await flush()

    expect(adminApi.getAdminPractices).toHaveBeenLastCalledWith('upcoming', 20, 20)
    expect(router.currentRoute.value.query).toEqual({ scope: 'upcoming', page: '2' })
    expect(rowTitles()[0]).toBe('Практика 21')
    expect(host?.querySelector('[data-testid="console-pager-summary"]')?.textContent).toBe(
      'Показано 21–40 из 45',
    )
    expect(pageButton(2)?.getAttribute('aria-current')).toBe('page')
  })

  it('one page of results: the summary, no page buttons', async () => {
    await mount()

    expect(host?.querySelector('[data-testid="console-pager-summary"]')?.textContent).toBe(
      'Показано 1–2 из 2',
    )
    expect(host?.querySelector('.console-pager__pages')).toBeNull()
  })

  it('a scope or page the URL cannot mean falls back to the first page of the upcoming', async () => {
    await mount('/console/practices?scope=archive&page=-3')

    expect(adminApi.getAdminPractices).toHaveBeenCalledWith('upcoming', 20, 0)
  })

  it('a row opens the practice', async () => {
    await mount()

    host?.querySelectorAll<HTMLElement>('[data-testid="console-table-row"]')[1]?.click()
    await flush()

    expect(router.currentRoute.value.name).toBe('console-practices-detail')
    expect(router.currentRoute.value.params.id).toBe('p_2')
  })

  it('says so when there are no practices', async () => {
    vi.mocked(adminApi.getAdminPractices).mockResolvedValue(answer([]))
    await mount()

    expect(host?.textContent).toContain('Практик здесь пока нет')
    expect(host?.querySelector('[data-testid="console-pager-summary"]')).toBeNull()
  })

  it('a failed first load shows the error and Retry recovers', async () => {
    vi.mocked(adminApi.getAdminPractices).mockRejectedValueOnce(
      new ApiResponseError(500, 'Сервер недоступен', 'server_error'),
    )
    await mount()

    expect(host?.querySelector('.v-empty__title')?.textContent).toBe(
      'Не удалось загрузить практики',
    )
    expect(rowTitles()).toEqual([])

    const retry = Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-btn') ?? []).find(
      (b) => b.textContent?.trim() === 'Повторить',
    )
    retry?.click()
    await flush()

    expect(host?.querySelector('.v-empty__title')).toBeNull()
    expect(rowTitles()).toEqual(['Практика 1', 'Практика 2'])
  })
})
