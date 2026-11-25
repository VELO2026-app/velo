// =============================================================================
// VELO Frontend -- ConsoleModerationView screen tests (FE-262, slice 2)
// =============================================================================
//
// What the screen decides: the complaints list and the open complaint side by
// side, the verdicts (resolve needs a text, dismiss takes an optional one),
// the decided tab, the method-change requests with their three ways to
// approve and the reject reason, and the one-pane layout on a narrow window.
// Real Pinia + Pinia Colada and a real memory router; @/api/admin is the
// mocked boundary, with a small fake server behind it (a verdict removes the
// complaint from the pending list, as the backend does).
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { PiniaColada, useQueryCache } from '@pinia/colada'
import { coladaOptions } from '@/composables/queries/setup'
import { adminKeys } from '@/composables/queries/adminKeys'
import ConsoleModerationView from '@/views/console/ConsoleModerationView.vue'
import * as adminApi from '@/api/admin'
import { ApiResponseError } from '@/api/client'
import type { AdminMethodChangeItem, ReportResponse } from '@/api/admin'

vi.mock('@/api/admin')
vi.mock('@/utils/methodTaxonomy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/methodTaxonomy')>()
  return { ...actual, primeMethodTaxonomyCatalog: vi.fn().mockResolvedValue(undefined) }
})

const env = vi.hoisted(() => ({ single: false }))
vi.mock('@/composables/useMediaQuery', () => ({ useMediaQuery: () => ref(env.single) }))

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: vi.fn() }),
}))

// -----------------------------------------------------------------------------
// Fixtures: texts differ between rows, so "the right one is open" proves itself
// -----------------------------------------------------------------------------

function report(overrides: Partial<ReportResponse> = {}): ReportResponse {
  return {
    id: 'r_master_0001',
    reporter_id: 'reporter_0001_xxxx',
    target_type: 'master',
    target_id: 'target_master_0001',
    reason: 'The master was rude to the group',
    status: 'pending',
    created_at: new Date(Date.now() - 12 * 60000).toISOString(),
    ...overrides,
  }
}

const R_MASTER = report()
const R_USER = report({
  id: 'r_user_0002',
  target_type: 'user',
  target_id: 'target_user_0002',
  reason: 'Advertising in practice chats',
})
const R_DONE = report({
  id: 'r_done_0003',
  status: 'resolved',
  reason: 'An old complaint that was handled',
  resolved_at: new Date(Date.now() - 3600000).toISOString(),
  resolution_note: 'The master got a warning',
})

function request(overrides: Partial<AdminMethodChangeItem> = {}): AdminMethodChangeItem {
  return {
    user_id: 'm_anna',
    display_name: 'Anna Lebedeva',
    current_methods: ['Медитация'],
    proposed_methods: ['Медитация'],
    submitted_at: new Date(Date.now() - 3600000).toISOString(),
    ...overrides,
  }
}

/** The fake backend behind the mocked API. */
const server = {
  reports: { pending: [R_MASTER, R_USER], resolved: [R_DONE], dismissed: [] } as Record<
    string,
    ReportResponse[]
  >,
  requests: [request()] as AdminMethodChangeItem[],
}

