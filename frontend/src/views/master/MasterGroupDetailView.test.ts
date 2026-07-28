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
import { ApiResponseError } from '@/api/client'
import type { GroupMemberItem, GroupListItem } from '@/api/groups'

vi.mock('@/api/groups')

const push = vi.fn()
const back = vi.fn()
const replace = vi.fn()
const routeParams: { id: string } = { id: 'g1' }
const routeQuery: { name: string } = { name: 'VIP' }
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back, replace }),
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
  // Owner Q12 (ПРОМТ №611): the screen's own load chain is now SEQUENTIAL
  // (loadGroups() -- resolving name/description + existence -- awaited
  // BEFORE the members fetch, not parallel), so it needs more ticks to
  // settle than the previous single-round-trip flow did.
  for (let i = 0; i < 6; i += 1) {
    await nextTick()
  }
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
  // Owner Q12 (ПРОМТ №611): the screen now resolves its own name/description
  // by matching THIS group's id in getGroups()' response -- the default
  // mock must include an entry for every id the suite defaults to ('g1',
  // 'students'), or the new "not found" path fires and blocks the members
  // fetch. 'deleted' is exempt (list_master_groups omits it when empty,
  // which is a normal state, not not-found) -- no entry needed for it.
  vi.mocked(groupsApi.getGroups)
    .mockReset()
    .mockResolvedValue(
      customGroups([
        { id: 'students', kind: 'students', name: 'Ученики', members_count: 0, description: null },
        { id: 'g1', kind: 'custom', name: 'VIP', members_count: 0, description: null },
      ]),
    )
  vi.mocked(groupsApi.setStudentTag).mockReset()
  vi.mocked(groupsApi.addGroupMember).mockReset()
  vi.mocked(groupsApi.removeGroupMember).mockReset()
  vi.mocked(groupsApi.unblockStudent).mockReset()
  vi.mocked(groupsApi.createGroupInvite).mockReset()
  vi.mocked(groupsApi.renameGroup).mockReset()
  vi.mocked(groupsApi.deleteGroup).mockReset()
  push.mockReset()
  back.mockReset()
  replace.mockReset()
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
  it('header reads Группа "{name}" (API-resolved, matching the default mock)', async () => {
    mount()
    await flush()

    expect(text()).toContain('Группа "VIP"')
  })

  describe('owner Q12 (ПРОМТ №611): API-driven name/description, not the URL', () => {
    it('shows the route.query hint on first paint, before getGroups() resolves', async () => {
      routeQuery.name = 'Из query'
      vi.mocked(groupsApi.getGroups).mockReturnValue(new Promise(() => {}))
      mount()
      await nextTick()

      expect(text()).toContain('Группа "Из query"')
    })

    it('the API answer OVERWRITES the query hint once it resolves, even to a different value', async () => {
      routeQuery.name = 'Устаревшее'
      vi.mocked(groupsApi.getGroups).mockResolvedValue(
        customGroups([
          { id: 'g1', kind: 'custom', name: 'Актуальное', members_count: 0, description: null },
        ]),
      )
      mount()
      await flush()

      expect(text()).toContain('Группа "Актуальное"')
      expect(text()).not.toContain('Устаревшее')
    })

    it('a cold reload with NO query at all still resolves the correct name from the API (the bug this fixes)', async () => {
      routeQuery.name = ''
      vi.mocked(groupsApi.getGroups).mockResolvedValue(
        customGroups([
          { id: 'g1', kind: 'custom', name: 'Из API', members_count: 0, description: null },
        ]),
      )
      mount()
      await flush()

      expect(text()).toContain('Группа "Из API"')
    })

    it('description follows the same rule -- API value wins, including clearing a stale query hint to empty', async () => {
      routeQuery.name = 'VIP'
      vi.mocked(groupsApi.getGroups).mockResolvedValue(
        customGroups([
          { id: 'g1', kind: 'custom', name: 'VIP', description: null, members_count: 0 },
        ]),
      )
      mount()
      await flush()

      expect(host?.querySelector('.group-detail__description')).toBeNull()
    })

    it('id not present in getGroups() (deleted/wrong id) shows the existing error state, not a blank header', async () => {
      vi.mocked(groupsApi.getGroups).mockResolvedValue(customGroups([]))
      mount()
      await flush()

      expect(host?.querySelector('.group-detail__state')).toBeNull() // not stuck loading
      expect(text()).toContain('Группа не найдена')
      expect(groupsApi.getGroupMembers).not.toHaveBeenCalled()
    })

    it('an EMPTY «Удалённые» (absent from getGroups() because its count is 0) is NOT treated as not-found', async () => {
      routeParams.id = 'deleted'
      vi.mocked(groupsApi.getGroups).mockResolvedValue(customGroups([]))
      vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(page([]))
      mount()
      await flush()

      expect(text()).not.toContain('Группа не найдена')
      expect(groupsApi.getGroupMembers).toHaveBeenCalledWith('deleted', '')
    })
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

      // Scoped to a MEMBER row (not `host` globally): G2's header menu
      // (ПРОМТ №609) also renders a `.v-menu__trigger` for custom groups,
      // which an unscoped query would match FIRST, opening the wrong menu.
      host?.querySelector<HTMLElement>('.group-detail__row-wrap .v-menu__trigger')?.click()
      await flush()

      const items = host?.querySelectorAll('.v-menu-item') ?? []
      expect(items).toHaveLength(3)
    })

    it('«Ученики»: 2 actions -- add to group / add tag, NO remove', async () => {
      routeParams.id = 'students'
      vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(page([member('s1', { name: 'Анна' })]))
      mount()
      await flush()

      // Scoped to a MEMBER row (not `host` globally): G2's header menu
      // (ПРОМТ №609) also renders a `.v-menu__trigger` for custom groups,
      // which an unscoped query would match FIRST, opening the wrong menu.
      host?.querySelector<HTMLElement>('.group-detail__row-wrap .v-menu__trigger')?.click()
      await flush()

      const items = host?.querySelectorAll('.v-menu-item') ?? []
      expect(items).toHaveLength(2)
    })

    it('«Удалённые» (P3): only ONE «⋯» action -- «Разблокировать», nothing else', async () => {
      routeParams.id = 'deleted'
      vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(page([member('s1', { name: 'Анна' })]))
      mount()
      await flush()

      // Scoped to a MEMBER row (not `host` globally): G2's header menu
      // (ПРОМТ №609) also renders a `.v-menu__trigger` for custom groups,
      // which an unscoped query would match FIRST, opening the wrong menu.
      host?.querySelector<HTMLElement>('.group-detail__row-wrap .v-menu__trigger')?.click()
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

      // Scoped to a MEMBER row (not `host` globally): G2's header menu
      // (ПРОМТ №609) also renders a `.v-menu__trigger` for custom groups,
      // which an unscoped query would match FIRST, opening the wrong menu.
      host?.querySelector<HTMLElement>('.group-detail__row-wrap .v-menu__trigger')?.click()
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
        customGroups([
          { id: 'g1', kind: 'custom', name: 'VIP', members_count: 1, description: null },
          { id: 'g2', kind: 'custom', name: 'Другая группа', members_count: 0, description: null },
        ]),
      )
      vi.mocked(groupsApi.addGroupMember).mockResolvedValue(undefined)
      mount()
      await flush()

      // Scoped to a MEMBER row (not `host` globally): G2's header menu
      // (ПРОМТ №609) also renders a `.v-menu__trigger` for custom groups,
      // which an unscoped query would match FIRST, opening the wrong menu.
      host?.querySelector<HTMLElement>('.group-detail__row-wrap .v-menu__trigger')?.click()
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

      // Scoped to a MEMBER row (not `host` globally): G2's header menu
      // (ПРОМТ №609) also renders a `.v-menu__trigger` for custom groups,
      // which an unscoped query would match FIRST, opening the wrong menu.
      host?.querySelector<HTMLElement>('.group-detail__row-wrap .v-menu__trigger')?.click()
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
          { id: 'g1', kind: 'custom', name: 'VIP', members_count: 1, description: null },
          { id: 'g2', kind: 'custom', name: 'Другая', members_count: 0, description: null },
        ]),
      )
      vi.mocked(groupsApi.removeGroupMember).mockResolvedValue(undefined)
      mount()
      await flush()

      // Scoped to a MEMBER row (not `host` globally): G2's header menu
      // (ПРОМТ №609) also renders a `.v-menu__trigger` for custom groups,
      // which an unscoped query would match FIRST, opening the wrong menu.
      host?.querySelector<HTMLElement>('.group-detail__row-wrap .v-menu__trigger')?.click()
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

      // Scoped to a MEMBER row (not `host` globally): G2's header menu
      // (ПРОМТ №609) also renders a `.v-menu__trigger` for custom groups,
      // which an unscoped query would match FIRST, opening the wrong menu.
      host?.querySelector<HTMLElement>('.group-detail__row-wrap .v-menu__trigger')?.click()
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

      // Scoped to a MEMBER row (not `host` globally): G2's header menu
      // (ПРОМТ №609) also renders a `.v-menu__trigger` for custom groups,
      // which an unscoped query would match FIRST, opening the wrong menu.
      host?.querySelector<HTMLElement>('.group-detail__row-wrap .v-menu__trigger')?.click()
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

      // Scoped to a MEMBER row (not `host` globally): G2's header menu
      // (ПРОМТ №609) also renders a `.v-menu__trigger` for custom groups,
      // which an unscoped query would match FIRST, opening the wrong menu.
      host?.querySelector<HTMLElement>('.group-detail__row-wrap .v-menu__trigger')?.click()
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

      // Scoped to a MEMBER row (not `host` globally): G2's header menu
      // (ПРОМТ №609) also renders a `.v-menu__trigger` for custom groups,
      // which an unscoped query would match FIRST, opening the wrong menu.
      host?.querySelector<HTMLElement>('.group-detail__row-wrap .v-menu__trigger')?.click()
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

  describe('invite via header menu on an EMPTY group (owner Q8, ПРОМТ №610 -- the old empty-state CTA button was removed as a duplicate; this is now the only path)', () => {
    function headerMenuTrigger(): HTMLElement | null {
      return host?.querySelector<HTMLElement>('.v-header__right .v-menu__trigger') ?? null
    }

    it('an empty CUSTOM group: header menu invite creates + copies + toasts', async () => {
      routeParams.id = 'g1' // custom
      vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(page([]))
      vi.mocked(groupsApi.createGroupInvite).mockResolvedValue({
        invite_url: 'https://t.me/velo_bot?startapp=group_invite__xyz',
      })
      mount()
      await flush()

      headerMenuTrigger()?.click()
      await flush()
      const inviteItem = Array.from(host?.querySelectorAll<HTMLElement>('.v-menu-item') ?? [])[0]
      inviteItem?.click()
      await flush()

      expect(groupsApi.createGroupInvite).toHaveBeenCalledWith('g1')
      expect(writeText).toHaveBeenCalledWith('https://t.me/velo_bot?startapp=group_invite__xyz')
      expect(toastSuccess).toHaveBeenCalledWith('Ссылка скопирована')
    })

    it('a failed invite create surfaces an error toast', async () => {
      routeParams.id = 'g1'
      vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(page([]))
      vi.mocked(groupsApi.createGroupInvite).mockRejectedValue(new Error('boom'))
      mount()
      await flush()

      headerMenuTrigger()?.click()
      await flush()
      const inviteItem = Array.from(host?.querySelectorAll<HTMLElement>('.v-menu-item') ?? [])[0]
      inviteItem?.click()
      await flush()

      expect(writeText).not.toHaveBeenCalled()
      expect(toastError).toHaveBeenCalledWith('Не удалось создать ссылку')
    })

    it('the empty state renders no invite button anymore (removed duplicate, header menu is the single entry point)', async () => {
      routeParams.id = 'g1'
      vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(page([]))
      mount()
      await flush()

      const invite = Array.from(host?.querySelectorAll<HTMLElement>('button') ?? []).find(
        (b) => b.textContent?.trim() === 'Пригласить в группу',
      )
      expect(invite).toBeUndefined()
    })
  })

  describe('header menu -- invite/rename/delete (G2, ПРОМТ №609)', () => {
    /** The header's OWN menu trigger, scoped to `.v-header__right` so it
     *  is never confused with a per-member row's own «⋯» trigger (the
     *  opposite scoping fix from the member-row tests above, same root
     *  cause: this screen now has two DIFFERENT `.v-menu__trigger`s). */
    function headerMenuTrigger(): HTMLElement | null {
      return host?.querySelector<HTMLElement>('.v-header__right .v-menu__trigger') ?? null
    }

    it('renders for a custom group, not for the virtual groups', async () => {
      routeParams.id = 'g1' // custom
      mount()
      await flush()
      expect(headerMenuTrigger()).not.toBeNull()
      app?.unmount()
      host?.remove()

      for (const id of ['students', 'deleted']) {
        routeParams.id = id
        mount()
        await flush()
        expect(headerMenuTrigger()).toBeNull()
        app?.unmount()
        host?.remove()
      }
    })

    it('«Пригласить в группу» from the header menu works for a NON-empty group too', async () => {
      routeParams.id = 'g1'
      vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(page([member('s1')]))
      vi.mocked(groupsApi.createGroupInvite).mockResolvedValue({
        invite_url: 'https://t.me/velo_bot?startapp=group_invite__hdr',
      })
      mount()
      await flush()

      headerMenuTrigger()?.click()
      await flush()
      const inviteItem = Array.from(host?.querySelectorAll<HTMLElement>('.v-menu-item') ?? [])[0]
      inviteItem?.click()
      await flush()

      expect(groupsApi.createGroupInvite).toHaveBeenCalledWith('g1')
      expect(writeText).toHaveBeenCalledWith('https://t.me/velo_bot?startapp=group_invite__hdr')
      expect(toastSuccess).toHaveBeenCalledWith('Ссылка скопирована')
    })

    it('«Изменить» opens the sheet pre-filled with the CURRENT name + description and saves via renameGroup', async () => {
      routeParams.id = 'g1'
      routeQuery.name = 'Старое'
      vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(page([]))
      // Owner Q12 (ПРОМТ №611): the screen now resolves name/description
      // from getGroups(), not route.query -- the mock must carry the
      // CURRENT values the dialog should prefill, and the query hint
      // above is a red herring the API overwrites (proves that ordering).
      vi.mocked(groupsApi.getGroups).mockResolvedValue(
        customGroups([
          { id: 'g1', kind: 'custom', name: 'Старое', description: 'Было', members_count: 0 },
        ]),
      )
      vi.mocked(groupsApi.renameGroup).mockResolvedValue({
        id: 'g1',
        name: 'Новое',
        members_count: 0,
        description: 'Стало',
      })
      mount()
      await flush()

      headerMenuTrigger()?.click()
      await flush()
      const renameItem = Array.from(host?.querySelectorAll<HTMLElement>('.v-menu-item') ?? [])[1]
      renameItem?.click()
      await flush()

      const input = sheetOverlay()?.querySelector<HTMLInputElement>('input')
      expect(input?.value).toBe('Старое')
      const descField = sheetOverlay()?.querySelector<HTMLTextAreaElement>('textarea')
      expect(descField?.value).toBe('Было')

      input!.value = 'Новое'
      input!.dispatchEvent(new Event('input'))
      descField!.value = 'Стало'
      descField!.dispatchEvent(new Event('input'))
      // Re-read (section 2, owner Q12): the NEXT getGroups() call is what
      // the screen re-derives its header/description from after saving.
      vi.mocked(groupsApi.getGroups).mockResolvedValue(
        customGroups([
          { id: 'g1', kind: 'custom', name: 'Новое', description: 'Стало', members_count: 0 },
        ]),
      )
      sheetOverlay()?.querySelector<HTMLElement>('.v-sheet__save')?.click()
      await flush()

      expect(groupsApi.renameGroup).toHaveBeenCalledWith('g1', 'Новое', 'Стало')
      // Owner Q12/Q10: re-reads from the API instead of rewriting the URL.
      expect(replace).not.toHaveBeenCalled()
      expect(groupsApi.getGroups).toHaveBeenCalledTimes(2)
      expect(text()).toContain('Группа "Новое"')
    })

    it('renaming ALONE (description field untouched) resends the SAME description -- does not blank it', async () => {
      routeParams.id = 'g1'
      vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(page([]))
      vi.mocked(groupsApi.getGroups).mockResolvedValue(
        customGroups([
          { id: 'g1', kind: 'custom', name: 'Старое', description: 'Не трогали', members_count: 0 },
        ]),
      )
      vi.mocked(groupsApi.renameGroup).mockResolvedValue({
        id: 'g1',
        name: 'Новое',
        members_count: 0,
        description: 'Не трогали',
      })
      mount()
      await flush()

      headerMenuTrigger()?.click()
      await flush()
      const renameItem = Array.from(host?.querySelectorAll<HTMLElement>('.v-menu-item') ?? [])[1]
      renameItem?.click()
      await flush()

      const input = sheetOverlay()?.querySelector<HTMLInputElement>('input')
      input!.value = 'Новое'
      input!.dispatchEvent(new Event('input'))
      // Description field left exactly as prefilled -- never touched.
      sheetOverlay()?.querySelector<HTMLElement>('.v-sheet__save')?.click()
      await flush()

      expect(groupsApi.renameGroup).toHaveBeenCalledWith('g1', 'Новое', 'Не трогали')
    })

    it('«Удалить группу» confirms, calls deleteGroup, and navigates away (nothing left to reload)', async () => {
      routeParams.id = 'g1'
      // Owner Q12 (ПРОМТ №611): the screen now resolves the CURRENT name
      // from getGroups(), not this stale query hint -- the mock below is
      // what the delete-confirm message must actually reflect.
      routeQuery.name = 'Временная'
      vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(page([]))
      vi.mocked(groupsApi.getGroups).mockResolvedValue(
        customGroups([
          { id: 'g1', kind: 'custom', name: 'Временная', members_count: 0, description: null },
        ]),
      )
      vi.mocked(groupsApi.deleteGroup).mockResolvedValue(undefined)
      mount()
      await flush()

      headerMenuTrigger()?.click()
      await flush()
      const deleteItem = Array.from(host?.querySelectorAll<HTMLElement>('.v-menu-item') ?? [])[2]
      deleteItem?.click()
      await flush()

      const dialogText = modalOverlay()?.textContent ?? ''
      expect(dialogText).toContain('Удалить группу «Временная»?')

      const confirmBtn = Array.from(modalOverlay()?.querySelectorAll('button') ?? []).find(
        (b) => b.textContent?.trim() === 'Удалить',
      )
      confirmBtn?.click()
      await flush()

      expect(groupsApi.deleteGroup).toHaveBeenCalledWith('g1')
      expect(push).toHaveBeenCalledWith({ name: 'master-groups' })
    })

    it('a group_in_use rejection toasts a Russian message, never the raw backend detail', async () => {
      routeParams.id = 'g1'
      vi.mocked(groupsApi.getGroupMembers).mockResolvedValue(page([]))
      vi.mocked(groupsApi.deleteGroup).mockRejectedValue(
        new ApiResponseError(
          409,
          "Cannot delete: this group is the only audience of «Утренняя практика». Change that practice's audience first.",
          'group_in_use',
        ),
      )
      mount()
      await flush()

      headerMenuTrigger()?.click()
      await flush()
      const deleteItem = Array.from(host?.querySelectorAll<HTMLElement>('.v-menu-item') ?? [])[2]
      deleteItem?.click()
      await flush()
      const confirmBtn = Array.from(modalOverlay()?.querySelectorAll('button') ?? []).find(
        (b) => b.textContent?.trim() === 'Удалить',
      )
      confirmBtn?.click()
      await flush()

      expect(toastError).toHaveBeenCalledTimes(1)
      const [message] = toastError.mock.calls[0]!
      expect(message).not.toContain('Cannot delete')
      expect(message).toContain('аудитория')
      expect(push).not.toHaveBeenCalledWith({ name: 'master-groups' })
    })
  })
})
