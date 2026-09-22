// =============================================================================
// VELO Frontend -- SchoolMembersView Screen Tests (tz-curator.md §1.11)
// =============================================================================
//
// ONE participants screen with the Мастера/Ученики switcher (owner
// 2026-09-22): the tab rides ?kind= (default master, unknown values fall
// back), switching resets the search, replaces the query and reloads with
// the new kind (no unfiltered load ever leaves this screen -- §1.11.3), the
// two empties are different, a 404 is the SCHOOL being unavailable (P-08)
// and hides the switcher, every row navigates: masters to the existing
// public profile, students to the school-context profile. A later-page
// failure keeps the list (toast only).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import SchoolMembersView from '@/views/user/SchoolMembersView.vue'
import * as cgApi from '@/api/curatorGroups'
import { ApiResponseError } from '@/api/client'
import type { CuratorGroupMemberItem, PaginatedCuratorGroupMembersResponse } from '@/api/types'

vi.mock('@/api/curatorGroups')

const push = vi.fn()
const replace = vi.fn()
const routeState = {
  name: 'user-curator-group-members',
  id: 'g1',
  query: {} as Record<string, string>,
}
vi.mock('vue-router', () => ({
  useRoute: () => ({
    params: { id: routeState.id },
    name: routeState.name,
    query: routeState.query,
  }),
  useRouter: () => ({ push, replace }),
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
const toastInfo = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: toastSuccess, error: toastError, info: toastInfo }),
}))

let app: App | null = null
let host: HTMLElement | null = null

function mountWith(query: Record<string, string> = {}): HTMLElement {
  routeState.query = query
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(SchoolMembersView)
  app.mount(host)
  return host
}

/** The §1.11 switcher buttons, found by label (Мастера / Ученики). */
function rosterTab(label: string): HTMLButtonElement | null {
  return (
    (Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-segment-track__btn') ?? []).find(
      (b) => b.textContent?.trim() === label,
    ) as HTMLButtonElement | undefined) ?? null
  )
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}

function page(
  items: CuratorGroupMemberItem[],
  total = items.length,
  offset = 0,
): PaginatedCuratorGroupMembersResponse {
  return { items, total, limit: 20, offset }
}

function member(
  id: string,
  overrides: Partial<CuratorGroupMemberItem> = {},
): CuratorGroupMemberItem {
  return {
    user_id: id,
    name: `Участник ${id}`,
    avatar_url: null,
    kind: 'student',
    joined_at: '2026-09-01T00:00:00Z',
    is_visible: true,
    ...overrides,
  }
}

function membersOf(kind: 'master' | 'student', ids: string[]): CuratorGroupMemberItem[] {
  return ids.map((id) => member(id, { kind }))
}

function inputEl(): HTMLInputElement | null {
  return host?.querySelector<HTMLInputElement>('.school-members__search input') ?? null
}

function showMore(): HTMLElement | null {
  return (
    (Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
      b.textContent?.includes('Показать ещё'),
    ) as HTMLElement | undefined) ?? null
  )
}