function fakeServer(): void {
  vi.mocked(adminApi.getAdminStats).mockImplementation(async () => ({
    users_count: 10,
    masters_count: 2,
    practices_count: 3,
    pending_verifications: 0,
    pending_method_changes: server.requests.length,
  }))
  vi.mocked(adminApi.getReports).mockImplementation(
    async (status, _type, limit = 20, offset = 0) => {
      const list = server.reports[status ?? 'pending'] ?? []
      return { items: list.slice(offset, offset + limit), total: list.length, limit, offset }
    },
  )
  vi.mocked(adminApi.getReportById).mockImplementation(async (id) => {
    const found = Object.values(server.reports)
      .flat()
      .find((r) => r.id === id)
    if (!found) throw new ApiResponseError(404, 'not found')
    return found
  })
  const decide = (id: string, status: string, note?: string): ReportResponse => {
    const done = { ...must((server.reports.pending ?? []).find((r) => r.id === id)), status }
    server.reports.pending = (server.reports.pending ?? []).filter((r) => r.id !== id)
    server.reports[status] = [{ ...done, resolution_note: note ?? null }]
    return done
  }
  vi.mocked(adminApi.resolveReport).mockImplementation(async (id, note) =>
    decide(id, 'resolved', note),
  )
  vi.mocked(adminApi.dismissReport).mockImplementation(async (id, note) =>
    decide(id, 'dismissed', note),
  )
  vi.mocked(adminApi.getMethodChangeRequests).mockImplementation(
    async (limit = 20, offset = 0) => ({
      items: server.requests.slice(offset, offset + limit),
      total: server.requests.length,
      limit,
      offset,
    }),
  )
  const decideRequest = async (userId: string) => {
    server.requests = server.requests.filter((r) => r.user_id !== userId)
    return { status: 'ok' } as unknown as Awaited<ReturnType<typeof adminApi.approveMethodChange>>
  }
  vi.mocked(adminApi.approveMethodChange).mockImplementation(decideRequest)
  vi.mocked(adminApi.rejectMethodChange).mockImplementation(decideRequest)
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

/** The value, or a clear failure: tests read maps and arrays that must hold the key. */
function must<T>(value: T | undefined | null, what = 'value'): T {
  if (value == null) throw new Error(`missing ${what}`)
  return value
}

let app: App | null = null
let host: HTMLElement | null = null
let router: Router

const Stub = { template: '<div class="stub" />' }

async function mount(path = '/console/moderation'): Promise<HTMLElement> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/console/moderation', name: 'console-moderation', component: ConsoleModerationView },
      { path: '/admin/masters/:id', name: 'console-masters-detail', component: Stub },
      { path: '/admin/practices/:id', name: 'console-practices-detail', component: Stub },
    ],
  })
  await router.push(path)
  host = document.createElement('div')
  document.body.appendChild(host)
  const pinia = createPinia()
  setActivePinia(pinia)
  app = createApp(RouterView).use(createTestI18n()).use(pinia).use(PiniaColada, coladaOptions)
  app.use(router)
  app.mount(host)
  await flush()
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

function byId(id: string): HTMLElement | null {
  return host?.querySelector(`[data-testid="${id}"]`) ?? null
}
function rows(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('[data-testid="report-row"]') ?? [])
}
function button(label: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim() === label,
  )
  if (!found) throw new Error(`no button "${label}"`)
  return found
}
async function click(el: HTMLElement): Promise<void> {
  el.click()
  await flush()
}
function typeInto(el: HTMLTextAreaElement | null, value: string): void {
  if (!el) throw new Error('no textarea')
  el.value = value
  el.dispatchEvent(new Event('input'))
}
function textarea(): HTMLTextAreaElement | null {
  return document.body.querySelector('textarea')
}
function reasonShown(): string {
  return byId('report-reason')?.textContent?.trim() ?? ''
}

beforeEach(() => {
  env.single = false
  server.reports = { pending: [R_MASTER, R_USER], resolved: [R_DONE], dismissed: [] }
  server.requests = [request()]
  fakeServer()
  toastError.mockReset()
  toastSuccess.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  document.body.querySelectorAll('.v-modal__overlay, .v-modal__scrim').forEach((el) => el.remove())
  app = null
  host = null
  vi.clearAllMocks()
})

