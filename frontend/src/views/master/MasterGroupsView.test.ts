// =============================================================================
// VELO Frontend -- MasterGroupsView Screen Tests (Master GROUPS P2, ПРОМТ №591;
// invite wiring P4, ПРОМТ №593)
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
import type { GroupListItem } from '@/api/groups'

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
    ...overrides,
  }
}

let writeText: ReturnType<typeof vi.fn>
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

// Two DIFFERENT teleported surfaces (VBottomSheet / VConfirmDialog's VModal)
// -- never query `host` for either (same discipline as
// AdminMethodRequestsView.test.ts).
function sheetOverlay(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('.v-sheet__overlay')
}
function modalOverlay(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('.v-modal__overlay')
}

beforeEach(() => {
  vi.mocked(groupsApi.getGroups).mockReset().mockResolvedValue({ items: [] })
  vi.mocked(groupsApi.createGroup).mockReset()
  vi.mocked(groupsApi.renameGroup).mockReset()
  vi.mocked(groupsApi.deleteGroup).mockReset()
  vi.mocked(groupsApi.createGroupInvite).mockReset()
  push.mockReset()
  back.mockReset()
  toastInfo.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()

  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    writable: true,
    value: { writeText },
  })
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null

  document.body.querySelectorAll('.v-sheet__overlay').forEach((el) => el.remove())
  document.body.querySelectorAll('.v-modal__overlay').forEach((el) => el.remove())

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

    it('only custom rows get a «⋯» menu -- system rows (students/deleted) have none', async () => {
      vi.mocked(groupsApi.getGroups).mockResolvedValue({
        items: [
          group('students', { kind: 'students', name: 'Ученики' }),
          group('deleted', { kind: 'deleted', name: 'Удалённые' }),
          group('g1', { kind: 'custom', name: 'VIP' }),
        ],
      })
      mount()
      await flush()

      const menus = host?.querySelectorAll('.v-menu__trigger') ?? []
      expect(menus).toHaveLength(1)
    })
  })

  describe('preview cap + expander', () => {
    it('shows only the first 10 and hides the rest behind "+ ещё N групп"', async () => {
      vi.mocked(groupsApi.getGroups).mockResolvedValue({
        items: Array.from({ length: 13 }, (_, i) => group(`g${i}`, { name: `Группа${i}` })),
      })
      mount()
      await flush()

      expect(rows()).toHaveLength(10)
      // 13 - 10 = 3 hidden -> plural('группы') for count=3.
      expect(text()).toContain('+ ещё 3 группы')
    })

    it('tapping the expander reveals the full list', async () => {
      vi.mocked(groupsApi.getGroups).mockResolvedValue({
        items: Array.from({ length: 13 }, (_, i) => group(`g${i}`, { name: `Группа${i}` })),
      })
      mount()
      await flush()

      const pill = Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
        b.textContent?.includes('ещё'),
      )
      pill?.click()
      await flush()

      expect(rows()).toHaveLength(13)
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

    it('«Пригласить в группу» creates the invite, copies it, and toasts (P4)', async () => {
      vi.mocked(groupsApi.getGroups).mockResolvedValue({
        items: [group('g1', { kind: 'custom', name: 'VIP' })],
      })
      vi.mocked(groupsApi.createGroupInvite).mockResolvedValue({
        invite_url: 'https://t.me/velo_bot?startapp=group_invite__abc123',
      })
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.groups__invite-btn')?.click()
      await flush()

      expect(groupsApi.createGroupInvite).toHaveBeenCalledWith('g1')
      expect(writeText).toHaveBeenCalledWith('https://t.me/velo_bot?startapp=group_invite__abc123')
      expect(toastSuccess).toHaveBeenCalledWith('Ссылка скопирована')
      expect(push).not.toHaveBeenCalled()
    })

    it('a failed invite create surfaces an error toast, not a silent no-op', async () => {
      vi.mocked(groupsApi.getGroups).mockResolvedValue({
        items: [group('g1', { kind: 'custom', name: 'VIP' })],
      })
      vi.mocked(groupsApi.createGroupInvite).mockRejectedValue(new Error('boom'))
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.groups__invite-btn')?.click()
      await flush()

      expect(writeText).not.toHaveBeenCalled()
      expect(toastError).toHaveBeenCalledWith('Не удалось создать ссылку')
    })

    it('system groups («Ученики»/«Удалённые») render no invite button', async () => {
      vi.mocked(groupsApi.getGroups).mockResolvedValue({
        items: [
          group('students', { kind: 'students', name: 'Ученики' }),
          group('deleted', { kind: 'deleted', name: 'Удалённые' }),
        ],
      })
      mount()
      await flush()

      expect(host?.querySelectorAll('.groups__invite-btn')).toHaveLength(0)
    })
  })

  describe('rename (custom groups only)', () => {
    it('opens the sheet pre-filled with the current name and saves via renameGroup', async () => {
      vi.mocked(groupsApi.getGroups).mockResolvedValue({
        items: [group('g1', { kind: 'custom', name: 'Старое' })],
      })
      vi.mocked(groupsApi.renameGroup).mockResolvedValue({
        id: 'g1',
        name: 'Новое',
        members_count: 0,
      })
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.v-menu__trigger')?.click()
      await flush()
      const renameBtn = Array.from(host?.querySelectorAll<HTMLElement>('.v-menu-item') ?? [])[0]
      renameBtn?.click()
      await flush()

      const input = sheetOverlay()?.querySelector<HTMLInputElement>('input')
      expect(input?.value).toBe('Старое')

      input!.value = 'Новое'
      input!.dispatchEvent(new Event('input'))
      const saveBtn = sheetOverlay()?.querySelector<HTMLElement>('.v-sheet__save')
      saveBtn?.click()
      await flush()

      expect(groupsApi.renameGroup).toHaveBeenCalledWith('g1', 'Новое')
    })
  })

  describe('delete (custom groups only)', () => {
    it('confirming the dialog calls deleteGroup and reloads', async () => {
      vi.mocked(groupsApi.getGroups).mockResolvedValue({
        items: [group('g1', { kind: 'custom', name: 'Временная' })],
      })
      vi.mocked(groupsApi.deleteGroup).mockResolvedValue(undefined)
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.v-menu__trigger')?.click()
      await flush()
      const deleteBtn = Array.from(host?.querySelectorAll<HTMLElement>('.v-menu-item') ?? [])[1]
      deleteBtn?.click()
      await flush()

      const dialogText = modalOverlay()?.textContent ?? ''
      expect(dialogText).toContain('Удалить группу «Временная»?')
      expect(dialogText).toContain('Участники вернутся в группу «Ученики»')

      const confirmBtn = Array.from(modalOverlay()?.querySelectorAll('button') ?? []).find(
        (b) => b.textContent?.trim() === 'Удалить',
      )
      confirmBtn?.click()
      await flush()

      expect(groupsApi.deleteGroup).toHaveBeenCalledWith('g1')
    })
  })
})