beforeEach(() => {
  routeState.name = 'user-curator-group-members'
  routeState.id = 'g1'
  routeState.query = {}
  vi.mocked(cgApi.getCuratorGroupMembers).mockReset().mockResolvedValue(page([]))
  push.mockReset()
  replace.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
  toastInfo.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('SchoolMembersView', () => {
  it('defaults to the Мастера tab and loads kind=master without ?kind', async () => {
    vi.mocked(cgApi.getCuratorGroupMembers).mockResolvedValue(
      page(membersOf('master', ['m1', 'm2'])),
    )
    mountWith()
    await flush()

    expect(vi.mocked(cgApi.getCuratorGroupMembers)).toHaveBeenCalledWith('g1', {
      kind: 'master',
      search: undefined,
      limit: 20,
      offset: 0,
    })
    expect(rosterTab('Мастера')?.getAttribute('aria-selected')).toBe('true')
    expect(rosterTab('Ученики')?.getAttribute('aria-selected')).toBe('false')
    expect(text()).toContain('Участник m1')
    expect(text()).toContain('Участник m2')
  })

  it('?kind=student opens the Ученики roster; an unknown value falls back to Мастера', async () => {
    vi.mocked(cgApi.getCuratorGroupMembers).mockResolvedValue(page(membersOf('student', ['s1'])))
    mountWith({ kind: 'student' })
    await flush()

    expect(vi.mocked(cgApi.getCuratorGroupMembers)).toHaveBeenCalledWith(
      'g1',
      expect.objectContaining({ kind: 'student' }),
    )
    expect(rosterTab('Ученики')?.getAttribute('aria-selected')).toBe('true')
    expect(text()).toContain('Участник s1')

    app?.unmount()
    host?.remove()
    vi.mocked(cgApi.getCuratorGroupMembers).mockClear()
    mountWith({ kind: 'banana' })
    await flush()
    expect(vi.mocked(cgApi.getCuratorGroupMembers)).toHaveBeenCalledWith(
      'g1',
      expect.objectContaining({ kind: 'master' }),
    )
  })

  it('switching tabs resets the search, replaces the query and reloads with the new kind', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(cgApi.getCuratorGroupMembers).mockResolvedValue(page(membersOf('student', ['s1'])))
      mountWith({ kind: 'student' })
      await vi.advanceTimersByTimeAsync(0) // initial load

      const input = inputEl()
      input!.value = 'анна'
      input!.dispatchEvent(new Event('input'))
      await vi.advanceTimersByTimeAsync(300)
      expect(vi.mocked(cgApi.getCuratorGroupMembers)).toHaveBeenLastCalledWith(
        'g1',
        expect.objectContaining({ kind: 'student', search: 'анна' }),
      )

      vi.mocked(cgApi.getCuratorGroupMembers).mockClear()
      rosterTab('Мастера')?.click()
      await vi.advanceTimersByTimeAsync(0)

      // One fresh load per switch -- the programmatic search reset must not
      // race the switch's own refresh through the debounced watcher.
      expect(vi.mocked(cgApi.getCuratorGroupMembers)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(cgApi.getCuratorGroupMembers)).toHaveBeenCalledWith('g1', {
        kind: 'master',
        search: undefined,
        limit: 20,
        offset: 0,
      })
      // The tab is server truth in the URL -- replace, not history push.
      expect(replace).toHaveBeenCalledWith({
        name: 'user-curator-group-members',
        params: { id: 'g1' },
        query: { kind: 'master' },
      })
      expect(rosterTab('Мастера')?.getAttribute('aria-selected')).toBe('true')
    } finally {
      vi.useRealTimers()
    }
  })

  it('switching to the active tab is a no-op', async () => {
    mountWith()
    await flush()

    rosterTab('Мастера')?.click()
    await flush()

    expect(replace).not.toHaveBeenCalled()
    expect(vi.mocked(cgApi.getCuratorGroupMembers)).toHaveBeenCalledTimes(1)
  })

  it('no members vs no search hits: two different empties (§1.11.3)', async () => {
    mountWith()
    await flush()
    expect(text()).toContain('В школе пока нет мастеров')

    // A search that returns nothing is a DIFFERENT sentence. The debounce is
    // 300ms real -- wait it out, then let the re-query land.
    vi.mocked(cgApi.getCuratorGroupMembers).mockResolvedValue(page([]))
    const input = inputEl()
    input!.value = 'гриб'
    input!.dispatchEvent(new Event('input'))
    await new Promise((resolve) => setTimeout(resolve, 350))
    await flush()
    expect(text()).toContain('Никого не найдено')
    expect(text()).not.toContain('В школе пока нет мастеров')
  })

  it('search re-queries the same endpoint, trimmed, with kind (§1.11.3)', async () => {
    vi.useFakeTimers()
    try {
      mountWith({ kind: 'student' })
      await vi.advanceTimersByTimeAsync(0) // initial load

      const input = inputEl()
      input!.value = '  анна  '
      input!.dispatchEvent(new Event('input'))
      await vi.advanceTimersByTimeAsync(300)

      expect(vi.mocked(cgApi.getCuratorGroupMembers)).toHaveBeenLastCalledWith('g1', {
        kind: 'student',
        search: 'анна',
        limit: 20,
        offset: 0,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a roster 404 is the SCHOOL being unavailable (P-08), not an empty list', async () => {
    vi.mocked(cgApi.getCuratorGroupMembers).mockRejectedValue(
      new ApiResponseError(404, 'not found', 'not_found'),
    )
    mountWith()
    await flush()

    expect(text()).toContain('Школа недоступна')
    expect(text()).not.toContain('В школе пока нет мастеров')
    // The switcher has nothing to switch on an unavailable school.
    expect(rosterTab('Мастера')).toBeNull()
    expect(rosterTab('Ученики')).toBeNull()

    // The honest exit is going back to the school page -- there is nothing
    // to retry: the school itself is gone for this viewer (P-08).
    const back = (Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
      b.textContent?.includes('К школе'),
    ) ?? null) as HTMLButtonElement | null
    back?.click()
    await flush()
    expect(push).toHaveBeenCalledWith({ name: 'user-curator-group', params: { id: 'g1' } })
  })

  it('student rows push the school-context profile with the row data in query', async () => {
    vi.mocked(cgApi.getCuratorGroupMembers).mockResolvedValue(
      page([member('s9', { name: 'Пётр Сидоров', avatar_url: 'https://x/y.png' })]),
    )
    mountWith({ kind: 'student' })
    await flush()

    const rows = Array.from(host!.querySelectorAll<HTMLButtonElement>('.v-list-row'))
    rows[0]?.click()
    await flush()
    expect(push).toHaveBeenCalledWith({
      name: 'user-curator-group-student',
      params: { groupId: 'g1', userId: 's9' },
      query: { name: 'Пётр Сидоров', avatar: 'https://x/y.png' },
    })
  })

  it('master roster rows push the existing public master profile (no new screen)', async () => {
    vi.mocked(cgApi.getCuratorGroupMembers).mockResolvedValue(page(membersOf('master', ['m9'])))
    mountWith()
    await flush()

    const rows = Array.from(host!.querySelectorAll<HTMLButtonElement>('.v-list-row'))
    rows[0]?.click()
    await flush()
    expect(push).toHaveBeenCalledWith({ name: 'user-master-public', params: { id: 'm9' } })
  })

  it('«Показать ещё» pulls the next page and appends (§1.11.3)', async () => {
    vi.mocked(cgApi.getCuratorGroupMembers)
      .mockResolvedValueOnce(page(membersOf('student', ['s1']), 25))
      .mockResolvedValueOnce({
        items: membersOf('student', ['s21']),
        total: 25,
        limit: 20,
        offset: 20,
      })
    mountWith({ kind: 'student' })
    await flush()

    expect(text()).toContain('Участник s1')
    expect(showMore()).toBeTruthy()

    showMore()?.click()
    await flush()
    // usePagination accumulates offset as the number of LOADED rows (1 after
    // a first page of one fixture row), not the server-echoed offset.
    expect(vi.mocked(cgApi.getCuratorGroupMembers)).toHaveBeenLastCalledWith(
      'g1',
      expect.objectContaining({ kind: 'student', offset: 1 }),
    )
    expect(text()).toContain('Участник s21')
    // 2 of 25 loaded -- still more to pull.
    expect(showMore()).toBeTruthy()
  })

  it('a later-page failure keeps the list and reports through the toast', async () => {
    vi.mocked(cgApi.getCuratorGroupMembers)
      .mockResolvedValueOnce(page(membersOf('student', ['s1']), 25))
      .mockRejectedValueOnce(new ApiResponseError(500, 'boom', 'internal'))
    mountWith({ kind: 'student' })
    await flush()

    showMore()?.click()
    await flush()

    expect(text()).toContain('Участник s1')
    expect(toastError).toHaveBeenCalled()
  })
})
