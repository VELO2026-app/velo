// =============================================================================
// VELO Frontend -- MasterGroupDetailView Screen Tests
// (Master GROUPS P2 ПРОМТ №591, unblock added P3 ПРОМТ №592, invite CTA P4
// ПРОМТ №593)
// =============================================================================
//
// One component parametrised by :id (a custom group's UUID, or the system
// slugs "students" / "deleted") -- `kind` is derived from the id string
// itself, so these three cases are exercised by mutating routeParams.id,
// same idiom as MasterPublicView.test.ts's route-param mutation tests.
//
// P4: navigator.clipboard does not exist in happy-dom -- defined per test
// (same pattern as MasterGroupsView.test.ts's writeText mock).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import MasterGroupDetailView from '@/views/master/MasterGroupDetailView.vue'
import * as groupsApi from '@/api/groups'
import type { GroupMemberItem, GroupListItem } from '@/api/groups'

vi.mock('@/api/groups')

const push = vi.fn()
const back = vi.fn()
const routeParams: { id: string } = { id: 'g1' }
const routeQuery: { name: string } = { name: 'VIP' }
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back }),
  useRoute: () => ({ params: routeParams, query: routeQuery }),
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: vi.fn() }),
}))

function member(id: string, overrides: Partial<GroupMemberItem> = {}): GroupMemberItem {
  return {
    id,
    name: `Ученик ${id}`,
    avatar_url: null,
    tag: null,
    ...overrides,
  }
}

function page(items: GroupMemberItem[]) {
  return { items, total: items.length, limit: 20, offset: 0 }
}

function customGroups(items: GroupListItem[] = []) {
  return { items }
}

let writeText: ReturnType<typeof vi.fn>
let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(MasterGroupDetailView)
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
  return Array.from(host?.querySelectorAll<HTMLElement>('.group-detail__row-wrap') ?? [])
}

function sheetOverlay(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('.v-sheet__overlay')
}
function modalOverlay(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('.v-modal__overlay')
}

beforeEach(() => {
  routeParams.id = 'g1'
  routeQuery.name = 'VIP'
  vi.mocked(groupsApi.getGroupMembers).mockReset().mockResolvedValue(page([]))
  vi.mocked(groupsApi.getGroups).mockReset().mockResolvedValue(customGroups([]))
  vi.mocked(groupsApi.setStudentTag).mockReset()
  vi.mocked(groupsApi.addGroupMember).mockReset()
  vi.mocked(groupsApi.removeGroupMember).mockReset()
  vi.mocked(groupsApi.unblockStudent).mockReset()
  vi.mocked(groupsApi.createGroupInvite).mockReset()
  push.mockReset()
  back.mockReset()
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
  vi.useRealTimers()
})

