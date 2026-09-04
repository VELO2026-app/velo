// =============================================================================
// VELO Frontend -- MasterCuratorGroupsView Screen Tests (schools FE-20 / GT P3)
// =============================================================================
//
// Same idiom as UserCuratorGroupsView.test.ts, plus the master list's own
// distinctions: the «Я куратор» / «Я участник» sectioning over one /mine
// payload, and the ALWAYS-visible «+» (creating the row is how one becomes a
// curator -- no other grant exists).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import MasterCuratorGroupsView from '@/views/master/MasterCuratorGroupsView.vue'
import * as cgApi from '@/api/curatorGroups'
import type { CuratorGroupMineResponse } from '@/api/types'

vi.mock('@/api/curatorGroups')

const push = vi.fn()
const replace = vi.fn()
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: {}, name: 'master-curator-groups' }),
  useRouter: () => ({ push, replace }),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}))

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(MasterCuratorGroupsView)
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

function buttonWith(label: string): HTMLElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLElement>('button') ?? []).find(
    (b) => b.textContent?.trim().includes(label) || b.getAttribute('aria-label') === label,
  )
}

const row = (id: string, relation: 'curator' | 'master' | 'student') => ({
  id,
  name: `Школа ${id}`,
  description: null,
  curator: { user_id: 'u1', display_name: 'Мария Иванова', avatar_url: null },
  masters_count: 2,
  students_count: 7,
  relation,
  transfer_offered: false,
})

beforeEach(() => {
  vi.mocked(cgApi.getMyCuratorGroups).mockReset()
  push.mockReset()
  replace.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('MasterCuratorGroupsView', () => {
  it('sections one /mine payload into «Я куратор» and «Я участник»', async () => {
    vi.mocked(cgApi.getMyCuratorGroups).mockResolvedValue({
      items: [row('g1', 'curator'), row('g2', 'master'), row('g3', 'student')],
    } satisfies CuratorGroupMineResponse)
    mount()
    await flush()

    const sections = Array.from(host?.querySelectorAll('.velo-section-title') ?? []).map(
      (h) => h.textContent,
    )
    expect(sections).toEqual(['Я куратор', 'Я участник'])
    // Curated first even though a student row came in between.
    const curated = host?.querySelector('.mcg__content')?.textContent ?? ''
    expect(curated.indexOf('Школа g1')).toBeLessThan(curated.indexOf('Школа g2'))
  })

  it('tap navigates into the MASTER zone page', async () => {
    vi.mocked(cgApi.getMyCuratorGroups).mockResolvedValue({
      items: [row('g1', 'curator')],
    } satisfies CuratorGroupMineResponse)
    mount()
    await flush()

    const first = Array.from(host?.querySelectorAll('.v-list-row') ?? [])[0] as HTMLElement
    first.click()
    await flush()
    expect(push).toHaveBeenCalledWith({ name: 'master-curator-group', params: { id: 'g1' } })
  })

  it('the «+» is always present (creation is the curator grant) and opens the create form', async () => {
    vi.mocked(cgApi.getMyCuratorGroups).mockResolvedValue({
      items: [],
    } satisfies CuratorGroupMineResponse)
    mount()
    await flush()

    const add = buttonWith('Новая школа')
    expect(add).toBeTruthy()
    add?.click()
    await flush()
    expect(push).toHaveBeenCalledWith({ name: 'master-curator-group-create' })
  })

  it('empty list: the hint covers BOTH ways in (create or join by link)', async () => {
    vi.mocked(cgApi.getMyCuratorGroups).mockResolvedValue({
      items: [],
    } satisfies CuratorGroupMineResponse)
    mount()
    await flush()

    expect(text()).toContain('Создайте группу или вступите по ссылке от куратора')
    const create = buttonWith('Создать группу')
    expect(create).toBeTruthy()
  })

  it('load failure: error state with a working retry', async () => {
    vi.mocked(cgApi.getMyCuratorGroups).mockRejectedValueOnce(new Error('network'))
    mount()
    await flush()

    expect(text()).toContain('Не удалось загрузить группы')

    vi.mocked(cgApi.getMyCuratorGroups).mockResolvedValueOnce({
      items: [row('g1', 'curator')],
    } satisfies CuratorGroupMineResponse)
    buttonWith('Повторить')?.click()
    await flush()

    expect(text()).toContain('Я куратор')
  })
})
