// =============================================================================
// VELO Frontend -- MasterGroupsView Screen Tests (Master GROUPS P2, PROMPT №591;
// invite wiring P4, PROMPT №593)
// =============================================================================
//
// PATTERN B (local-ref, no store): mirrors MasterStudentsView.test.ts -- state
// lives in local refs fed by direct @/api/groups calls, no Pinia needed. The
// seam is @/api/groups (a hand-written module, mocked wholesale below).
//
// P4: navigator.clipboard does not exist in happy-dom -- defined per test
// (same pattern as MasterPromocodesView.test.ts's writeText mock).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import MasterGroupsView from '@/views/master/MasterGroupsView.vue'
import * as groupsApi from '@/api/groups'
import type { GroupListItem, GroupSearchMemberItem } from '@/api/groups'

vi.mock('@/api/groups')

const push = vi.fn()
const back = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back }),
}))

const toastInfo = vi.fn()
const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ info: toastInfo, error: toastError, success: toastSuccess }),
}))

function group(id: string, overrides: Partial<GroupListItem> = {}): GroupListItem {
  return {
    id,
    kind: 'custom',
    name: `Группа ${id}`,
    members_count: 0,
    description: null,
    ...overrides,
  }
}

function searchItem(overrides: Partial<GroupSearchMemberItem> = {}): GroupSearchMemberItem {
  return {
    student_user_id: 's1',
    name: 'Студент',
    avatar_url: null,
    tag: null,
    group_id: 'g1',
    group_name: 'Группа',
    ...overrides,
  }
}

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(MasterGroupsView)
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

function rows(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.groups__row-wrap') ?? [])
}

