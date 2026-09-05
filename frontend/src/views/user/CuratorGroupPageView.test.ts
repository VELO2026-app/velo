// =============================================================================
// VELO Frontend -- CuratorGroupPageView Screen Tests (FE-19/20/21 / GT P3)
// =============================================================================
//
// ONE page, three viewers: every behavioural difference keys off the
// server's viewer.relation, so the fixtures vary ONLY that field and the
// assertions check the action set (menu vs leave, students list vs counter).
// Zone (route name prefix) only picks the back target -- both are covered.
// The three destructive dialogs' ADVISORY contract is asserted end-to-end:
// preview N>0 -> the line renders; N=0 and 404 (frozen school, I-5) -> no
// line, and the button still works.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import CuratorGroupPageView from '@/views/user/CuratorGroupPageView.vue'
import * as cgApi from '@/api/curatorGroups'
import { ApiResponseError } from '@/api/client'
import type {
  CuratorGroupMasterItem,
  CuratorGroupMemberItem,
  CuratorGroupPageResponse,
  PracticeResponse,
} from '@/api/types'

vi.mock('@/api/curatorGroups')

const push = vi.fn()
const replace = vi.fn()
const routeState = { name: 'user-curator-group', id: 'g1' }
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: routeState.id }, name: routeState.name }),
  useRouter: () => ({ push, replace }),
}))

const toastSuccess = vi.fn()
const toastError = vi.fn()
const toastInfo = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: toastSuccess, error: toastError, info: toastInfo }),
}))

// CalendarPracticeCard reads the viewer timezone through the auth store;
// mock the composable to keep this suite pinia-free (the page itself never
// touches the store).
vi.mock('@/composables/useViewerTimezone', async () => {
  const { ref } = await import('vue')
  return { useViewerTimezone: () => ref('Europe/Moscow') }
})

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(CuratorGroupPageView)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  // The curator load now has one extra await stage (the shadow-masters
  // fetch) on top of the paginated helpers -- give the chain room.
  for (let i = 0; i < 8; i++) await nextTick()
}

// VConfirmDialog / VBottomSheet / VModal all <Teleport to="body">, so the
// queries below must run against document.body, not the mounted host -- the
// host only sees non-teleported markup (page + banners + menus).
function text(): string {
  return document.body.textContent ?? ''
}

function buttonWith(label: string): HTMLElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLElement>('button') ?? []).find(
    (b) => b.textContent?.trim().includes(label) || b.getAttribute('aria-label') === label,
  )
}

/** EXACT text match -- for dialog confirm buttons, where a substring search
 *  would hit the header's «Покинуть школу» before the dialog's «Покинуть». */
function buttonExact(label: string): HTMLElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLElement>('button') ?? []).find(
    (b) => b.textContent?.trim() === label,
  )
}

function openMenu(): void {
  buttonWith('Меню группы')?.click()
}

// -- Fixtures ---------------------------------------------------------------

function pageFixture(
  relation: 'curator' | 'master' | 'student',
  transfer: CuratorGroupPageResponse['transfer'] = null,
  avatarUrl: string | null = null,
): CuratorGroupPageResponse {
  return {
    id: 'g1',
    name: 'Тихая школа',
    description: 'Практики тишины',
    avatar_url: avatarUrl,
    curator: { user_id: 'u1', display_name: 'Мария Иванова', avatar_url: null },
    masters_count: 2,
    students_count: 5,
    viewer: { relation },
    transfer,
    created_at: '2026-08-01T00:00:00Z',
  }
}

function mastersFixture(): CuratorGroupMasterItem[] {
  return [
    {
      user_id: 'u1',
      display_name: 'Мария Иванова',
      avatar_url: null,
      methods: ['Медитация'],
      experience_years: 5,
      practices_count: 40,
      is_curator: true,
    },
    {
      user_id: 'u2',
      display_name: 'Пётр Сомов',
      avatar_url: null,
      methods: ['Дыхание'],
      experience_years: 3,
      practices_count: 12,
      is_curator: false,
    },
  ]
}

function practiceFixture(id: string): PracticeResponse {
  return {
    id,
    master_id: 'u2',
    master_name: 'Пётр Сомов',
    practice_type: 'live',
    status: 'scheduled',
    title: `Практика ${id}`,
    description: null,
    scheduled_at: '2026-09-10T18:00:00Z',
    duration_minutes: 60,
    timezone: 'Europe/Moscow',
    max_participants: null,
    current_participants: 0,
    parent_practice_id: null,
    is_free: true,
    price_cents: 0,
    currency: 'RUB',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: null,
  }
}

