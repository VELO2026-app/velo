// =============================================================================
// VELO Frontend -- AdminCuratorGroupsView Tests (schools FE-23 / GT P4)
// =============================================================================
//
// Admin list idiom (AdminParticipantsView's own suite): mocked api +
// vue-router + toast. Covers the frozen-school visibility (the whole point
// of this screen), the curator-review navigation, pagination, and the
// read-only-ness (no mutation API is even imported).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AdminCuratorGroupsView from '@/views/admin/AdminCuratorGroupsView.vue'
import * as cgApi from '@/api/curatorGroups'

vi.mock('@/api/curatorGroups')

const push = vi.fn()
const replace = vi.fn()
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: {}, name: 'admin-curator-groups' }),
  useRouter: () => ({ push, replace }),
}))

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: toastError, info: vi.fn() }),
}))

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AdminCuratorGroupsView)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  await nextTick()
  await nextTick()
  await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}

function school(id: string, is_active: boolean) {
  return {
    id,
    name: `Школа ${id}`,
    curator: { user_id: `u-${id}`, display_name: `Куратор ${id}` },
    masters_count: 3,
    students_count: 11,
    is_active,
    created_at: '2026-08-01T00:00:00Z',
  }
}

beforeEach(() => {
  vi.mocked(cgApi.getAdminCuratorGroups).mockReset()
  push.mockReset()
  replace.mockReset()
  toastError.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('AdminCuratorGroupsView', () => {
  it('lists BOTH active and frozen schools -- the only place a frozen one is visible', async () => {
    vi.mocked(cgApi.getAdminCuratorGroups).mockResolvedValue({
      items: [school('g1', true), school('g2', false)],
      total: 2,
      limit: 100,
      offset: 0,
    })
    mount()
    await flush()

    expect(text()).toContain('Школа g1')
    expect(text()).toContain('Активна')
    expect(text()).toContain('Школа g2')
    expect(text()).toContain('Заморожена')
    expect(text()).toContain('Куратор: Куратор g1')
  })

  it("a tap opens the CURATOR's review page -- the revoke lever lives there", async () => {
    vi.mocked(cgApi.getAdminCuratorGroups).mockResolvedValue({
      items: [school('g1', true)],
      total: 1,
      limit: 100,
      offset: 0,
    })
    mount()
    await flush()

    const card = host?.querySelector('.sg-card') as HTMLElement
    card.click()
    await flush()
    expect(push).toHaveBeenCalledWith({ name: 'admin-master-review', params: { id: 'u-g1' } })
  })

  it('pagination: «Показать ещё» fetches the next offset and appends', async () => {
    vi.mocked(cgApi.getAdminCuratorGroups)
      .mockResolvedValueOnce({ items: [school('g1', true)], total: 2, limit: 100, offset: 0 })
      .mockResolvedValueOnce({ items: [school('g2', false)], total: 2, limit: 100, offset: 1 })
    mount()
    await flush()

    const more = Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
      b.textContent?.includes('Показать ещё'),
    ) as HTMLElement
    more.click()
    await flush()

    expect(cgApi.getAdminCuratorGroups).toHaveBeenNthCalledWith(1, 100, 0)
    expect(cgApi.getAdminCuratorGroups).toHaveBeenNthCalledWith(2, 100, 1)
    expect(text()).toContain('Школа g2')
  })

  it('a failed first page is an error state, not "no schools" (W12)', async () => {
    vi.mocked(cgApi.getAdminCuratorGroups).mockRejectedValueOnce(new Error('network'))
    mount()
    await flush()

    expect(text()).toContain('Не удалось загрузить школы')

    vi.mocked(cgApi.getAdminCuratorGroups).mockResolvedValueOnce({
      items: [school('g1', true)],
      total: 1,
      limit: 100,
      offset: 0,
    })
    const retry = Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
      b.textContent?.includes('Повторить'),
    ) as HTMLElement
    retry.click()
    await flush()
    expect(text()).toContain('Школа g1')
  })

  it('empty: honest "no schools yet"', async () => {
    vi.mocked(cgApi.getAdminCuratorGroups).mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    })
    mount()
    await flush()

    expect(text()).toContain('Школ пока нет')
  })
})