describe('ConsoleModerationView: complaints', () => {
  it('lists the pending complaints with the first one open, and counts the tabs from the stats', async () => {
    await mount()

    expect(rows()).toHaveLength(2)
    expect(reasonShown()).toBe('The master was rude to the group')
    const tabs = Array.from(host?.querySelectorAll('[role="tab"]') ?? []).map((t) =>
      t.textContent?.replace(/\s+/g, ' ').trim(),
    )
    expect(tabs).toEqual(['Жалобы 2', 'Смена методов 1', 'Решённые'])
  })

  it('opens the complaint that is clicked', async () => {
    await mount()

    await click(must(rows()[1]))

    expect(reasonShown()).toBe('Advertising in practice chats')
    expect(router.currentRoute.value.query.id).toBe('r_user_0002')
  })

  it('reads a complaint named in the URL that the list does not hold', async () => {
    server.reports.resolved = [R_DONE]
    await mount('/console/moderation?id=r_done_0003')

    expect(adminApi.getReportById).toHaveBeenCalledWith('r_done_0003')
    expect(reasonShown()).toBe('An old complaint that was handled')
    expect(byId('report-verdict')?.textContent).toContain('The master got a warning')
  })

  it('refuses to take action without a text, then resolves with the trimmed text and opens the next one', async () => {
    await mount()

    await click(button('Принять меры'))
    expect(adminApi.resolveReport).not.toHaveBeenCalled()
    expect(host?.textContent).toContain('Введите примечание к решению')

    typeInto(textarea(), '  Warning sent  ')
    await flush()
    await click(button('Принять меры'))

    expect(adminApi.resolveReport).toHaveBeenCalledWith('r_master_0001', 'Warning sent')
    expect(toastSuccess).toHaveBeenCalledWith('Жалоба решена')
    expect(rows()).toHaveLength(1)
    expect(reasonShown()).toBe('Advertising in practice chats')
    expect(router.currentRoute.value.query.id).toBeUndefined()
  })

  it.each([
    ['', undefined],
    ['  not a violation  ', 'not a violation'],
  ])('dismisses with the text %j sent as %j', async (typed, sent) => {
    await mount()

    typeInto(textarea(), typed)
    await flush()
    await click(button('Отклонить'))

    expect(adminApi.dismissReport).toHaveBeenCalledWith('r_master_0001', sent)
    expect(toastSuccess).toHaveBeenCalledWith('Жалоба отклонена')
  })

  it('tells a failed verdict and keeps the complaint open for another try', async () => {
    vi.mocked(adminApi.dismissReport).mockRejectedValueOnce(new ApiResponseError(500, 'boom'))
    await mount()

    await click(button('Отклонить'))

    expect(toastError).toHaveBeenCalledTimes(1)
    expect(rows()).toHaveLength(2)
    await click(button('Отклонить'))
    expect(adminApi.dismissReport).toHaveBeenCalledTimes(2)
    expect(rows()).toHaveLength(1)
  })

  it('links a master target to its admin screen and leaves a user target as plain text', async () => {
    await mount()

    await click(byId('report-target') as HTMLElement)
    expect(router.currentRoute.value.name).toBe('console-masters-detail')
    expect(router.currentRoute.value.params.id).toBe('target_master_0001')

    await router.push('/console/moderation?id=r_user_0002')
    await flush()
    expect(byId('report-target')?.tagName).toBe('SPAN')
  })
})

describe('ConsoleModerationView: decided tab', () => {
  it('shows the resolved complaints first, the dismissed ones through the chips, and no decision form', async () => {
    server.reports.dismissed = [
      report({ id: 'r_dismissed_4', reason: 'Dismissed text', status: 'dismissed' }),
    ]
    await mount('/console/moderation?tab=decided')

    expect(adminApi.getReports).toHaveBeenCalledWith('resolved', undefined, 20, 0)
    expect(reasonShown()).toBe('An old complaint that was handled')
    expect(textarea()).toBeNull()

    await click(button('Отклонена'))

    expect(adminApi.getReports).toHaveBeenCalledWith('dismissed', undefined, 20, 0)
    expect(reasonShown()).toBe('Dismissed text')
  })
})

describe('ConsoleModerationView: narrow window', () => {
  it('shows the list alone until a complaint is picked, and the way back', async () => {
    env.single = true
    await mount()

    expect(rows()).toHaveLength(2)
    expect(byId('report-detail')).toBeNull()

    await click(must(rows()[0]))
    expect(byId('report-detail')).not.toBeNull()
    expect(rows()).toHaveLength(0)

    await click(byId('reports-back') as HTMLElement)
    expect(rows()).toHaveLength(2)
    expect(byId('report-detail')).toBeNull()
  })
})