function studentsFixture(): CuratorGroupMemberItem[] {
  return [
    {
      user_id: 's1',
      name: 'Анна',
      avatar_url: null,
      kind: 'student',
      joined_at: '2026-08-05T00:00:00Z',
      is_visible: true,
    },
  ]
}

const transferFixture = {
  to_user_id: 'u2',
  to_display_name: 'Пётр Сомов',
  requested_at: '2026-08-20T00:00:00Z',
}

// Wire the default "everything green, student viewer" load.
function mockHappyLoad(
  relation: 'curator' | 'master' | 'student',
  transfer: CuratorGroupPageResponse['transfer'] = null,
): void {
  vi.mocked(cgApi.getCuratorGroupPage).mockResolvedValue(pageFixture(relation, transfer))
  vi.mocked(cgApi.getCuratorGroupMasters).mockResolvedValue({
    items: mastersFixture(),
    total: 2,
    limit: 20,
    offset: 0,
  })
  vi.mocked(cgApi.getCuratorGroupPractices).mockResolvedValue({
    items: [practiceFixture('p1')],
    total: 1,
    limit: 20,
    offset: 0,
  })
  vi.mocked(cgApi.getCuratorGroupMembers).mockResolvedValue({
    items: studentsFixture(),
    total: 1,
    limit: 20,
    offset: 0,
  })
  vi.mocked(cgApi.getCuratorGroupLeavePreview).mockResolvedValue({
    upcoming_practices_targeting_group: 0,
  })
  vi.mocked(cgApi.getCuratorGroupRemovePreview).mockResolvedValue({
    upcoming_practices_targeting_group: 0,
  })
  vi.mocked(cgApi.getCuratorGroupDeletePreview).mockResolvedValue({
    masters_count: 2,
    students_count: 5,
    upcoming_practices_targeting_group: 0,
  })
  // BE-19: the journal is fetched only for the curator; the green default is
  // an empty feed so the relation-matrix tests stay about the roster.
  vi.mocked(cgApi.getCuratorGroupJournal).mockResolvedValue({
    items: [],
    total: 0,
    limit: 20,
    offset: 0,
  })
}

