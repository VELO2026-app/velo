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
import * as chatsApi from '@/api/chats'
import { ApiResponseError } from '@/api/client'
import type {
  CuratorGroupMemberItem,
  CuratorGroupPageResponse,
  PaginatedCuratorGroupMembersResponse,
} from '@/api/types'

vi.mock('@/api/curatorGroups')
vi.mock('@/api/chats')

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

function viewerIs(relation: 'curator' | 'master' | 'student'): void {
  vi.mocked(cgApi.getCuratorGroupPage)
    .mockReset()
    .mockResolvedValue({ viewer: { relation } } as unknown as CuratorGroupPageResponse)
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
  vi.mocked(cgApi.getCuratorGroupRoster).mockReset().mockResolvedValue(page([]))
  // BE-76: the screen asks the server who is looking before the first page.
  // Every test above the BE-76 block is the CURATOR's screen, as before.
  viewerIs('curator')
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

  it('master roster rows push the public master profile WITH the school marker (owner 2026-09-30: the curator actions live in its menu)', async () => {
    vi.mocked(cgApi.getCuratorGroupMembers).mockResolvedValue(page(membersOf('master', ['m9'])))
    mountWith()
    await flush()

    const rows = Array.from(host!.querySelectorAll<HTMLButtonElement>('.v-list-row'))
    rows[0]?.click()
    await flush()
    expect(push).toHaveBeenCalledWith({
      name: 'user-master-public',
      params: { id: 'm9' },
      query: { groupId: 'g1', name: 'Участник m9', avatar: '' },
    })
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

  // -- The Блок tab (owner 2026-09-30, BE-79 placeholder) ----------------------

  it('the Блок tab carries the lock glyph and switching to it never calls the API', async () => {
    mountWith()
    await flush()

    const blockTab = rosterTab('Блок')
    expect(blockTab).not.toBeNull()
    expect(blockTab?.querySelector('svg')).not.toBeNull()

    // The master tab's mount fetch already happened; the Блок switch must
    // not add a single call on top of it.
    const callsBefore = vi.mocked(cgApi.getCuratorGroupMembers).mock.calls.length
    blockTab!.click()
    await flush()

    expect(vi.mocked(cgApi.getCuratorGroupMembers).mock.calls.length).toBe(callsBefore)
    expect(replace).toHaveBeenCalledWith(expect.objectContaining({ query: { kind: 'blocked' } }))
    expect(text()).toContain('Пока нет заблокированных')
    expect(inputEl()).toBeNull()
  })

  it('?kind=blocked deep link opens the placeholder without a fetch', async () => {
    mountWith({ kind: 'blocked' })
    await flush()

    expect(vi.mocked(cgApi.getCuratorGroupMembers)).not.toHaveBeenCalled()
    expect(rosterTab('Блок')?.getAttribute('aria-selected')).toBe('true')
    expect(text()).toContain('Пока нет заблокированных')
  })

  it('switching back to Мастера fetches with kind=master again', async () => {
    mountWith({ kind: 'blocked' })
    await flush()
    expect(vi.mocked(cgApi.getCuratorGroupMembers)).not.toHaveBeenCalled()

    vi.mocked(cgApi.getCuratorGroupMembers).mockResolvedValue(page(membersOf('master', ['m1'])))
    rosterTab('Мастера')!.click()
    await flush()

    expect(vi.mocked(cgApi.getCuratorGroupMembers)).toHaveBeenCalledWith('g1', {
      kind: 'master',
      search: undefined,
      limit: 20,
      offset: 0,
    })
    expect(text()).toContain('Участник m1')
  })
})

// =============================================================================
// BE-76: the roster for a MASTER of the school (master zone)
// =============================================================================
//
// The viewer is the server's answer (getCuratorGroupPage -> viewer.relation).
// A school master in the master zone reads /roster (no curator fields), sees
// no «Блок» tab, messages a student straight away and opens a master's public
// page WITHOUT the curator's ?groupId= marker. The user zone is untouched.

function rosterRow(id: string, kind: 'master' | 'student', name: string) {
  return { user_id: id, name, avatar_url: null, kind, joined_at: '2026-09-01T00:00:00Z' }
}

describe('SchoolMembersView -- a master of the school (BE-76)', () => {
  beforeEach(() => {
    routeState.name = 'master-curator-group-members'
    viewerIs('master')
  })

  it('reads /roster (not the curator /members) with the same kind / search / paging', async () => {
    vi.mocked(cgApi.getCuratorGroupRoster).mockResolvedValue({
      items: [rosterRow('m1', 'master', 'Борис')],
      total: 1,
      limit: 20,
      offset: 0,
    })
    mountWith()
    await flush()

    expect(cgApi.getCuratorGroupPage).toHaveBeenCalledWith('g1')
    expect(cgApi.getCuratorGroupRoster).toHaveBeenCalledWith('g1', {
      kind: 'master',
      search: undefined,
      limit: 20,
      offset: 0,
    })
    expect(cgApi.getCuratorGroupMembers).not.toHaveBeenCalled()
    expect(text()).toContain('Борис')
  })

  it('has no «Блок» tab, and ?kind=blocked lands on the masters tab', async () => {
    mountWith({ kind: 'blocked' })
    await flush()

    expect(rosterTab('Мастера')).toBeTruthy()
    expect(rosterTab('Ученики')).toBeTruthy()
    expect(rosterTab('Блок')).toBeNull()
    expect(cgApi.getCuratorGroupRoster).toHaveBeenCalledWith('g1', expect.objectContaining({ kind: 'master' }))
    expect(replace).toHaveBeenCalledWith(expect.objectContaining({ query: { kind: 'master' } }))
  })

  it('a tap on a student opens the message sheet and writes through openStudentChat -- no navigation', async () => {
    vi.mocked(cgApi.getCuratorGroupRoster).mockResolvedValue({
      items: [rosterRow('s9', 'student', 'Пётр Сидоров')],
      total: 1,
      limit: 20,
      offset: 0,
    })
    vi.mocked(chatsApi.openStudentChat).mockResolvedValue({ id: 't1' } as never)
    vi.mocked(chatsApi.sendChatMessage).mockResolvedValue({} as never)
    mountWith({ kind: 'student' })
    await flush()

    host!.querySelector<HTMLButtonElement>('.v-list-row')?.click()
    await flush()
    expect(push).not.toHaveBeenCalled()
    expect(document.body.querySelector('.send-msg__name')?.textContent).toContain('Пётр Сидоров')

    const area = document.body.querySelector<HTMLTextAreaElement>('.send-msg textarea')!
    area.value = 'Здравствуйте'
    area.dispatchEvent(new Event('input'))
    await flush()
    const send = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Отправить',
    )
    send?.click()
    await flush()
    expect(chatsApi.openStudentChat).toHaveBeenCalledWith('s9')
    expect(chatsApi.openChat).not.toHaveBeenCalled()
  })

  it('a tap on a master opens his public page WITHOUT the curator marker', async () => {
    vi.mocked(cgApi.getCuratorGroupRoster).mockResolvedValue({
      items: [rosterRow('m9', 'master', 'Борис')],
      total: 1,
      limit: 20,
      offset: 0,
    })
    mountWith()
    await flush()

    host!.querySelector<HTMLButtonElement>('.v-list-row')?.click()
    await flush()
    expect(push).toHaveBeenCalledWith({
      name: 'user-master-public',
      params: { id: 'm9' },
      query: { name: 'Борис', avatar: '' },
    })
  })

  it('the user zone is untouched: a master there still goes through the curator /members', async () => {
    routeState.name = 'user-curator-group-members'
    mountWith()
    await flush()

    expect(cgApi.getCuratorGroupMembers).toHaveBeenCalled()
    expect(cgApi.getCuratorGroupRoster).not.toHaveBeenCalled()
  })
})

