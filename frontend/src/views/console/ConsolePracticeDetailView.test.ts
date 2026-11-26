// =============================================================================
// VELO Frontend -- ConsolePracticeDetailView screen tests (FE-262, slice 3)
// =============================================================================
//
// Two Colada queries over @/api/admin (getAdminPracticeDetail, and
// getAdminZoomAttendance once the Zoom tab is opened). The screen mounts with
// a real router (web history: the way back reads `history.state.back`; the
// practice id is a route param), a real Pinia and Colada. The clock is frozen: dates in the fixtures sit far from
// "today", so no relative day label can appear.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createRouter, createWebHistory, type Router } from 'vue-router'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { PiniaColada, useQueryCache, type EntryKey } from '@pinia/colada'
import { coladaOptions } from '@/composables/queries/setup'
import { adminKeys } from '@/composables/queries/adminKeys'
import ConsolePracticeDetailView from '@/views/console/ConsolePracticeDetailView.vue'
import * as adminApi from '@/api/admin'
import { ApiResponseError } from '@/api/client'
import type { AdminPracticeDetailResponse, AdminRosterEntry } from '@/api/types'

vi.mock('@/api/admin')

// The instance options: the Zoom attendance is the zoom option's.
const options = vi.hoisted(() => ({ zoom: true }))
vi.mock('@/platform/instance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/platform/instance')>()),
  isOptionEnabled: (name: string) => (name === 'zoom' ? options.zoom : true),
}))

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, info: vi.fn(), success: vi.fn() }),
}))

// The window width classes (composables/useConsoleWidth.ts):
// happy-dom is 1024 px wide, so the test sets them. Default: the wide layout.
const width = vi.hoisted(() => ({ narrow: false, medium: false }))
vi.mock('@/composables/useConsoleWidth', async () => {
  const { ref } = await import('vue')
  return { useConsoleWidth: () => ({ narrow: ref(width.narrow), medium: ref(width.medium) }) }
})

const NOW = new Date('2026-11-24T10:00:00Z')

function entry(overrides: Partial<AdminRosterEntry>): AdminRosterEntry {
  return { user_id: 'u_1', name: 'Участник', avatar_url: null, status: 'confirmed', ...overrides }
}

/** A finished practice: one participant per booking status, and one status nobody knows. */
const ROSTER: AdminRosterEntry[] = [
  entry({ user_id: 'u_att', name: 'Ксения Морозова', status: 'attended' }),
  entry({ user_id: 'u_no', name: 'Никита Белов', status: 'no_show' }),
  entry({ user_id: 'u_conf', name: 'Юлия Титова', status: 'confirmed' }),
  entry({ user_id: 'u_pend', name: 'Павел Волков', status: 'pending' }),
  entry({ user_id: 'u_odd', name: 'Роман Акулов', status: 'refunded' }),
]

function detail(overrides: Partial<AdminPracticeDetailResponse> = {}): AdminPracticeDetailResponse {
  return {
    id: 'p_1',
    title: 'Утренняя медитация',
    direction: 'meditation',
    master_name: 'Анна Лебедева',
    master_verified: true,
    scheduled_at: '2026-03-02T07:00:00Z',
    duration_minutes: 60,
    booked: 5,
    capacity: 15,
    status: 'past',
    timezone: 'Europe/Moscow',
    attended: 1,
    roster: ROSTER,
    ...overrides,
  }
}

function zoomAnswer(
  overrides: Partial<adminApi.AdminZoomAttendanceResponse> = {},
): adminApi.AdminZoomAttendanceResponse {
  return {
    practice_id: 'p_1',
    zoom_meeting_status: 'active',
    report_ingested: true,
    bookings: [
      {
        booking_id: 'b_1',
        user_id: 'u_att',
        user_name: 'Ксения Морозова',
        status: 'attended',
        zoom_minutes_present: 58,
        attendance_decided_via: 'zoom_report',
      },
      {
        booking_id: 'b_2',
        user_id: 'u_no',
        user_name: 'Никита Белов',
        status: 'no_show',
        zoom_minutes_present: null,
        attendance_decided_via: 'legacy_proxy',
      },
    ],
    unmatched: [
      {
        segment_id: 's_1',
        user_email: 'guest@example.com',
        join_time: '2026-03-02T07:02:00Z',
        leave_time: '2026-03-02T07:12:00Z',
        duration_seconds: 600,
      },
      {
        segment_id: 's_2',
        user_email: null,
        join_time: null,
        leave_time: null,
        duration_seconds: null,
      },
    ],
    unmatched_count: 2,
    last_sync_error: null,
    ...overrides,
  }
}

let app: App | null = null
let host: HTMLElement | null = null
let router: Router
let pinia: Pinia

