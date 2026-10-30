// =============================================================================
// VELO Frontend -- SchoolsView Screen Tests (tz-curator.md §1.2-1.4)
// =============================================================================
//
// Standard screen-test idiom (UserCuratorGroupsView.test.ts): createApp/mount,
// mocked @/api/curatorGroups + vue-router. Covers the four honest list states
// (loading / rows / empty+CTA / error+retry), the row -> school-page
// navigation, and the create-right gating of the «+» and the CTA (BE-18).
// FE-93: this zone lists PARTICIPATIONS (the curated rows /mine still
// returns are the master list's section), and the create right is only
// dialed in master mode -- hence the seeded auth role on every mount.
//
// The schoolsHub store (the tab probe) runs REAL against the mocked module --
// it shares the same seam, so one vi.mock serves both.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import SchoolsView from '@/views/user/SchoolsView.vue'
import { useAuthStore } from '@/stores/auth'
import * as cgApi from '@/api/curatorGroups'
import type { CuratorGroupMineResponse } from '@/api/types'

vi.mock('@/api/curatorGroups')

const push = vi.fn()
const replace = vi.fn()
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: {}, name: 'user-schools' }),
  useRouter: () => ({ push, replace }),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}))

let app: App | null = null
let host: HTMLElement | null = null

function mount(role: 'user' | 'master' = 'user'): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  const pinia = createPinia()
  setActivePinia(pinia)
  // FE-93: the create right is dialed only in master mode, so the active
  // role is part of this screen's contract -- seed it before the mount.
  useAuthStore().user = {
    id: 'u1',
    role,
    role_switch: { allowed_roles: [role] },
  } as never
  app = createApp(SchoolsView).use(createTestI18n()).use(pinia)
  // The hub reads the schoolsHub store (the tab probe shares this seam).
  app.mount(host)
  return host
}

// The list loads through the screen-data cache (useQuery): a settled
// request takes a few more microtasks than the old local ref did.
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}

function buttonWith(label: string): HTMLElement | null {
  return (
    (Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
      b.textContent?.includes(label),
    ) as HTMLElement | undefined) ?? null
  )
}

function mineResponse(items: CuratorGroupMineResponse['items']): CuratorGroupMineResponse {
  return { items }
}

const row = (id: string, relation: 'curator' | 'master' | 'student') => ({
  id,
  name: `Школа ${id}`,
  description: null,
  avatar_url: null,
  curator: { user_id: 'u1', display_name: 'Мария Иванова', avatar_url: null },
  masters_count: 2,
  students_count: 7,
  relation,
  transfer_offered: false,
})

beforeEach(() => {
  vi.mocked(cgApi.getMyCuratorGroups).mockReset().mockResolvedValue(mineResponse([]))
  vi.mocked(cgApi.getCuratorGroups).mockReset().mockResolvedValue({
    items: [],
    can_create_groups: true,
  })
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

describe('SchoolsView', () => {
  it('shows the loading state while /mine is in flight', async () => {
    vi.mocked(cgApi.getMyCuratorGroups).mockReturnValue(new Promise(() => {}))
    mount()
    await flush()

    expect(host?.querySelector('.schools__state')).toBeTruthy()
  })

  it('a return through the dock renders the cached schools at once, no loading state', async () => {
    vi.mocked(cgApi.getMyCuratorGroups).mockResolvedValue(mineResponse([row('g2', 'student')]))
    mount()
    await flush()
    expect(text()).toContain('Школа g2')

    // Revisit while the background refresh is still in flight.
    app?.unmount()
    host?.remove()
    vi.mocked(cgApi.getMyCuratorGroups).mockReturnValue(new Promise(() => {}))
    mount()
    await flush()

    expect(host?.querySelector('.schools__state')).toBeNull()
    expect(text()).toContain('Школа g2')
    expect(cgApi.getMyCuratorGroups).toHaveBeenCalledTimes(2) // still refreshed
  })

  it('renders the PARTICIPATION rows only (FE-93) and navigates a row to the school page', async () => {
    vi.mocked(cgApi.getMyCuratorGroups).mockResolvedValue(
      mineResponse([row('g1', 'curator'), row('g2', 'student')]),
    )
    mount()
    await flush()

    // FE-93: the curated row is the master list's «Я куратор» section --
    // every management surface behind it would 403 from this zone.
    expect(text()).not.toContain('Школа g1')
    expect(text()).toContain('Школа g2')
    // §1.4 stats line: two icon+number pairs, students first, no words.
    const firstRow = host?.querySelector('.cg-row') as HTMLElement
    const stats = Array.from(firstRow.querySelectorAll('.cg-row__stat')).map((s) =>
      s.textContent?.replace(/\s+/g, ' ').trim(),
    )
    expect(stats).toEqual(['7', '2'])

    firstRow.click()
    await flush()
    expect(push).toHaveBeenCalledWith({ name: 'user-curator-group', params: { id: 'g2' } })
  })

  it('empty list with the create right: the quiet §1.3 state -- one CTA, no empty-state plate', async () => {
    // The right lives on the master surface, so this quiet state is only
    // reachable from master mode (FE-93) -- a role=master in this zone.
    mount('master')
    await flush()

    // §1.3: the curator-empty screen is the quiet background with ONE CTA --
    // no «Пока нет школ» copy, no VEmptyState plate, no invented illustration.
    expect(text()).not.toContain('Пока нет школ')
    expect(host?.querySelector('.v-empty-state')).toBeNull()
    expect(host?.querySelector('.schools__empty')).toBeTruthy()
    const cta = buttonWith('Создать школу')
    expect(cta).toBeTruthy()
    cta?.click()
    await flush()
    expect(push).toHaveBeenCalledWith({ name: 'master-curator-group-create' })
  })

  it('FE-93: in user mode the master surface is not dialed -- no «+», no doomed 403', async () => {
    vi.mocked(cgApi.getMyCuratorGroups).mockResolvedValue(mineResponse([]))
    mount('user')
    await flush()

    expect(cgApi.getCuratorGroups).not.toHaveBeenCalled()
    expect(host?.querySelector('.schools__add-btn')).toBeFalsy()
    // Without the create right the settled empty list is the plain empty
    // state, not the quiet «Создать школу» screen.
    expect(text()).toContain('Пока нет школ')
  })

  it('the header «+» follows the create right (BE-18)', async () => {
    vi.mocked(cgApi.getCuratorGroups).mockResolvedValue({
      items: [],
      can_create_groups: false,
    })
    mount('master')
    await flush()

    expect(host?.querySelector('.schools__add-btn')).toBeFalsy()

    vi.mocked(cgApi.getCuratorGroups).mockResolvedValue({
      items: [],
      can_create_groups: true,
    })
    app?.unmount()
    mount('master')
    await flush()
    expect(host?.querySelector('.schools__add-btn')).toBeTruthy()
  })

  it('load failure: error state with a retry that works', async () => {
    vi.mocked(cgApi.getMyCuratorGroups).mockRejectedValueOnce(new Error('network'))
    mount()
    await flush()

    expect(text()).toContain('Не удалось загрузить школы')

    // The retry renders a PARTICIPATION row (FE-93: the curated relation
    // would be filtered out of this zone's list).
    vi.mocked(cgApi.getMyCuratorGroups).mockResolvedValueOnce(mineResponse([row('g1', 'student')]))
    const retry = buttonWith('Повторить')
    retry?.click()
    await flush()

    expect(text()).toContain('Школа g1')
    expect(text()).not.toContain('Не удалось загрузить школы')
  })
})
