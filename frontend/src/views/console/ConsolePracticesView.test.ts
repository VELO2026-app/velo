// =============================================================================
// VELO Frontend -- ConsolePracticesView screen tests (FE-262, slice 3)
// =============================================================================
//
// The list is a Pinia Colada query per (scope, page) over getAdminPractices;
// the seam mocked here is @/api/admin. `server` below is the backend: every
// scope's practices NEWEST FIRST (as GET /admin/practices answers), sliced by
// limit and offset. The screen mounts with a real router (memory history: the
// scope and the page live in the URL), a real Pinia and Colada, as in
// production. The clock is frozen so the relative day label of a row never
// depends on the day the suite runs.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { PiniaColada, useQueryCache } from '@pinia/colada'
import { coladaOptions } from '@/composables/queries/setup'
import { adminKeys } from '@/composables/queries/adminKeys'
import ConsolePracticesView from '@/views/console/ConsolePracticesView.vue'
import * as adminApi from '@/api/admin'
import { ApiResponseError } from '@/api/client'
import type { AdminPracticeListItem } from '@/api/types'

vi.mock('@/api/admin')

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, info: vi.fn(), success: vi.fn() }),
}))

// The window width classes (composables/useConsoleWidth.ts): happy-dom is
// 1024 px wide, so the test sets them. Default: the wide layout.
const width = vi.hoisted(() => ({ narrow: false, medium: false }))
vi.mock('@/composables/useConsoleWidth', async () => {
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

/** `count` distinguishable practices, newest first (titles numbered from `count` down to 1). */
/** Practice n is n hours after the first: `count` of them, newest first as the backend has listed them. */
function newestFirst(count: number): AdminPracticeListItem[] {
  return Array.from({ length: count }, (_, i) => {
    const n = count - i
    return practice({
      id: `p_${n}`,
      title: `Практика ${n}`,
      scheduled_at: new Date(Date.UTC(2026, 11, 20, 7 + n)).toISOString(),
    })
  })
}

/** The same practices nearest first, as BE-257 lists the upcoming scope. */
function ascending(count: number): AdminPracticeListItem[] {
  return newestFirst(count).reverse()
}

type Scope = 'all' | 'upcoming' | 'past'
/** The backend: each scope's practices, newest first. */
let server: Record<Scope, AdminPracticeListItem[]>

let app: App | null = null
let host: HTMLElement | null = null
let router: Router
let pinia: Pinia

async function mount(url = '/admin/practices'): Promise<HTMLElement> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/admin/practices', name: 'console-practices', component: { render: () => null } },
      {
        path: '/admin/practices/:id',
        name: 'console-practices-detail',
        component: { render: () => null },
      },
    ],
  })
  await router.push(url)
  await router.isReady()
  host = document.createElement('div')
  document.body.appendChild(host)
  pinia = createPinia()
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
function summary(): string | undefined {
  return host?.querySelector('[data-testid="console-pager-summary"]')?.textContent ?? undefined
}
/** A background refetch of every list held, as a return to the app does. */
async function refetchInBackground(): Promise<void> {
  useQueryCache(pinia)
    .invalidateQueries({ key: adminKeys.practicesAll() })
    .catch(() => {})
  await flush()
}

