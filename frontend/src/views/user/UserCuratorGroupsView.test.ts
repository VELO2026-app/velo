// =============================================================================
// VELO Frontend -- UserCuratorGroupsView Screen Tests (schools FE-19 / GT P3)
// =============================================================================
//
// Standard screen-test idiom (GroupJoinView.test.ts): createApp/mount, mocked
// @/api/curatorGroups + vue-router + useToast. Covers the four honest list
// states (loading / rows / empty / error+retry) and the row -> page
// navigation.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import UserCuratorGroupsView from '@/views/user/UserCuratorGroupsView.vue'
import * as cgApi from '@/api/curatorGroups'
import type { CuratorGroupMineResponse } from '@/api/types'

vi.mock('@/api/curatorGroups')

const push = vi.fn()
const replace = vi.fn()
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: {}, name: 'user-curator-groups' }),
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
  app = createApp(UserCuratorGroupsView)
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

function mineResponse(items: CuratorGroupMineResponse['items']): CuratorGroupMineResponse {
  return { items }
}

const row = (id: string, relation: 'curator' | 'master' | 'student', transfer = false) => ({
  id,
  name: `Школа ${id}`,
  description: null,
  curator: { user_id: 'u1', display_name: 'Мария Иванова', avatar_url: null },
  masters_count: 2,
  students_count: 7,
  relation,
  transfer_offered: transfer,
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

describe('UserCuratorGroupsView', () => {
  it('shows the loading state while /mine is in flight', async () => {
    vi.mocked(cgApi.getMyCuratorGroups).mockReturnValue(new Promise(() => {}))
    mount()
    await flush()

    expect(host?.querySelector('.ucg__state')).toBeTruthy()
  })

  it('renders every school row with curator + counts, and navigates on tap', async () => {
    vi.mocked(cgApi.getMyCuratorGroups).mockResolvedValue(
      mineResponse([row('g1', 'student'), row('g2', 'curator')]),
    )
    mount()
    await flush()

    expect(text()).toContain('Школа g1')
    expect(text()).toContain('Школа g2')
    expect(text()).toContain('Куратор: Мария Иванова')
    expect(text()).toContain('Мастеров: 2')
    expect(text()).toContain('Учеников: 7')

    const first = Array.from(host?.querySelectorAll('.v-list-row') ?? [])[0] as HTMLElement
    first.click()
    await flush()
    expect(push).toHaveBeenCalledWith({ name: 'user-curator-group', params: { id: 'g1' } })
  })

  it('empty list: the honest empty state names the only way in', async () => {
    vi.mocked(cgApi.getMyCuratorGroups).mockResolvedValue(mineResponse([]))
    mount()
    await flush()

    expect(text()).toContain('Пока нет групп')
    expect(text()).toContain('Вступить в группу можно по ссылке от куратора')
  })

  it('load failure: error state with a retry that works', async () => {
    vi.mocked(cgApi.getMyCuratorGroups).mockRejectedValueOnce(new Error('network'))
    mount()
    await flush()

    expect(text()).toContain('Не удалось загрузить группы')

    vi.mocked(cgApi.getMyCuratorGroups).mockResolvedValueOnce(mineResponse([row('g1', 'student')]))
    const retry = Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
      b.textContent?.includes('Повторить'),
    ) as HTMLElement
    retry.click()
    await flush()

    expect(text()).toContain('Школа g1')
  })
})