beforeEach(() => {
  vi.mocked(groupsApi.getGroups).mockReset().mockResolvedValue({ items: [] })
  vi.mocked(groupsApi.createGroup).mockReset()
  vi.mocked(groupsApi.renameGroup).mockReset()
  vi.mocked(groupsApi.deleteGroup).mockReset()
  vi.mocked(groupsApi.createGroupInvite).mockReset()
  vi.mocked(groupsApi.searchGroupMemberships)
    .mockReset()
    .mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 })
  push.mockReset()
  back.mockReset()
  toastInfo.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null

  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('MasterGroupsView', () => {
  describe('state ladder', () => {
    it('shows the loader while the fetch is in flight', async () => {
      vi.mocked(groupsApi.getGroups).mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(host?.querySelector('.groups__state')).not.toBeNull()
    })

    it('on failure: shows the error state and retry recovers', async () => {
      vi.mocked(groupsApi.getGroups).mockRejectedValueOnce(new Error('boom'))
      mount()
      await flush()
      expect(text()).toContain('Не удалось загрузить группы')

      vi.mocked(groupsApi.getGroups).mockResolvedValue({
        items: [group('g1', { kind: 'students', name: 'Ученики', members_count: 3 })],
      })
      const retry = Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
        b.textContent?.includes('Повторить'),
      )
      retry?.click()
      await flush()

      expect(text()).toContain('Ученики')
      expect(text()).not.toContain('Не удалось загрузить группы')
    })

    it('empty: no groups at all', async () => {
      mount()
      await flush()

      expect(text()).toContain('Групп пока нет')
    })
  })

  describe('content', () => {
    it('renders each group with its name and «Участников: N»', async () => {
      vi.mocked(groupsApi.getGroups).mockResolvedValue({
        items: [
          group('students', { kind: 'students', name: 'Ученики', members_count: 12 }),
          group('g1', { kind: 'custom', name: 'VIP', members_count: 3 }),
        ],
      })
      mount()
      await flush()

      expect(text()).toContain('Ученики')
      expect(text()).toContain('Участников: 12')
      expect(text()).toContain('VIP')
      expect(text()).toContain('Участников: 3')
      expect(rows()).toHaveLength(2)
    })
  })

  describe('preview cap + expander', () => {
    it('shows only the first 5 and hides the rest behind "+ ещё N групп"', async () => {
      vi.mocked(groupsApi.getGroups).mockResolvedValue({
        items: Array.from({ length: 8 }, (_, i) => group(`g${i}`, { name: `Группа${i}` })),
      })
      mount()
      await flush()

      expect(rows()).toHaveLength(5)
      // 8 - 5 = 3 hidden -> plural('группы') for count=3.
      expect(text()).toContain('+ ещё 3 группы')
    })

    it('tapping the expander reveals the full list', async () => {
      vi.mocked(groupsApi.getGroups).mockResolvedValue({
        items: Array.from({ length: 8 }, (_, i) => group(`g${i}`, { name: `Группа${i}` })),
      })
      mount()
      await flush()

      const pill = Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
        b.textContent?.includes('ещё'),
      )
      pill?.click()
      await flush()

      expect(rows()).toHaveLength(8)
    })
  })

  describe('navigation', () => {
    it('tapping a row opens the group detail, carrying id + name', async () => {
      vi.mocked(groupsApi.getGroups).mockResolvedValue({
        items: [group('g1', { kind: 'custom', name: 'VIP' })],
      })
      mount()
      await flush()

      rows()[0]?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({
        name: 'master-group-detail',
        params: { id: 'g1' },
        query: { name: 'VIP' },
      })
    })

    it('the trailing «+» control navigates to the create screen', async () => {
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.groups__add-btn')?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'master-group-create' })
    })
  })

  describe('cross-group search (P6, PROMPT №607)', () => {
    /** Types into the search field and advances past the 300ms debounce
     *  (same window as MasterGroupDetailView's own member search). Requires
     *  vi.useFakeTimers() to already be active in the calling test. */
    async function searchFor(value: string): Promise<void> {
      const input = host?.querySelector<HTMLInputElement>('input')
      if (!input) throw new Error('search input not rendered')
      input.value = value
      input.dispatchEvent(new Event('input'))
      // The watch(search, ...) callback registers its setTimeout on the next
      // tick, not synchronously with the dispatched event -- must yield once
      // BEFORE advancing fake time, or there is no timer yet to advance past
      // (same sequencing MasterGroupDetailView's own debounce test uses).
      await nextTick()
      vi.advanceTimersByTime(300)
      await flush()
    }

    it('a person in two groups renders TWO rows, each with a different group chip (owner-ruled)', async () => {
      vi.useFakeTimers()
      vi.mocked(groupsApi.searchGroupMemberships).mockResolvedValue({
        items: [
          searchItem({ student_user_id: 's1', name: 'Дважды', group_id: 'g1', group_name: 'VIP' }),
          searchItem({ student_user_id: 's1', name: 'Дважды', group_id: 'g2', group_name: 'Утро' }),
        ],
        total: 2,
        limit: 20,
        offset: 0,
      })
      mount()
      await flush()

      await searchFor('Дважды')

      const rows = host?.querySelectorAll<HTMLElement>('.v-list-row') ?? []
      expect(rows).toHaveLength(2)
      const chips = Array.from(host?.querySelectorAll<HTMLElement>('.v-chip') ?? []).map((c) =>
        c.textContent?.trim(),
      )
      expect(chips).toEqual(['VIP', 'Утро'])
    })

    it('a single-membership person renders exactly one row', async () => {
      vi.useFakeTimers()
      vi.mocked(groupsApi.searchGroupMemberships).mockResolvedValue({
        items: [searchItem({ name: 'Одиночка', group_name: 'Утро' })],
        total: 1,
        limit: 20,
        offset: 0,
      })
      mount()
      await flush()

      await searchFor('Один')

      const rows = host?.querySelectorAll<HTMLElement>('.v-list-row') ?? []
      expect(rows).toHaveLength(1)
      expect(rows[0]?.textContent).toContain('Одиночка')
      expect(rows[0]?.textContent).toContain('Утро')
    })

    it('shows the empty state when the search has no matches', async () => {
      vi.useFakeTimers()
      vi.mocked(groupsApi.searchGroupMemberships).mockResolvedValue({
        items: [],
        total: 0,
        limit: 20,
        offset: 0,
      })
      mount()
      await flush()

      await searchFor('Никого-такого-нет')

      expect(text()).toContain('Никого не найдено')
    })

    it('shows the error state when the search fails', async () => {
      vi.useFakeTimers()
      vi.mocked(groupsApi.searchGroupMemberships).mockRejectedValue(new Error('boom'))
      mount()
      await flush()

      await searchFor('Сбой')

      expect(text()).toContain('Не удалось выполнить поиск')
    })

    it('an empty query never calls the search endpoint and falls back to the groups list', async () => {
      vi.mocked(groupsApi.getGroups).mockResolvedValue({
        items: [group('g1', { name: 'Обычная' })],
      })
      mount()
      await flush()

      expect(groupsApi.searchGroupMemberships).not.toHaveBeenCalled()
      expect(text()).toContain('Обычная')
    })
  })

  describe('combined group-name + people search (G1, PROMPT №609)', () => {
    async function searchFor(value: string): Promise<void> {
      const input = host?.querySelector<HTMLInputElement>('input')
      if (!input) throw new Error('search input not rendered')
      input.value = value
      input.dispatchEvent(new Event('input'))
      await nextTick()
      vi.advanceTimersByTime(300)
      await flush()
    }

    it('a group-name match renders instantly under a «Группы» heading', async () => {
      vi.useFakeTimers()
      vi.mocked(groupsApi.getGroups).mockResolvedValue({
        items: [
          group('g1', { name: 'Утренняя йога' }),
          group('g2', { name: 'Вечерняя медитация' }),
        ],
      })
      mount()
      await flush()

      await searchFor('утрен')

      expect(text()).toContain('Группы')
      expect(text()).toContain('Утренняя йога')
      expect(text()).not.toContain('Вечерняя медитация')
      // The SAME query also drives the people search (one field, both
      // kinds run together) -- group-name matching is client-side/instant,
      // but the field itself is shared, so the server-side call still
      // fires; that is the whole point of "one field", not a bug here.
      expect(groupsApi.searchGroupMemberships).toHaveBeenCalledWith('утрен')
    })

    it('a matching group and a matching person render TOGETHER, each under its own heading', async () => {
      vi.useFakeTimers()
      vi.mocked(groupsApi.getGroups).mockResolvedValue({
        items: [group('g1', { name: 'Анна и друзья' })],
      })
      vi.mocked(groupsApi.searchGroupMemberships).mockResolvedValue({
        items: [searchItem({ name: 'Анна Найдётся', group_name: 'VIP' })],
        total: 1,
        limit: 20,
        offset: 0,
      })
      mount()
      await flush()

      await searchFor('Анна')

      const headingIndex = text().indexOf('Группы')
      const peopleHeadingIndex = text().indexOf('Участники')
      expect(headingIndex).toBeGreaterThanOrEqual(0)
      expect(peopleHeadingIndex).toBeGreaterThan(headingIndex)
      expect(text()).toContain('Анна и друзья')
      expect(text()).toContain('Анна Найдётся')
    })

    it('the combined empty state only shows when NEITHER groups nor people match', async () => {
      vi.useFakeTimers()
      vi.mocked(groupsApi.getGroups).mockResolvedValue({
        items: [group('g1', { name: 'Утренняя йога' })],
      })
      vi.mocked(groupsApi.searchGroupMemberships).mockResolvedValue({
        items: [],
        total: 0,
        limit: 20,
        offset: 0,
      })
      mount()
      await flush()

      // Matches the group but no person -> NOT the "nothing found" empty state.
      await searchFor('утрен')
      expect(text()).not.toContain('Никого не найдено')

      // Matches neither -> the combined empty state fires.
      await searchFor('совсемничего')
      expect(text()).toContain('Никого не найдено')
    })
  })
})