describe('ConsoleModerationView: method changes', () => {
  it('shows who asks, the methods now and after, with the added ones apart', async () => {
    server.requests = [request({ proposed_methods: ['Медитация', 'Мой уникальный метод'] })]
    await mount('/console/moderation?tab=methods')

    expect(host?.textContent).toContain('Anna Lebedeva просит изменить методы')
    expect(
      Array.from(host?.querySelectorAll('[data-testid="method-added"]') ?? []).map((e) =>
        e.textContent?.trim(),
      ),
    ).toEqual(['Мой уникальный метод'])
  })

  it('approves a request whose methods are all in the catalog at once, and drops it', async () => {
    await mount('/console/moderation?tab=methods')

    await click(button('Одобрить'))

    expect(adminApi.approveMethodChange).toHaveBeenCalledWith('m_anna', undefined, undefined)
    expect(toastSuccess).toHaveBeenCalledWith('Методы обновлены')
    expect(host?.querySelector('[data-testid="method-request"]')).toBeNull()
  })

  it.each([
    ['Добавить в каталог', ['Мой уникальный метод'], undefined],
    ['Только этому мастеру', undefined, ['Мой уникальный метод']],
  ])(
    'asks about a custom method, and "%s" approves with the matching scope',
    async (choice, promote, masterOnly) => {
      server.requests = [request({ proposed_methods: ['Медитация', 'Мой уникальный метод'] })]
      await mount('/console/moderation?tab=methods')

      await click(button('Одобрить'))
      expect(adminApi.approveMethodChange).not.toHaveBeenCalled()
      await click(button(choice))

      expect(adminApi.approveMethodChange).toHaveBeenCalledWith('m_anna', promote, masterOnly)
    },
  )

  it('rejects only with a reason, sent trimmed', async () => {
    await mount('/console/moderation?tab=methods')

    await click(button('Отклонить с причиной'))
    await click(button('Отклонить заявку'))
    expect(adminApi.rejectMethodChange).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Укажите причину отказа')

    typeInto(textarea(), '  No certificate  ')
    await flush()
    await click(button('Отклонить заявку'))

    expect(adminApi.rejectMethodChange).toHaveBeenCalledWith('m_anna', 'No certificate')
    expect(toastSuccess).toHaveBeenCalledWith('Заявка отклонена')
    expect(host?.querySelector('[data-testid="method-request"]')).toBeNull()
  })

  it('tells a failed approval and keeps the request in the list', async () => {
    vi.mocked(adminApi.approveMethodChange).mockRejectedValueOnce(new ApiResponseError(500, 'boom'))
    await mount('/console/moderation?tab=methods')

    await click(button('Одобрить'))

    expect(toastError).toHaveBeenCalledTimes(1)
    expect(host?.querySelector('[data-testid="method-request"]')).not.toBeNull()
  })
})

describe('ConsoleModerationView: empty and failed lists', () => {
  it('says there are no new complaints, and nothing to pick', async () => {
    server.reports.pending = []
    await mount()

    expect(rows()).toHaveLength(0)
    expect(host?.textContent).toContain('Новых жалоб нет')
    expect(host?.textContent).toContain('Жалоба не выбрана')
  })

  it('shows the list error with a retry that asks again', async () => {
    vi.mocked(adminApi.getReports).mockRejectedValueOnce(new ApiResponseError(500, 'boom'))
    await mount()
    expect(host?.textContent).toContain('Не удалось загрузить')

    await click(button('Повторить'))

    expect(rows()).toHaveLength(2)
  })

  it('says the complaint named in the URL is not found when nothing answers to it', async () => {
    await mount('/console/moderation?id=r_missing')

    expect(host?.textContent).toContain('Жалоба не найдена')
  })

  it('says there are no method change requests', async () => {
    server.requests = []
    await mount('/console/moderation?tab=methods')

    expect(host?.textContent).toContain('Заявок нет')
  })

  it('shows the requests error with a retry that asks again', async () => {
    vi.mocked(adminApi.getMethodChangeRequests).mockRejectedValueOnce(
      new ApiResponseError(500, 'boom'),
    )
    await mount('/console/moderation?tab=methods')
    expect(host?.querySelector('[data-testid="method-request"]')).toBeNull()

    await click(button('Повторить'))

    expect(host?.querySelector('[data-testid="method-request"]')).not.toBeNull()
  })
})