beforeEach(() => {
  width.narrow = false
  width.medium = false
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  server = { upcoming: newestFirst(2), past: newestFirst(2), all: newestFirst(2) }
  vi.mocked(adminApi.getAdminPractices)
    .mockReset()
    .mockImplementation(async (scope = 'all', limit = 20, offset = 0) => ({
      items: server[scope].slice(offset, offset + limit),
      total: server[scope].length,
      limit,
      offset,
    }))
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
  it('shows the nearest upcoming practices first: when, practice, master, seats', async () => {
    // The backend lists newest first: the far one comes before the near one.
    server.upcoming = [
      practice({
        id: 'p_far',
        title: 'Открытый круг',
        direction: null,
        master_name: 'Олег Ким',
        booked: 3,
        capacity: null,
        duration_minutes: 45,
        scheduled_at: '2026-12-28T07:00:00Z',
      }),
      practice({ id: 'p_near', title: 'Утренняя медитация', booked: 5, capacity: 10 }),
    ]
    await mount()

    // One cell per entry; a cell's two lines are its spans.
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
      [['28 декабря, 10:00', '45 мин'], ['Открытый круг'], ['ОК', 'Олег Ким'], ['3 / ∞']],
    ])
    // The active tab carries the answer's total; the others do not know theirs.
    expect(
      Array.from(host?.querySelectorAll('[role="tab"]') ?? []).map((el) => el.textContent?.trim()),
    ).toEqual(['Предстоящие · 2', 'Прошедшие', 'Все'])
  })

  it('pages the upcoming scope from the end: page 1 is the nearest, the last page the farthest', async () => {
    server.upcoming = newestFirst(45)
    await mount()

    // Page 1 of 3: the 20 nearest, nearest first (the slice at offset 25 of the newest-first list).
    expect(adminApi.getAdminPractices).toHaveBeenCalledWith('upcoming', 20, 25)
    expect(rowTitles()[0]).toBe('Практика 1')
    expect(rowTitles()).toHaveLength(20)
    expect(rowTitles()[19]).toBe('Практика 20')
    expect(summary()).toBe('Показано 1–20 из 45')

    pageButton(3)?.click()
    await flush()

    expect(adminApi.getAdminPractices).toHaveBeenLastCalledWith('upcoming', 5, 0)
    expect(rowTitles()).toEqual([
      'Практика 41',
      'Практика 42',
      'Практика 43',
      'Практика 44',
      'Практика 45',
    ])
    expect(summary()).toBe('Показано 41–45 из 45')
  })

  it('pages an upcoming scope the API lists nearest first (BE-257) from the start, the same pages', async () => {
    server.upcoming = ascending(45)
    await mount()

    expect(adminApi.getAdminPractices).toHaveBeenCalledWith('upcoming', 20, 0)
    expect(rowTitles()).toHaveLength(20)
    expect(rowTitles()[0]).toBe('Практика 1')
    expect(rowTitles()[19]).toBe('Практика 20')
    expect(summary()).toBe('Показано 1–20 из 45')

    pageButton(3)?.click()
    await flush()

    expect(adminApi.getAdminPractices).toHaveBeenLastCalledWith('upcoming', 5, 40)
    expect(rowTitles()).toEqual([
      'Практика 41',
      'Практика 42',
      'Практика 43',
      'Практика 44',
      'Практика 45',
    ])
  })

  it('sorts a page by date itself, whatever order its rows arrive in', async () => {
    const [p1, p2, p3] = ascending(3)
    if (!p1 || !p2 || !p3) throw new Error('fixture')
    server.upcoming = [p1, p3, p2]
    await mount()

    expect(rowTitles()).toEqual(['Практика 1', 'Практика 2', 'Практика 3'])
  })

  it('pages the past scope as the API lists it: a page button loads its offset', async () => {
    server.past = newestFirst(45)
    await mount('/admin/practices?scope=past')

    expect(summary()).toBe('Показано 1–20 из 45')
    expect(rowTitles()[0]).toBe('Практика 45')
    expect(pageButton(3)).toBeDefined()
    expect(pageButton(4)).toBeUndefined()

    pageButton(2)?.click()
    await flush()

    expect(adminApi.getAdminPractices).toHaveBeenLastCalledWith('past', 20, 20)
    expect(router.currentRoute.value.query).toEqual({ scope: 'past', page: '2' })
    expect(rowTitles()[0]).toBe('Практика 25')
    expect(summary()).toBe('Показано 21–40 из 45')
    expect(pageButton(2)?.getAttribute('aria-current')).toBe('page')
  })

  it('a scope tab asks that scope from its first page; the old rows do not stand in', async () => {
    await mount('/admin/practices?scope=all&page=2')
    server.all = newestFirst(45)

    let resolvePast!: (value: Awaited<ReturnType<typeof adminApi.getAdminPractices>>) => void
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

    resolvePast({
      items: [practice({ id: 'p_old', title: 'Прошлая практика', status: 'past' })],
      total: 1,
      limit: 20,
      offset: 0,
    })
    await flush()
    expect(rowTitles()).toEqual(['Прошлая практика'])
  })

  it('one page of results: the summary, no page buttons', async () => {
    await mount()

    expect(summary()).toBe('Показано 1–2 из 2')
    expect(host?.querySelector('.console-pager__pages')).toBeNull()
  })

  it('a scope or page the URL cannot mean falls back to the first page of the upcoming', async () => {
    await mount('/admin/practices?scope=archive&page=-3')

    expect(adminApi.getAdminPractices).toHaveBeenCalledWith('upcoming', 2, 0)
    expect(vi.mocked(adminApi.getAdminPractices).mock.calls.map(([scope]) => scope)).not.toContain(
      'archive',
    )
  })

  it.each([
    // 45 rows are 3 pages: page 9 goes to the last, an empty list to the first.
    {
      url: '/admin/practices?scope=past&page=9',
      total: 45,
      query: { scope: 'past', page: '3' },
      shown: 'Показано 41–45 из 45',
    },
    {
      url: '/admin/practices?scope=past&page=2',
      total: 0,
      query: { scope: 'past' },
      shown: undefined,
    },
  ])(
    'a page past the end ($url, $total rows) goes to the last page',
    async ({ url, total, query, shown }) => {
      server.past = newestFirst(total)
      await mount(url)

      expect(router.currentRoute.value.query).toEqual(query)
      expect(summary()).toBe(shown)
    },
  )

  it('a row opens the practice', async () => {
    await mount()

    host?.querySelectorAll<HTMLElement>('[data-testid="console-table-row"]')[1]?.click()
    await flush()

    expect(router.currentRoute.value.name).toBe('console-practices-detail')
    // Nearest first: the second row is the second nearest practice (p_2).
    expect(router.currentRoute.value.params.id).toBe('p_2')
  })

  it('says so when there are no practices', async () => {
    server.upcoming = []
    await mount()

    expect(host?.textContent).toContain('Практик здесь пока нет')
    expect(summary()).toBeUndefined()
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

  describe('load failures', () => {
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

  describe('background refetch (a return to the app)', () => {
    it('keeps the rows on screen while it runs, then shows the fresh answer', async () => {
      await mount('/admin/practices?scope=past')
      expect(rowTitles()).toEqual(['Практика 2', 'Практика 1'])

      let resolveFresh!: (value: Awaited<ReturnType<typeof adminApi.getAdminPractices>>) => void
      vi.mocked(adminApi.getAdminPractices).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFresh = resolve
          }),
      )
      await refetchInBackground()

      // No loader, the cached rows stay.
      expect(host?.querySelector('[data-testid="console-practices-loading"]')).toBeNull()
      expect(rowTitles()).toEqual(['Практика 2', 'Практика 1'])

      resolveFresh({
        items: [practice({ id: 'p_new', title: 'Новая практика' })],
        total: 1,
        limit: 20,
        offset: 0,
      })
      await flush()
      expect(rowTitles()).toEqual(['Новая практика'])
      expect(toastError).not.toHaveBeenCalled()
    })

    it('failing again and again is told once, until an answer arrives; the rows stay', async () => {
      await mount('/admin/practices?scope=past')
      vi.mocked(adminApi.getAdminPractices).mockImplementation(() =>
        Promise.reject(new Error('down')),
      )

      await refetchInBackground()
      await refetchInBackground()

      expect(toastError).toHaveBeenCalledTimes(1)
      expect(toastError).toHaveBeenCalledWith('Не удалось загрузить практики')
      expect(rowTitles()).toEqual(['Практика 2', 'Практика 1'])
      expect(host?.querySelector('.v-empty__title')).toBeNull()

      // An answer arrives, then a new failure is told again.
      vi.mocked(adminApi.getAdminPractices).mockImplementation(async (scope = 'all') => ({
        items: server[scope],
        total: server[scope].length,
        limit: 20,
        offset: 0,
      }))
      await refetchInBackground()
      vi.mocked(adminApi.getAdminPractices).mockImplementation(() =>
        Promise.reject(new Error('down again')),
      )
      await refetchInBackground()

      expect(toastError).toHaveBeenCalledTimes(2)
    })
  })
})