/** Open the practice; `from` is a list address visited before it (the way the admin came). */
async function mount(from?: string): Promise<HTMLElement> {
  window.history.replaceState(null, '', '/')
  router = createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/admin/practices', name: 'console-practices', component: { render: () => null } },
      {
        path: '/admin/practices/:id',
        name: 'console-practices-detail',
        component: { render: () => null },
      },
    ],
  })
  if (from !== undefined) await router.push(from)
  await router.push('/admin/practices/p_1')
  await router.isReady()
  host = document.createElement('div')
  document.body.appendChild(host)
  pinia = createPinia()
  setActivePinia(pinia)
  app = createApp(ConsolePracticeDetailView)
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

function statValues(): Record<string, string> {
  return Object.fromEntries(
    Array.from(host?.querySelectorAll('.console-stat') ?? []).map((el) => [
      el.querySelector('.console-stat__label')?.textContent?.trim() ?? '',
      el.querySelector('.console-stat__value')?.textContent?.trim() ?? '',
    ]),
  )
}
/** A table's rows as arrays of cell texts (an avatar's initials are not text of the cell). */
function tableRows(label: string): string[][] {
  const table = host?.querySelector(`[role="table"][aria-label="${label}"]`)
  return Array.from(table?.querySelectorAll('[data-testid="console-table-row"]') ?? []).map((row) =>
    Array.from(row.querySelectorAll('[role="cell"]')).map((cell) => {
      const copy = cell.cloneNode(true) as HTMLElement
      copy.querySelectorAll('.v-avatar').forEach((avatar) => avatar.remove())
      return (copy.textContent ?? '').replace(/\s+/g, ' ').trim()
    }),
  )
}
function button(text: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((b) =>
    b.textContent?.trim().startsWith(text),
  )
}
async function openZoomTab(): Promise<void> {
  button('Посещаемость Zoom')?.click()
  await flush()
}
/** A background refetch of what is held under a key prefix, as a return to the app does. */
async function refetchInBackground(key: EntryKey): Promise<void> {
  useQueryCache(pinia)
    .invalidateQueries({ key })
    .catch(() => {})
  await flush()
}

beforeEach(() => {
  options.zoom = true
  width.narrow = false
  width.medium = false
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.mocked(adminApi.getAdminPracticeDetail).mockReset().mockResolvedValue(detail())
  vi.mocked(adminApi.getAdminZoomAttendance).mockReset().mockResolvedValue(zoomAnswer())
  toastError.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.useRealTimers()
})