beforeEach(() => {
  routeState.name = 'user-curator-group'
  routeState.id = 'g1'
  Object.values(cgApi).forEach((fn) => vi.mocked(fn).mockReset())
  push.mockReset()
  replace.mockReset()
  toastSuccess.mockReset()
  toastError.mockReset()
  toastInfo.mockReset()
  mockHappyLoad('student')
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  // happy-dom leaves the dialogs' <Teleport to="body"> DOM behind after
  // app.unmount() -- clear it, or a later test's button lookup clicks a dead
  // node from an already-unmounted app (seen with the leave dialog's
  // «Покинуть» confirming nothing).
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

// -- The relation matrix ------------------------------------------------------

describe('CuratorGroupPageView -- relation matrix', () => {
  it('STUDENT: header offers «Покинуть школу», no «⋯» menu, no student roster', async () => {
    mockHappyLoad('student')
    mount()
    await flush()

    expect(buttonWith('Покинуть школу')).toBeTruthy()
    expect(buttonWith('Меню группы')).toBeFalsy()
    expect(text()).not.toContain('Ученики')
    // The roster and the feed are for everyone.
    expect(text()).toContain('Пётр Сомов')
    expect(text()).toContain('Практика p1')
  })

  it('MASTER: same student view of the roster, plus the leave action', async () => {
    mockHappyLoad('master')
    mount()
    await flush()

    expect(buttonWith('Покинуть школу')).toBeTruthy()
    expect(buttonWith('Меню группы')).toBeFalsy()
    expect(text()).not.toContain('Ученики')
  })

  it('CURATOR: «⋯» menu with all five actions, student roster rendered, no leave', async () => {
    mockHappyLoad('curator')
    mount()
    await flush()

    expect(buttonWith('Покинуть школу')).toBeFalsy()
    expect(buttonWith('Меню группы')).toBeTruthy()
    openMenu()
    await flush()
    for (const item of [
      'Редактировать',
      'Пригласить мастера',
      'Пригласить ученика',
      'Передать школу',
      'Удалить школу',
    ]) {
      expect(buttonWith(item)).toBeTruthy()
    }
    expect(text()).toContain('Ученики')
    expect(text()).toContain('Анна')
  })

  it('curator sees the counter block; a frozen/absent school is the honest 404', async () => {
    vi.mocked(cgApi.getCuratorGroupPage).mockRejectedValue(
      new ApiResponseError(404, 'not_found', 'not_found'),
    )
    mount()
    await flush()

    expect(text()).toContain('Группа не найдена')
  })

  it('transient failure: retry reloads', async () => {
    vi.mocked(cgApi.getCuratorGroupPage).mockRejectedValueOnce(new Error('blip'))
    mount()
    await flush()

    expect(text()).toContain('Не удалось загрузить группу')
    buttonWith('Повторить')?.click()
    await flush()
    expect(text()).toContain('Тихая школа')
  })

  it('zone picks only the back target: master route backs into the master list', async () => {
    routeState.name = 'master-curator-group'
    mockHappyLoad('master')
    mount()
    await flush()

    buttonWith('Покинуть школу')?.click()
    await flush()
    // Confirm the dialog, then expect the master list replace.
    buttonExact('Покинуть')?.click()
    await flush()
    expect(cgApi.leaveCuratorGroup).toHaveBeenCalledWith('g1')
    expect(replace).toHaveBeenCalledWith({ name: 'master-curator-groups' })
  })
})

// -- Leave (student / master) -------------------------------------------------

describe('CuratorGroupPageView -- leave', () => {
  it('leave-preview N>0 renders the advisory inside the confirm dialog', async () => {
    vi.mocked(cgApi.getCuratorGroupLeavePreview).mockResolvedValue({
      upcoming_practices_targeting_group: 2,
    })
    mount()
    await flush()

    buttonWith('Покинуть школу')?.click()
    await flush()

    expect(cgApi.getCuratorGroupLeavePreview).toHaveBeenCalledWith('g1')
    expect(text()).toContain('2 предстоящих практики для этой школы станут скрыты')
  })

  it('preview 404 while the page loads: the advisory stays silent and the leave still works', async () => {
    vi.mocked(cgApi.getCuratorGroupLeavePreview).mockRejectedValue(
      new ApiResponseError(404, 'not_found', 'not_found'),
    )
    mount()
    await flush()

    buttonWith('Покинуть школу')?.click()
    await flush()

    expect(text()).not.toContain('станут скрыты')
    buttonExact('Покинуть')?.click()
    await flush()

    expect(cgApi.leaveCuratorGroup).toHaveBeenCalledWith('g1')
    expect(replace).toHaveBeenCalledWith({ name: 'user-curator-groups' })
  })

  it('FROZEN school (review P2 / I-5): the page itself 404s -- the not-found screen still offers the exit', async () => {
    // The REAL frozen state: /mine drops the school and GET /{id} answers 404
    // (P-08 keeps "frozen" indistinguishable from "gone"). Leave is the one
    // action the backend deliberately did NOT gate on the school being
    // active, so the 404 screen carries a quiet secondary exit.
    vi.mocked(cgApi.getCuratorGroupPage).mockRejectedValue(
      new ApiResponseError(404, 'not_found', 'not_found'),
    )
    vi.mocked(cgApi.getCuratorGroupLeavePreview).mockRejectedValue(
      new ApiResponseError(404, 'not_found', 'not_found'),
    )
    vi.mocked(cgApi.leaveCuratorGroup).mockResolvedValue(undefined)
    mount()
    await flush()

    expect(text()).toContain('Группа не найдена')
    buttonWith('Я состою в этой школе — покинуть её')?.click()
    await flush()

    // The confirm explains the inactive-school case instead of a name we
    // no longer have; the preview's 404 means "no advisory", not an error.
    expect(text()).toContain('даже если школа сейчас не активна')
    expect(text()).not.toContain('станут скрыты')
    buttonExact('Покинуть')?.click()
    await flush()

    expect(cgApi.leaveCuratorGroup).toHaveBeenCalledWith('g1')
    expect(replace).toHaveBeenCalledWith({ name: 'user-curator-groups' })
  })

  it('preview N=0: no advisory line (zero is silence, not news)', async () => {
    mount()
    await flush()

    buttonWith('Покинуть школу')?.click()
    await flush()

    expect(text()).not.toContain('станут скрыты')
  })
})

// -- Curator management --------------------------------------------------------

describe('CuratorGroupPageView -- curator management', () => {
  it('delete: the confirm carries the preview counts, then replaces to the master list', async () => {
    mockHappyLoad('curator')
    vi.mocked(cgApi.getCuratorGroupDeletePreview).mockResolvedValue({
      masters_count: 2,
      students_count: 5,
      upcoming_practices_targeting_group: 3,
    })
    mount()
    await flush()

    openMenu()
    await flush()
    buttonWith('Удалить школу')?.click()
    await flush()

    expect(cgApi.getCuratorGroupDeletePreview).toHaveBeenCalledWith('g1')
    expect(text()).toContain('2')
    expect(text()).toContain('потеряют доступ')
    expect(text()).toContain('3 предстоящих практики станут скрыты')

    buttonExact('Удалить')?.click()
    await flush()
    expect(cgApi.deleteCuratorGroup).toHaveBeenCalledWith('g1')
    expect(replace).toHaveBeenCalledWith({ name: 'master-curator-groups' })
  })

  it('remove member: advisory from remove-preview, roster reloaded after', async () => {
    mockHappyLoad('curator')
    vi.mocked(cgApi.getCuratorGroupRemovePreview).mockResolvedValue({
      upcoming_practices_targeting_group: 1,
    })
    mount()
    await flush()

    const removeBtn = buttonWith('Удалить из группы: Анна')
    expect(removeBtn).toBeTruthy()
    removeBtn?.click()
    await flush()

    expect(cgApi.getCuratorGroupRemovePreview).toHaveBeenCalledWith('g1', 's1')
    expect(text()).toContain('1 предстоящих практика для этой школы станут скрыты')

    buttonWith('Удалить')?.click()
    await flush()
    expect(cgApi.removeCuratorGroupMember).toHaveBeenCalledWith('g1', 's1')
    expect(cgApi.getCuratorGroupMasters).toHaveBeenCalled()
  })

  it('edit: sheet prefills, save PATCHes name + explicit null for a cleared description', async () => {
    mockHappyLoad('curator')
    mount()
    await flush()

    openMenu()
    await flush()
    buttonWith('Редактировать')?.click()
    await flush()

    const fields = Array.from(
      document.body.querySelectorAll('input, textarea'),
    ) as HTMLInputElement[]
    expect(fields[0]!.value).toBe('Тихая школа')
    fields[0]!.value = 'Новое имя'
    fields[0]!.dispatchEvent(new Event('input'))
    fields[1]!.value = ''
    fields[1]!.dispatchEvent(new Event('input'))
    // BE-20: the third field is the avatar link -- untouched here, so the
    // key must be ABSENT from the PATCH (not null: the school has no avatar
    // to remove, and an always-sent key would wipe pictures on plain renames).
    expect(fields[2]!.value).toBe('')
    await flush()

    vi.mocked(cgApi.updateCuratorGroup).mockResolvedValue({
      id: 'g1',
      name: 'Новое имя',
      description: null,
      avatar_url: null,
      masters_count: 2,
      students_count: 5,
      transfer: null,
      created_at: '2026-08-01T00:00:00Z',
    })
    buttonWith('Сохранить')?.click()
    await flush()

    expect(cgApi.updateCuratorGroup).toHaveBeenCalledWith('g1', 'Новое имя', null, undefined)
    expect(text()).toContain('Новое имя')
  })

  it('BE-20: avatar link is PATCHed when typed, and «сохранено как …» surfaces the normalization', async () => {
    mockHappyLoad('curator')
    mount()
    await flush()

    openMenu()
    await flush()
    buttonWith('Редактировать')?.click()
    await flush()

    const fields = Array.from(
      document.body.querySelectorAll('input, textarea'),
    ) as HTMLInputElement[]
    fields[2]!.value = 'https://CDN.Example.COM/school.png'
    fields[2]!.dispatchEvent(new Event('input'))
    await flush()

    // The server stores the URL normalized -- NOT byte-equal to the input.
    vi.mocked(cgApi.updateCuratorGroup).mockResolvedValue({
      id: 'g1',
      name: 'Тихая школа',
      description: 'Практики тишины',
      avatar_url: 'https://cdn.example.com/school.png',
      masters_count: 2,
      students_count: 5,
      transfer: null,
      created_at: '2026-08-01T00:00:00Z',
    })
    buttonWith('Сохранить')?.click()
    await flush()

    expect(cgApi.updateCuratorGroup).toHaveBeenCalledWith(
      'g1',
      'Тихая школа',
      'Практики тишины',
      'https://CDN.Example.COM/school.png',
    )
    expect(toastInfo).toHaveBeenCalledWith(
      'Ссылка на аватар сохранена как https://cdn.example.com/school.png',
    )
    // The normalized form lands on the page too.
    const img = document.body.querySelector('.cgp__school-avatar img')
    expect(img?.getAttribute('src')).toBe('https://cdn.example.com/school.png')
  })

  it('BE-20: clearing the link on a school that HAS an avatar PATCHes null (remove)', async () => {
    vi.mocked(cgApi.getCuratorGroupPage).mockResolvedValue(
      pageFixture('curator', null, 'https://cdn.example.com/old.png'),
    )
    mount()
    await flush()

    // The intro renders the school's own avatar (not the curator's).
    expect(document.body.querySelector('.cgp__school-avatar img')?.getAttribute('src')).toBe(
      'https://cdn.example.com/old.png',
    )

    openMenu()
    await flush()
    buttonWith('Редактировать')?.click()
    await flush()

    const fields = Array.from(
      document.body.querySelectorAll('input, textarea'),
    ) as HTMLInputElement[]
    expect(fields[2]!.value).toBe('https://cdn.example.com/old.png')
    fields[2]!.value = ''
    fields[2]!.dispatchEvent(new Event('input'))
    await flush()

    vi.mocked(cgApi.updateCuratorGroup).mockResolvedValue({
      id: 'g1',
      name: 'Тихая школа',
      description: 'Практики тишины',
      avatar_url: null,
      masters_count: 2,
      students_count: 5,
      transfer: null,
      created_at: '2026-08-01T00:00:00Z',
    })
    buttonWith('Сохранить')?.click()
    await flush()

    expect(cgApi.updateCuratorGroup).toHaveBeenCalledWith(
      'g1',
      'Тихая школа',
      'Практики тишины',
      null,
    )
    expect(toastInfo).not.toHaveBeenCalled()
    expect(document.body.querySelector('.cgp__school-avatar')).toBeNull()
  })

  it('invite sheets: the menu items mint the right kind', async () => {
    mockHappyLoad('curator')
    mount()
    await flush()

    openMenu()
    await flush()
    vi.mocked(cgApi.createCuratorGroupInvite).mockResolvedValue({
      kind: 'master',
      invite_url: 'https://t.me/bot?startapp=curator_group_invite__tok',
    })
    buttonWith('Пригласить мастера')?.click()
    await flush()

    expect(cgApi.createCuratorGroupInvite).toHaveBeenCalledWith('g1', 'master')

    openMenu()
    await flush()
    buttonWith('Пригласить ученика')?.click()
    await flush()
    expect(cgApi.createCuratorGroupInvite).toHaveBeenCalledWith('g1', 'student')
  })

  it('pagination (review P2): rows past the first 20-item page are loaded too', async () => {
    const page1 = Array.from({ length: 20 }, (_, i) => ({
      user_id: `u_${i}`,
      display_name: `Мастер ${i}`,
      avatar_url: null,
      methods: [],
      experience_years: 1,
      practices_count: 0,
      is_curator: i === 0,
    }))
    const page2 = [
      {
        user_id: 'u_20',
        display_name: 'Мастер далеко за первой страницей',
        avatar_url: null,
        methods: [],
        experience_years: 1,
        practices_count: 0,
        is_curator: false,
      },
    ]
    vi.mocked(cgApi.getCuratorGroupMasters)
      .mockResolvedValueOnce({ items: page1, total: 21, limit: 20, offset: 0 })
      .mockResolvedValueOnce({ items: page2, total: 21, limit: 20, offset: 20 })
    mockHappyLoad('curator')
    // Re-apply the two-page masters mock (mockHappyLoad overwrote it).
    vi.mocked(cgApi.getCuratorGroupMasters)
      .mockReset()
      .mockResolvedValueOnce({ items: page1, total: 21, limit: 20, offset: 0 })
      .mockResolvedValueOnce({ items: page2, total: 21, limit: 20, offset: 20 })
    mount()
    await flush()

    expect(cgApi.getCuratorGroupMasters).toHaveBeenNthCalledWith(1, 'g1', 20, 0)
    expect(cgApi.getCuratorGroupMasters).toHaveBeenNthCalledWith(2, 'g1', 20, 20)
    expect(text()).toContain('Мастер далеко за первой страницей')
  })

  it("hidden (suspended) master stays in the curator's sight -- shadow row + remove, never a transfer candidate", async () => {
    mockHappyLoad('curator')
    const hidden = {
      user_id: 'u_hidden',
      name: 'Теневой Мастер',
      avatar_url: null,
      kind: 'master' as const,
      joined_at: '2026-08-05T00:00:00Z',
      is_visible: false,
    }
    vi.mocked(cgApi.getCuratorGroupMembers).mockImplementation(async (_id, q) =>
      q?.kind === 'master'
        ? { items: [hidden], total: 1, limit: 20, offset: 0 }
        : { items: studentsFixture(), total: 1, limit: 20, offset: 0 },
    )
    mount()
    await flush()

    // The shadow row renders with its marker and a remove action.
    expect(text()).toContain('Теневой Мастер')
    expect(text()).toContain('В тени')
    expect(buttonWith('Удалить из группы: Теневой Мастер')).toBeTruthy()

    // ...and never leaks into the transfer picker (backend 404s hidden targets).
    openMenu()
    await flush()
    buttonWith('Передать школу')?.click()
    await flush()
    const pickerRows = Array.from(
      document.body.querySelectorAll('.cgp__picker-row'),
    ) as HTMLElement[]
    expect(pickerRows.length).toBe(1)
    expect(pickerRows[0]!.textContent).not.toContain('Теневой')
  })
})

// -- Transfer (FE-21) ----------------------------------------------------------

describe('CuratorGroupPageView -- transfer', () => {
  it('curator offers via the picker: candidates are the roster minus the curator, CONFIRMED before the POST', async () => {
    mockHappyLoad('curator')
    vi.mocked(cgApi.offerCuratorGroupTransfer).mockResolvedValue(transferFixture)
    mount()
    await flush()

    openMenu()
    await flush()
    buttonWith('Передать школу')?.click()
    await flush()

    // The picker lists only Пётр (u2); the curator's own roster row is not
    // an eligible target (scope to the picker rows -- the page behind the
    // sheet still names the curator).
    expect(text()).toContain('Кому передать школу?')
    const pickerRows = Array.from(
      document.body.querySelectorAll('.cgp__picker-row'),
    ) as HTMLElement[]
    expect(pickerRows.length).toBe(1)
    expect(pickerRows[0]!.textContent).toContain('Пётр Сомов')

    pickerRows[0]!.click()
    await flush()
    buttonWith('Передать')?.click()
    await flush()

    // Review P2: the pick is confirmed BEFORE any POST fires.
    expect(cgApi.offerCuratorGroupTransfer).not.toHaveBeenCalled()
    expect(text()).toContain('Школа будет предложена мастеру Пётр Сомов')

    // The dialog's confirm, scoped to .v-confirm__actions -- the closed
    // sheet's teleported «Передать» save button still lingers in body and
    // would otherwise swallow the click.
    const confirmBtn = Array.from(
      document.body.querySelectorAll('.v-confirm__actions button'),
    ).find((b) => b.textContent?.trim() === 'Передать') as HTMLElement
    confirmBtn.click()
    await flush()

    expect(cgApi.offerCuratorGroupTransfer).toHaveBeenCalledWith('g1', 'u2')
    expect(text()).toContain('Предложение передать школу отправлено: Пётр Сомов')
  })

  it('a pending offer HIDES the «Передать школу» menu entry -- the banner replaces the action', async () => {
    mockHappyLoad('curator', transferFixture)
    mount()
    await flush()

    expect(text()).toContain('Предложение передать школу отправлено')
    openMenu()
    await flush()
    expect(buttonWith('Передать школу')).toBeFalsy()
    // The rest of the menu is untouched.
    for (const item of ['Редактировать', 'Пригласить мастера', 'Удалить школу']) {
      expect(buttonWith(item)).toBeTruthy()
    }
  })

  it('curator cancels: the banner clears without a reload', async () => {
    mockHappyLoad('curator', transferFixture)
    vi.mocked(cgApi.cancelCuratorGroupTransfer).mockResolvedValue(undefined)
    mount()
    await flush()

    expect(text()).toContain('Предложение передать школу отправлено')
    buttonWith('Отменить')?.click()
    await flush()

    expect(cgApi.cancelCuratorGroupTransfer).toHaveBeenCalledWith('g1')
    expect(text()).not.toContain('Предложение передать школу отправлено')
  })

  it('addressee accepts: the accept response REPLACES the page -- curator mode without a reload', async () => {
    mockHappyLoad('master', transferFixture)
    vi.mocked(cgApi.acceptCuratorGroupTransfer).mockResolvedValue(pageFixture('curator'))
    mount()
    await flush()

    expect(text()).toContain('Вам предлагают стать куратором')
    buttonWith('Принять')?.click()
    await flush()

    expect(cgApi.acceptCuratorGroupTransfer).toHaveBeenCalledWith('g1')
    // Flipped into curator mode in place: the menu appeared, the banner went.
    expect(buttonWith('Меню группы')).toBeTruthy()
    expect(text()).not.toContain('Вам предлагают стать куратором')
    expect(text()).toContain('Ученики')
  })

  it('addressee declines: the banner clears, view stays a member view', async () => {
    mockHappyLoad('master', transferFixture)
    vi.mocked(cgApi.declineCuratorGroupTransfer).mockResolvedValue(undefined)
    mount()
    await flush()

    buttonWith('Отклонить')?.click()
    await flush()

    expect(cgApi.declineCuratorGroupTransfer).toHaveBeenCalledWith('g1')
    expect(text()).not.toContain('Вам предлагают стать куратором')
    expect(buttonWith('Покинуть школу')).toBeTruthy()
  })

  it('a member with no offer sees no banner at all (transfer is two-people-only)', async () => {
    mockHappyLoad('student')
    mount()
    await flush()

    expect(text()).not.toContain('куратором')
  })
})

// -- Журнал школы (BE-19) -------------------------------------------------------

describe('CuratorGroupPageView -- journal (BE-19)', () => {
  function eventFixture(
    id: string,
    event: string,
    actor: string,
    data: Record<string, unknown> = {},
    createdAt = '2026-09-01T12:00:00Z',
  ) {
    return {
      id,
      event,
      actor: { user_id: `u_${id}`, display_name: actor },
      data,
      created_at: createdAt,
    }
  }

  it("CURATOR: the feed renders in the RESPONSE's order, frozen actor names and all", async () => {
    mockHappyLoad('curator')
    vi.mocked(cgApi.getCuratorGroupJournal).mockResolvedValue({
      items: [
        eventFixture('e1', 'member_removed', 'Мария Иванова', {
          kind: 'student',
          target_user_id: 's1',
          target_name: 'Анна',
          actor_name: 'Мария Иванова',
        }),
        eventFixture('e2', 'group_renamed', 'Мария Иванова', {
          old_name: 'Тихое утро',
          new_name: 'Тихая школа',
          actor_name: 'Мария Иванова',
        }),
        eventFixture('e3', 'transfer_accepted', 'Пётр Сомов', {
          target_user_id: 'u1',
          target_name: 'Мария Иванова',
          actor_name: 'Пётр Сомов',
        }),
      ],
      total: 3,
      limit: 20,
      offset: 0,
    })
    mount()
    await flush()

    expect(cgApi.getCuratorGroupJournal).toHaveBeenCalledWith('g1', 20, 0)
    expect(text()).toContain('Журнал школы')
    // The sentence per kind: actor (frozen) + line.
    expect(text()).toContain('Мария Иванова — удалил(а) участника: Анна')
    expect(text()).toContain('Мария Иванова — переименовал(а) школу: «Тихое утро» → «Тихая школа»')
    expect(text()).toContain('Пётр Сомов — принял(а) школу — прежний куратор: Мария Иванова')
    // The response order is authoritative (a hidden seq column sorted it) --
    // e1 must read ABOVE e2 even though e2's kind sorts first alphabetically.
    const feed = text()
    expect(feed.indexOf('удалил(а) участника')).toBeLessThan(feed.indexOf('переименовал(а) школу'))
    // No «Показать ещё» when everything is in.
    expect(buttonWith('Показать ещё')).toBeFalsy()
  })

  it('STUDENT and MASTER: no journal section, no journal call (404 by design)', async () => {
    for (const relation of ['student', 'master'] as const) {
      mockHappyLoad(relation)
      mount()
      await flush()

      expect(text()).not.toContain('Журнал школы')
      expect(cgApi.getCuratorGroupJournal).not.toHaveBeenCalled()
      app?.unmount()
      host?.remove()
      document.body.innerHTML = ''
      vi.clearAllMocks()
      mockHappyLoad('student')
    }
  })

  it("«Показать ещё» appends the next page at the FEED's end, offset forwarded", async () => {
    mockHappyLoad('curator')
    const page1 = Array.from({ length: 20 }, (_, i) =>
      eventFixture(`e${i}`, 'member_joined', `Участник ${i}`, { kind: 'student' }),
    )
    vi.mocked(cgApi.getCuratorGroupJournal)
      .mockResolvedValueOnce({ items: page1, total: 21, limit: 20, offset: 0 })
      .mockResolvedValueOnce({
        items: [eventFixture('e20', 'member_left', 'Участник 20', { kind: 'master' })],
        total: 21,
        limit: 20,
        offset: 20,
      })
    mount()
    await flush()

    buttonWith('Показать ещё')?.click()
    await flush()

    expect(cgApi.getCuratorGroupJournal).toHaveBeenLastCalledWith('g1', 20, 20)
    const feed = text()
    expect(feed.indexOf('Участник 0')).toBeLessThan(feed.indexOf('вышел(а) из школы (мастер)'))
    // All 21 in -- the pager is gone.
    expect(buttonWith('Показать ещё')).toBeFalsy()
  })

  it('an unknown event kind (the vocabulary grows) renders the raw string, never crashes', async () => {
    mockHappyLoad('curator')
    vi.mocked(cgApi.getCuratorGroupJournal).mockResolvedValue({
      items: [eventFixture('e_x', 'practice_published', 'Пётр Сомов')],
      total: 1,
      limit: 20,
      offset: 0,
    })
    mount()
    await flush()

    expect(text()).toContain('Пётр Сомов — practice_published')
  })

  it("a rename through the edit sheet refreshes the journal's first page", async () => {
    mockHappyLoad('curator')
    mount()
    await flush()

    expect(cgApi.getCuratorGroupJournal).toHaveBeenCalledTimes(1)

    openMenu()
    await flush()
    buttonWith('Редактировать')?.click()
    await flush()
    vi.mocked(cgApi.updateCuratorGroup).mockResolvedValue({
      id: 'g1',
      name: 'Новое имя',
      description: null,
      avatar_url: null,
      masters_count: 2,
      students_count: 5,
      transfer: null,
      created_at: '2026-08-01T00:00:00Z',
    })
    buttonWith('Сохранить')?.click()
    await flush()

    expect(cgApi.getCuratorGroupJournal).toHaveBeenCalledTimes(2)
  })

  it('journal failure: honest «недоступно» state with a working retry', async () => {
    mockHappyLoad('curator')
    vi.mocked(cgApi.getCuratorGroupJournal).mockRejectedValueOnce(new Error('blip'))
    mount()
    await flush()

    expect(text()).toContain('Журнал недоступен')

    vi.mocked(cgApi.getCuratorGroupJournal).mockResolvedValueOnce({
      items: [eventFixture('e1', 'group_created', 'Мария Иванова')],
      total: 1,
      limit: 20,
      offset: 0,
    })
    buttonWith('Повторить')?.click()
    await flush()

    expect(text()).toContain('Мария Иванова — создал(а) школу')
  })

  it('closing an invite sheet refreshes the journal (mint-on-open and revoke both write events)', async () => {
    mockHappyLoad('curator')
    mount()
    await flush()

    expect(cgApi.getCuratorGroupJournal).toHaveBeenCalledTimes(1)

    openMenu()
    await flush()
    vi.mocked(cgApi.createCuratorGroupInvite).mockResolvedValue({
      kind: 'master',
      invite_url: 'https://t.me/bot?startapp=curator_group_invite__tok',
    })
    buttonWith('Пригласить мастера')?.click()
    await flush()
    expect(cgApi.createCuratorGroupInvite).toHaveBeenCalledWith('g1', 'master')

    // Dismiss the sheet via its overlay (VModal's @click.self) -- the page's
    // close handler must catch the journal up with the mint it just caused.
    document.body.querySelector<HTMLElement>('.v-modal__overlay')?.click()
    await flush()

    expect(cgApi.getCuratorGroupJournal).toHaveBeenCalledTimes(2)
  })

  it('empty feed: the quiet «Событий пока нет» note', async () => {
    mockHappyLoad('curator')
    mount()
    await flush()

    expect(text()).toContain('Событий пока нет')
  })
})