describe('ConsoleModerationView: a verdict and the background refetch', () => {
  /** Ask a held answer again, as a focus return does; a failure is the screen's to tell. */
  async function refetch(key: readonly unknown[]): Promise<void> {
    useQueryCache()
      .invalidateQueries({ key: key as never })
      .catch(() => {})
    await flush()
  }
  function gate(): { wait: Promise<void>; open: () => void } {
    let open = () => {}
    const wait = new Promise<void>((resolve) => {
      open = resolve
    })
    return { wait, open }
  }

  it('takes the decided complaint off the list at once, before the list answers again', async () => {
    await mount()
    const held = gate()
    const real = must(vi.mocked(adminApi.getReports).getMockImplementation())
    // The list's refetch (a page of 20) waits; the badge's read (one row) does not.
    vi.mocked(adminApi.getReports).mockImplementation(async (status, type, limit, offset) => {
      if (limit === 20) await held.wait
      return real(status, type, limit, offset)
    })

    typeInto(textarea(), 'Warning sent')
    await flush()
    await click(button('Принять меры'))

    expect(rows()).toHaveLength(1)
    expect(reasonShown()).toBe('Advertising in practice chats')
    expect(adminApi.resolveReport).toHaveBeenCalledTimes(1)
    expect(adminApi.getReportById).not.toHaveBeenCalled()
    held.open()
    await flush()
    expect(rows()).toHaveLength(1)
  })

  it('keeps the list and the open complaint on screen while the list refetches, then takes the news', async () => {
    await mount()
    const held = gate()
    const real = must(vi.mocked(adminApi.getReports).getMockImplementation())
    vi.mocked(adminApi.getReports).mockImplementationOnce(async (status, type, limit, offset) => {
      await held.wait
      return real(status, type, limit, offset)
    })
    server.reports.pending = [report({ id: 'r_new_0004', reason: 'A new one' }), R_MASTER, R_USER]

    await refetch(adminKeys.reportsAll())

    expect(rows()).toHaveLength(2)
    expect(host?.querySelector('.v-loader')).toBeNull()
    expect(reasonShown()).toBe('The master was rude to the group')
    held.open()
    await flush()
    expect(rows()).toHaveLength(3)
  })

  it('tells a failed list refetch once and keeps the list, until an answer arrives', async () => {
    await mount()
    const real = must(vi.mocked(adminApi.getReports).getMockImplementation())
    vi.mocked(adminApi.getReports).mockImplementation(() => Promise.reject(new Error('down')))

    await refetch(adminKeys.reportsAll())
    await refetch(adminKeys.reportsAll())

    expect(rows()).toHaveLength(2)
    expect(toastError).toHaveBeenCalledTimes(1)

    vi.mocked(adminApi.getReports).mockImplementation(real)
    await refetch(adminKeys.reportsAll())
    vi.mocked(adminApi.getReports).mockImplementation(() => Promise.reject(new Error('down again')))
    await refetch(adminKeys.reportsAll())
    expect(toastError).toHaveBeenCalledTimes(2)
  })

  it('tells a failed refetch of the method requests once and keeps them', async () => {
    await mount('/console/moderation?tab=methods')
    vi.mocked(adminApi.getMethodChangeRequests).mockImplementation(() =>
      Promise.reject(new Error('down')),
    )

    await refetch(adminKeys.methodRequests())
    await refetch(adminKeys.methodRequests())

    expect(host?.querySelector('[data-testid="method-request"]')).not.toBeNull()
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError).toHaveBeenCalledWith('Ошибка загрузки заявок')
  })
})