describe('ConsolePracticeDetailView', () => {
  it('a finished practice: figures, participants with their booking status, the practice data', async () => {
    await mount()

    expect(adminApi.getAdminPracticeDetail).toHaveBeenCalledWith('p_1')
    expect(host?.querySelector('h1')?.textContent).toBe('Утренняя медитация')
    expect(host?.querySelector('[data-testid="practice-state"]')?.textContent?.trim()).toBe(
      'Завершена',
    )
    expect(statValues()).toEqual({ Записано: '5', Был: '1', 'Не пришёл': '1' })
    expect(
      Array.from(host?.querySelectorAll('[role="tab"]') ?? []).map((el) => el.textContent?.trim()),
    ).toEqual(['Участники · 5', 'Посещаемость Zoom'])
    expect(tableRows('Участники практики')).toEqual([
      ['Ксения Морозова', 'Был'],
      ['Никита Белов', 'Не пришёл'],
      ['Юлия Титова', 'Записан'],
      ['Павел Волков', 'Ожидает'],
      // A status the screen does not know is shown as it came.
      ['Роман Акулов', 'refunded'],
    ])
    const about = Array.from(host?.querySelectorAll('.practice-detail__side dl > div') ?? []).map(
      (row) => [
        row.querySelector('dt')?.textContent?.trim(),
        row.querySelector('dd')?.textContent?.trim(),
      ],
    )
    expect(about).toEqual([
      ['Когда', '2 марта, 10:00'],
      ['Длительность', '60 мин'],
      ['Мастер', 'Анна Лебедева'],
      ['Направление', 'Медитация'],
      ['Мест', '15'],
    ])
  })

  it('a practice ahead: booked and free seats, no attendance figures', async () => {
    vi.mocked(adminApi.getAdminPracticeDetail).mockResolvedValue(
      detail({ status: 'upcoming', booked: 4, capacity: 10, roster: ROSTER.slice(2, 4) }),
    )
    await mount()

    expect(host?.querySelector('[data-testid="practice-state"]')?.textContent?.trim()).toBe(
      'Предстоит',
    )
    expect(statValues()).toEqual({ Записано: '4', Свободно: '6' })
  })

  it('a first load shows the loader, then the participants (FE-260)', async () => {
    let answer!: (value: AdminPracticeDetailResponse) => void
    vi.mocked(adminApi.getAdminPracticeDetail).mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    await mount()

    expect(host?.querySelector('[data-testid="practice-loading"]')).not.toBeNull()
    expect(host?.textContent).not.toContain('Пока никто не записался')

    answer(detail({ status: 'upcoming', booked: 0, capacity: null, roster: [] }))
    await flush()

    expect(host?.querySelector('[data-testid="practice-loading"]')).toBeNull()
    expect(host?.textContent).toContain('Пока никто не записался')
  })

  it('a practice with no seat limit: free seats are the infinity sign; an empty roster says so', async () => {
    vi.mocked(adminApi.getAdminPracticeDetail).mockResolvedValue(
      detail({ status: 'upcoming', booked: 0, capacity: null, roster: [] }),
    )
    await mount()

    expect(statValues()).toEqual({ Записано: '0', Свободно: '∞' })
    expect(host?.textContent).toContain('Пока никто не записался')
  })

  it('a failed load shows the error and Retry recovers', async () => {
    vi.mocked(adminApi.getAdminPracticeDetail).mockRejectedValueOnce(
      new ApiResponseError(500, 'Сервер недоступен', 'server_error'),
    )
    await mount()

    expect(host?.querySelector('.v-empty__title')?.textContent).toBe(
      'Не удалось загрузить практику',
    )
    expect(host?.querySelector('[role="table"]')).toBeNull()

    button('Повторить')?.click()
    await flush()

    expect(host?.querySelector('.v-empty__title')).toBeNull()
    expect(tableRows('Участники практики')).toHaveLength(5)
  })

  it('a 404 is "not found", with no Retry', async () => {
    vi.mocked(adminApi.getAdminPracticeDetail).mockRejectedValue(
      new ApiResponseError(404, 'Практика не найдена', 'not_found'),
    )
    await mount()

    expect(host?.querySelector('[data-testid="practice-not-found"]')).not.toBeNull()
    expect(host?.querySelector('.v-empty__title')?.textContent).toBe('Практика не найдена')
    expect(button('Повторить')).toBeUndefined()
  })

  describe('background refetch (a return to the app)', () => {
    it('keeps the practice on screen while it runs, then shows the fresh answer', async () => {
      await mount()

      let resolveFresh!: (value: AdminPracticeDetailResponse) => void
      vi.mocked(adminApi.getAdminPracticeDetail).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFresh = resolve
          }),
      )
      await refetchInBackground(adminKeys.practiceAll())

      expect(host?.querySelector('[data-testid="practice-loading"]')).toBeNull()
      expect(statValues()).toEqual({ Записано: '5', Был: '1', 'Не пришёл': '1' })

      resolveFresh(detail({ booked: 9, attended: 4, roster: ROSTER.slice(0, 2) }))
      await flush()
      expect(statValues()).toEqual({ Записано: '9', Был: '4', 'Не пришёл': '1' })
      expect(toastError).not.toHaveBeenCalled()
    })

    it('failing again and again is told once, until an answer arrives; the practice stays', async () => {
      await mount()
      vi.mocked(adminApi.getAdminPracticeDetail).mockImplementation(() =>
        Promise.reject(new Error('down')),
      )

      await refetchInBackground(adminKeys.practiceAll())
      await refetchInBackground(adminKeys.practiceAll())

      expect(toastError).toHaveBeenCalledTimes(1)
      expect(toastError).toHaveBeenCalledWith('Не удалось загрузить практику')
      expect(tableRows('Участники практики')).toHaveLength(5)
      expect(host?.querySelector('.v-empty__title')).toBeNull()

      vi.mocked(adminApi.getAdminPracticeDetail).mockResolvedValue(detail())
      await refetchInBackground(adminKeys.practiceAll())
      vi.mocked(adminApi.getAdminPracticeDetail).mockImplementation(() =>
        Promise.reject(new Error('down again')),
      )
      await refetchInBackground(adminKeys.practiceAll())

      expect(toastError).toHaveBeenCalledTimes(2)
    })

    it('a failed refetch over a practice shown is not "not found"', async () => {
      await mount()
      vi.mocked(adminApi.getAdminPracticeDetail).mockRejectedValue(
        new ApiResponseError(404, 'Практика не найдена', 'not_found'),
      )

      await refetchInBackground(adminKeys.practiceAll())

      expect(host?.querySelector('[data-testid="practice-not-found"]')).toBeNull()
      expect(tableRows('Участники практики')).toHaveLength(5)
    })
  })

  describe('"Back"', () => {
    it('returns to the list the admin came from, with its tab and page', async () => {
      await mount('/admin/practices?scope=all&page=3')

      button('К практикам')?.click()
      await flush()

      expect(router.currentRoute.value.name).toBe('console-practices')
      expect(router.currentRoute.value.query).toEqual({ scope: 'all', page: '3' })
    })

    it('after a deep link goes to the tab the practice belongs to', async () => {
      await mount()

      button('К практикам')?.click()
      await flush()

      expect(router.currentRoute.value.name).toBe('console-practices')
      expect(router.currentRoute.value.query).toEqual({ scope: 'past' })
    })
  })

  describe('Zoom attendance', () => {
    it('has no tab on an instance without the zoom option', async () => {
      options.zoom = false
      await mount()

      const tabs = Array.from(host?.querySelectorAll('[role="tab"]') ?? []).map((tab) =>
        tab.textContent?.replace(/\s+/g, ' ').trim(),
      )
      expect(tabs).toEqual([expect.stringContaining('Участники')])
    })

    it('is asked only when its tab opens, then shows the meeting, the matches and the leftovers', async () => {
      await mount()
      expect(adminApi.getAdminZoomAttendance).not.toHaveBeenCalled()

      await openZoomTab()

      expect(adminApi.getAdminZoomAttendance).toHaveBeenCalledWith('p_1')
      expect(host?.querySelector('[data-testid="zoom-meeting-status"]')?.textContent?.trim()).toBe(
        'Активна',
      )
      expect(host?.querySelector('[data-testid="zoom-unmatched-count"]')?.textContent?.trim()).toBe(
        '2',
      )
      expect(host?.querySelector('[data-testid="zoom-last-error"]')).toBeNull()
      expect(tableRows('Посещаемость участников в Zoom')).toEqual([
        ['Ксения Морозова', 'Был', '58 мин', 'По отчёту Zoom'],
        ['Никита Белов', 'Не пришёл', '—', 'По входу и отметке'],
      ])
      expect(tableRows('Строки Zoom без участника')).toEqual([
        ['guest@example.com', '2 марта, 10:02', '2 марта, 10:12', '10 мин'],
        ['Почты нет', '—', '—', '—'],
      ])
      // The participants table gave way to the Zoom tab.
      expect(host?.querySelector('[aria-label="Участники практики"]')).toBeNull()
    })

    it('on a screen under 1400 px the Zoom tables drop their secondary columns', async () => {
      width.medium = true
      await mount()
      await openZoomTab()

      expect(tableRows('Посещаемость участников в Zoom')).toEqual([
        ['Ксения Морозова', 'Был', '58 мин'],
        ['Никита Белов', 'Не пришёл', '—'],
      ])
      expect(tableRows('Строки Zoom без участника')).toEqual([
        ['guest@example.com', '2 марта, 10:02', '10 мин'],
        ['Почты нет', '—', '—'],
      ])
    })

    it('a meeting never created, and the error the sync recorded', async () => {
      vi.mocked(adminApi.getAdminZoomAttendance).mockResolvedValue(
        zoomAnswer({
          zoom_meeting_status: null,
          report_ingested: false,
          bookings: [],
          unmatched: [],
          unmatched_count: 0,
          last_sync_error: 'zoom api: 429',
        }),
      )
      await mount()
      await openZoomTab()

      expect(host?.querySelector('[data-testid="zoom-meeting-status"]')?.textContent?.trim()).toBe(
        'Не создана',
      )
      expect(host?.querySelector('[data-testid="zoom-last-error"]')?.textContent?.trim()).toBe(
        'zoom api: 429',
      )
      expect(host?.textContent).toContain('Нет записей для сверки')
      // No leftovers: no table for them.
      expect(host?.querySelector('[aria-label="Строки Zoom без участника"]')).toBeNull()
    })

    it('a failed refetch over Zoom data shown keeps it and is told once', async () => {
      await mount()
      await openZoomTab()
      vi.mocked(adminApi.getAdminZoomAttendance).mockImplementation(() =>
        Promise.reject(new Error('down')),
      )

      await refetchInBackground(adminKeys.practiceAll())
      await refetchInBackground(adminKeys.practiceAll())

      expect(toastError).toHaveBeenCalledTimes(1)
      expect(toastError).toHaveBeenCalledWith('Не удалось загрузить посещаемость Zoom')
      expect(host?.querySelector('[data-testid="zoom-meeting-status"]')).not.toBeNull()
    })

    it('a failed read is an error with Retry, not "no Zoom data"; the participants stay', async () => {
      vi.mocked(adminApi.getAdminZoomAttendance).mockRejectedValueOnce(new Error('ECONNRESET'))
      await mount()
      await openZoomTab()

      expect(host?.querySelector('.v-empty__title')?.textContent).toBe(
        'Не удалось загрузить посещаемость Zoom',
      )
      expect(host?.querySelector('[data-testid="zoom-meeting-status"]')).toBeNull()

      button('Повторить')?.click()
      await flush()
      expect(host?.querySelector('[data-testid="zoom-meeting-status"]')).not.toBeNull()

      button('Участники')?.click()
      await flush()
      expect(tableRows('Участники практики')).toHaveLength(5)
    })
  })
})