describe('MasterGroupDetailView', () => {
  it('header reads Группа "{name}" from the route query', async () => {
    mount()
    await flush()

    expect(text()).toContain('Группа "VIP"')
  })

  describe('state ladder', () => {
    it('shows the loader while the fetch is in flight', async () => {
      vi.mocked(groupsApi.getGroupMembers).mockReturnValue(new Promise(() => {}))
      mount()
      await flush()

      expect(host?.querySelector('.group-detail__state')).not.toBeNull()
    })

    it('on failure: shows the error state and retry recovers', async () => {
      vi.mocked(groupsApi.getGroupMembers).mockRejectedValueOnce(new Error('boom'))
      mount()
      await flush()
      expect(text()).toContain('Не удалось загрузить участников')

      vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(page([member('s1', { name: 'Анна' })]))
      const retry = Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
        b.textContent?.includes('Повторить'),
      )
      retry?.click()
      await flush()

      expect(text()).toContain('Анна')
    })

    it('empty (not deleted): "Участников пока нет"', async () => {
      mount()
      await flush()

      expect(text()).toContain('Участников пока нет')
    })

    it('empty (deleted group): "Никого не заблокировали"', async () => {
      routeParams.id = 'deleted'
      routeQuery.name = 'Удалённые'
      mount()
      await flush()

      expect(text()).toContain('Никого не заблокировали')
    })
  })

  describe('content', () => {
    it('renders each member with name and, when present, their tag', async () => {
      vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(
        page([
          member('s1', { name: 'Анна', tag: 'VIP-клиент' }),
          member('s2', { name: 'Борис', tag: null }),
        ]),
      )
      mount()
      await flush()

      expect(rows()).toHaveLength(2)
      expect(text()).toContain('Анна')
      expect(text()).toContain('VIP-клиент')
      expect(text()).toContain('Борис')
    })
  })

  describe('per-row «⋯» action set by kind', () => {
    it('custom group: 3 actions -- add to group / add tag / remove from group', async () => {
      routeParams.id = 'g1'
      vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(page([member('s1', { name: 'Анна' })]))
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.v-menu__trigger')?.click()
      await flush()

      const items = host?.querySelectorAll('.v-menu-item') ?? []
      expect(items).toHaveLength(3)
    })

    it('«Ученики»: 2 actions -- add to group / add tag, NO remove', async () => {
      routeParams.id = 'students'
      vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(page([member('s1', { name: 'Анна' })]))
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.v-menu__trigger')?.click()
      await flush()

      const items = host?.querySelectorAll('.v-menu-item') ?? []
      expect(items).toHaveLength(2)
    })

    it('«Удалённые» (P3): only ONE «⋯» action -- «Разблокировать», nothing else', async () => {
      routeParams.id = 'deleted'
      vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(page([member('s1', { name: 'Анна' })]))
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.v-menu__trigger')?.click()
      await flush()

      const items = host?.querySelectorAll<HTMLElement>('.v-menu-item') ?? []
      expect(items).toHaveLength(1)
      expect(items[0]?.getAttribute('aria-label')).toBe('Разблокировать')
    })
  })

  describe('search (server-side, debounced)', () => {
    it('calls getGroupMembers with ?search= after the debounce window, not on every keystroke', async () => {
      vi.useFakeTimers()
      mount()
      await flush()
      expect(groupsApi.getGroupMembers).toHaveBeenCalledTimes(1)
      expect(groupsApi.getGroupMembers).toHaveBeenLastCalledWith('g1', '')

      const input = host?.querySelector<HTMLInputElement>('input')
      input!.value = 'ан'
      input!.dispatchEvent(new Event('input'))
      await nextTick()
      expect(groupsApi.getGroupMembers).toHaveBeenCalledTimes(1) // not yet

      vi.advanceTimersByTime(300)
      await nextTick()

      expect(groupsApi.getGroupMembers).toHaveBeenCalledTimes(2)
      expect(groupsApi.getGroupMembers).toHaveBeenLastCalledWith('g1', 'ан')
    })
  })

  describe('navigation', () => {
    it('tapping a member row opens the student profile, carrying the name forward', async () => {
      vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(page([member('s1', { name: 'Анна' })]))
      mount()
      await flush()

      rows()[0]?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({
        name: 'master-student-profile',
        params: { id: 's1' },
        query: { name: 'Анна' },
      })
    })
  })

  describe('AddTagSheet', () => {
    it('opening "Добавить тег" and saving calls setStudentTag with the trimmed value', async () => {
      vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(page([member('s1', { name: 'Анна' })]))
      vi.mocked(groupsApi.setStudentTag).mockResolvedValue({ student_user_id: 's1', tag: 'Тег1' })
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.v-menu__trigger')?.click()
      await flush()
      const addTagBtn = Array.from(host?.querySelectorAll<HTMLElement>('.v-menu-item') ?? [])[1]
      addTagBtn?.click()
      await flush()

      const input = sheetOverlay()?.querySelector<HTMLInputElement>('input')
      input!.value = '  Тег1  '
      input!.dispatchEvent(new Event('input'))
      sheetOverlay()?.querySelector<HTMLElement>('.v-sheet__save')?.click()
      await flush()

      expect(groupsApi.setStudentTag).toHaveBeenCalledWith('s1', 'Тег1')
    })
  })

  describe('AddToGroupSheet', () => {
    it('opening "Добавить в группу", selecting a group and saving calls addGroupMember', async () => {
      vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(page([member('s1', { name: 'Анна' })]))
      vi.mocked(groupsApi.getGroups).mockResolvedValue(
        customGroups([{ id: 'g2', kind: 'custom', name: 'Другая группа', members_count: 0 }]),
      )
      vi.mocked(groupsApi.addGroupMember).mockResolvedValue(undefined)
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.v-menu__trigger')?.click()
      await flush()
      const addToGroupBtn = Array.from(host?.querySelectorAll<HTMLElement>('.v-menu-item') ?? [])[0]
      addToGroupBtn?.click()
      await flush()

      const chip = Array.from(sheetOverlay()?.querySelectorAll<HTMLElement>('.v-chip') ?? []).find(
        (c) => c.textContent?.includes('Другая группа'),
      )
      chip?.click()
      await nextTick()
      sheetOverlay()?.querySelector<HTMLElement>('.v-sheet__save')?.click()
      await flush()

      expect(groupsApi.addGroupMember).toHaveBeenCalledWith('g2', 's1')
    })
  })

  describe('RemoveFromGroupSheet (custom groups only)', () => {
    it('default mode "current" calls removeGroupMember on the current group', async () => {
      routeParams.id = 'g1'
      vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(page([member('s1', { name: 'Анна' })]))
      vi.mocked(groupsApi.removeGroupMember).mockResolvedValue(undefined)
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.v-menu__trigger')?.click()
      await flush()
      const removeBtn = Array.from(host?.querySelectorAll<HTMLElement>('.v-menu-item') ?? [])[2]
      removeBtn?.click()
      await flush()

      sheetOverlay()?.querySelector<HTMLElement>('.v-sheet__save')?.click()
      await flush()

      expect(groupsApi.removeGroupMember).toHaveBeenCalledWith('g1', 's1')
    })

    it('"Удалить из всех групп" loops every custom group (idempotent DELETE, no dedicated endpoint)', async () => {
      routeParams.id = 'g1'
      vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(page([member('s1', { name: 'Анна' })]))
      vi.mocked(groupsApi.getGroups).mockResolvedValue(
        customGroups([
          { id: 'g1', kind: 'custom', name: 'VIP', members_count: 1 },
          { id: 'g2', kind: 'custom', name: 'Другая', members_count: 0 },
        ]),
      )
      vi.mocked(groupsApi.removeGroupMember).mockResolvedValue(undefined)
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.v-menu__trigger')?.click()
      await flush()
      const removeBtn = Array.from(host?.querySelectorAll<HTMLElement>('.v-menu-item') ?? [])[2]
      removeBtn?.click()
      await flush()

      const allRadio = Array.from(
        sheetOverlay()?.querySelectorAll<HTMLElement>('.v-radio') ?? [],
      ).find((r) => r.textContent?.includes('Удалить из всех групп'))
      allRadio?.click()
      await nextTick()
      sheetOverlay()?.querySelector<HTMLElement>('.v-sheet__save')?.click()
      await flush()

      expect(groupsApi.removeGroupMember).toHaveBeenCalledWith('g1', 's1')
      expect(groupsApi.removeGroupMember).toHaveBeenCalledWith('g2', 's1')
      expect(groupsApi.removeGroupMember).toHaveBeenCalledTimes(2)
    })

    it('is never offered on «Ученики» or «Удалённые» -- only 2/0 menu items there', async () => {
      routeParams.id = 'students'
      vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(page([member('s1', { name: 'Анна' })]))
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.v-menu__trigger')?.click()
      await flush()

      const labels = Array.from(host?.querySelectorAll<HTMLElement>('.v-menu-item') ?? []).map(
        (b) => b.getAttribute('aria-label'),
      )
      expect(labels).not.toContain('Удалить из группы')
    })
  })

  describe('Unblock («Удалённые» rows only, P3 ПРОМТ №592)', () => {
    it('opens the confirm with the member name in the title and message', async () => {
      routeParams.id = 'deleted'
      vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(page([member('s1', { name: 'Анна' })]))
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.v-menu__trigger')?.click()
      await flush()
      host?.querySelector<HTMLElement>('.v-menu-item')?.click()
      await flush()

      const dialogText = modalOverlay()?.textContent ?? ''
      expect(dialogText).toContain('Разблокировать Анна?')
      expect(dialogText).toContain(
        'Анна вернется в группу «Ученики» и снова сможет видеть и бронировать ваши практики.',
      )
    })

    it('confirming calls unblockStudent, toasts, and reloads the (now shorter) list', async () => {
      routeParams.id = 'deleted'
      vi.mocked(groupsApi.getGroupMembers).mockResolvedValueOnce(
        page([member('s1', { name: 'Анна' })]),
      )
      vi.mocked(groupsApi.unblockStudent).mockResolvedValue(undefined)
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.v-menu__trigger')?.click()
      await flush()
      host?.querySelector<HTMLElement>('.v-menu-item')?.click()
      await flush()

      vi.mocked(groupsApi.getGroupMembers).mockResolvedValueOnce(page([])) // reloaded: gone
      const confirmBtn = Array.from(modalOverlay()?.querySelectorAll('button') ?? []).find(
        (b) => b.textContent?.trim() === 'Разблокировать',
      )
      confirmBtn?.click()
      await flush()

      expect(groupsApi.unblockStudent).toHaveBeenCalledWith('s1')
      expect(toastSuccess).toHaveBeenCalledWith('Пользователь разблокирован')
      expect(groupsApi.getGroupMembers).toHaveBeenCalledTimes(2) // initial + reload
    })

    it('«Отмена» dismisses without calling unblockStudent', async () => {
      routeParams.id = 'deleted'
      vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(page([member('s1', { name: 'Анна' })]))
      mount()
      await flush()

      host?.querySelector<HTMLElement>('.v-menu__trigger')?.click()
      await flush()
      host?.querySelector<HTMLElement>('.v-menu-item')?.click()
      await flush()

      const cancelBtn = Array.from(modalOverlay()?.querySelectorAll('button') ?? []).find(
        (b) => b.textContent?.trim() === 'Отмена',
      )
      cancelBtn?.click()
      await flush()

      expect(groupsApi.unblockStudent).not.toHaveBeenCalled()
      // happy-dom never runs the real leave transition -- the overlay node
      // itself stays in the DOM, but Vue has already applied the leave
      // classes (same idiom AdminMethodRequestsView.test.ts uses).
      expect(modalOverlay()?.classList.contains('v-modal-leave-active')).toBe(true)
    })
  })

  describe('empty-group invite CTA (P4, ПРОМТ №593)', () => {
    it('an empty CUSTOM group shows «Пригласить в группу», which creates + copies + toasts', async () => {
      routeParams.id = 'g1' // custom
      vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(page([]))
      vi.mocked(groupsApi.createGroupInvite).mockResolvedValue({
        invite_url: 'https://t.me/velo_bot?startapp=group_invite__xyz',
      })
      mount()
      await flush()

      const invite = Array.from(host?.querySelectorAll<HTMLElement>('button') ?? []).find(
        (b) => b.textContent?.trim() === 'Пригласить в группу',
      )
      expect(invite).toBeDefined()
      invite?.click()
      await flush()

      expect(groupsApi.createGroupInvite).toHaveBeenCalledWith('g1')
      expect(writeText).toHaveBeenCalledWith('https://t.me/velo_bot?startapp=group_invite__xyz')
      expect(toastSuccess).toHaveBeenCalledWith('Ссылка скопирована')
    })

    it('never renders on the system groups («Ученики»/«Удалённые»), even when empty', async () => {
      for (const id of ['students', 'deleted']) {
        routeParams.id = id
        vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(page([]))
        mount()
        await flush()

        const invite = Array.from(host?.querySelectorAll<HTMLElement>('button') ?? []).find(
          (b) => b.textContent?.trim() === 'Пригласить в группу',
        )
        expect(invite).toBeUndefined()

        app?.unmount()
        host?.remove()
      }
    })

    it('does not render while a search filter is active (empty-search offers "clear", not "invite")', async () => {
      vi.useFakeTimers()
      routeParams.id = 'g1'
      vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(page([]))
      mount()
      await flush()

      const input = host?.querySelector<HTMLInputElement>('input')
      input!.value = 'zzz'
      input!.dispatchEvent(new Event('input'))
      vi.advanceTimersByTime(300)
      await flush()

      const invite = Array.from(host?.querySelectorAll<HTMLElement>('button') ?? []).find(
        (b) => b.textContent?.trim() === 'Пригласить в группу',
      )
      expect(invite).toBeUndefined()
    })

    it('a failed invite create surfaces an error toast', async () => {
      routeParams.id = 'g1'
      vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(page([]))
      vi.mocked(groupsApi.createGroupInvite).mockRejectedValue(new Error('boom'))
      mount()
      await flush()

      const invite = Array.from(host?.querySelectorAll<HTMLElement>('button') ?? []).find(
        (b) => b.textContent?.trim() === 'Пригласить в группу',
      )
      invite?.click()
      await flush()

      expect(writeText).not.toHaveBeenCalled()
      expect(toastError).toHaveBeenCalledWith('Не удалось создать ссылку')
    })
  })
})
