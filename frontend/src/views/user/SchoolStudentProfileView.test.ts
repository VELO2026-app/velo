// =============================================================================
// VELO Frontend -- SchoolStudentProfileView Screen Tests (tz-curator.md
// §1.11.4, owner 2026-09-22)
// =============================================================================
//
// The school-context student profile: hero straight from the roster row's
// query data (students have no public endpoint), and the curator's two
// actions in the header «⋯» menu -- gated by viewer.relation, never by zone.
// The offer does NOT mutate anything locally (the roster changes only when
// the appointee accepts); the removal is advisory-preview + idempotent DELETE
// + back to the roster.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import SchoolStudentProfileView from '@/views/user/SchoolStudentProfileView.vue'
import * as cgApi from '@/api/curatorGroups'
import { ApiResponseError } from '@/api/client'
import type { SchoolStudentProfileResponse } from '@/api/types'

vi.mock('@/api/curatorGroups')

const push = vi.fn()
const replace = vi.fn()
const routeState = {
  name: 'user-curator-group-student',
  groupId: 'g1',
  userId: 'u9',
  nameQuery: 'Пётр Сидоров',
}
vi.mock('vue-router', () => ({
  useRoute: () => ({
    params: { groupId: routeState.groupId, userId: routeState.userId },
    name: routeState.name,
    query: { name: routeState.nameQuery, avatar: '' },
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

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(SchoolStudentProfileView)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

function text(): string {
  return document.body.textContent ?? ''
}

function buttonWith(label: string): HTMLElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLElement>('button') ?? []).find(
    (b) => b.textContent?.trim().includes(label) || b.getAttribute('aria-label') === label,
  )
}

/** Exact-label finder -- «Изменить» (the pill) must not match «Изменить роль» (the menu item). */
function exactButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
  )
}

/** The stat cards' values in DOM order (§1.13.2: «Практик» then «Часов»). */
function statValues(): string[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>('.v-stat__value') ?? []).map((e) =>
    (e.textContent ?? '').trim(),
  )
}

function profileFixture(
  overrides: Partial<SchoolStudentProfileResponse> = {},
): SchoolStudentProfileResponse {
  return {
    user_id: 'u9',
    display_name: 'Пётр Сидоров',
    avatar_url: null,
    practices_count: 12,
    hours: 9.5,
    recent_checkins: [],
    recent_feedbacks: [],
    ...overrides,
  }
}

beforeEach(() => {
  routeState.name = 'user-curator-group-student'
  routeState.groupId = 'g1'
  routeState.userId = 'u9'
  routeState.nameQuery = 'Пётр Сидоров'
  Object.values(cgApi).forEach((fn) => vi.mocked(fn).mockReset())
  vi.mocked(cgApi.getCuratorGroupPage).mockResolvedValue({
    id: 'g1',
    name: 'Школа',
    description: null,
    avatar_url: null,
    curator: { user_id: 'c1', display_name: 'Куратор', avatar_url: null },
    masters_count: 1,
    students_count: 2,
    viewer: { relation: 'curator' },
    transfer: null,
    created_at: '2026-09-01T00:00:00Z',
  })
  vi.mocked(cgApi.cancelCuratorGroupMasterOffer).mockResolvedValue(undefined)
  vi.mocked(cgApi.getCuratorGroupStudentProfile).mockResolvedValue(profileFixture())
  vi.mocked(cgApi.offerCuratorGroupMaster).mockResolvedValue(undefined)
  // Default roster lookup: the student is NOT among the masters (the only
  // kind this screen is reached for); master-present tests override below.
  vi.mocked(cgApi.getCuratorGroupMembers).mockResolvedValue({
    items: [],
    total: 0,
    limit: 100,
    offset: 0,
  })
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

describe('SchoolStudentProfileView', () => {
  it('the hero renders from the SERVER profile -- a deep link without query params still names the student', async () => {
    routeState.nameQuery = ''
    mount()
    await flush()

    expect(text()).toContain('Пётр Сидоров')
    expect(text()).not.toContain('Школа недоступна')

    // §1.13.2: the two aggregates ride the same response, formatted (9.5 ->
    // «9,5»; the integer practice count prints bare).
    expect(statValues()).toEqual(['12', '9,5'])
  })

  it("the «⋯» menu is the curator's alone -- the masked 404 renders «Ученик недоступен» with no menu (P-08, §1.13.5)", async () => {
    mount()
    await flush()
    expect(buttonWith('Действия с учеником')).toBeTruthy()

    app?.unmount()
    vi.mocked(cgApi.getCuratorGroupStudentProfile).mockRejectedValue(
      new ApiResponseError(404, 'not found', 'not_found'),
    )
    mount()
    await flush()
    expect(buttonWith('Действия с учеником')).toBeUndefined()
    expect(text()).toContain('Ученик недоступен')
  })

  it('the menu is «Написать сообщение» / «Изменить роль» / «Заблокировать» (owner 2026-09-30: no exclusion)', async () => {
    mount()
    await flush()

    buttonWith('Действия с учеником')?.click()
    await flush()

    expect(buttonWith('Написать сообщение')).toBeTruthy()
    expect(buttonWith('Изменить роль')).toBeTruthy()
    // The lock replaces the trash: an exclusion no longer exists. It is LIVE
    // (owner 2026-09-30) and opens the block confirm.
    const lock = buttonWith('Заблокировать')
    expect(lock).toBeTruthy()
    expect((lock as HTMLButtonElement).disabled).toBe(false)
    expect(buttonWith('Исключить из школы')).toBeUndefined()
    expect(buttonWith('Предложить стать мастером')).toBeUndefined()
  })

  it('«Заблокировать» opens the block confirm (draft copy); «Отмена» closes it without any call', async () => {
    mount()
    await flush()

    buttonWith('Действия с учеником')?.click()
    await flush()
    buttonWith('Заблокировать')?.click()
    await flush()

    // Title + who-card + the DRAFT warning copy (BE-79 owns the final wording).
    expect(text()).toContain('Заблокировать участника школы?')
    expect(text()).toContain('Пётр Сидоров')
    expect(text()).toContain('перестанет получать её уведомления')

    exactButton('Отмена')?.click()
    // The leave transition (--transition-slow, 0.3s) must finish before the
    // teleported modal unmounts -- a bare nextTick flush is too early.
    await new Promise((resolve) => setTimeout(resolve, 500))
    await flush()

    expect(text()).not.toContain('Заблокировать участника школы?')
    expect(toastInfo).not.toHaveBeenCalled()
    expect(cgApi.offerCuratorGroupMaster).not.toHaveBeenCalled()
  })

  // BE-79 (2): this used to pin the INTERIM -- «nothing mutates, the chain is
  // a draft». Right then; the block endpoint (BE-79 (1а)) replaced it: confirm
  // now SENDS the block, and the chain opens on the server's 204 only.
  it('block confirm: «Заблокировать» sends the block; on 204 the success chain opens', async () => {
    mount()
    await flush()

    buttonWith('Действия с учеником')?.click()
    await flush()
    buttonWith('Заблокировать')?.click()
    await flush()

    exactButton('Заблокировать')?.click()
    await flush()

    // The post-block step rides the same dialog canon: title, who-card, the
    // warning panel WITHOUT the icon, compact «Не сейчас» / «В поддержку».
    expect(text()).toContain('Пользователь заблокирован')
    expect(text()).toContain('Пользователь перемещён во вкладку «Блок» участников школы.')
    expect(exactButton('Не сейчас')).toBeTruthy()
    expect(exactButton('В поддержку')).toBeTruthy()
    expect(cgApi.blockCuratorGroupMember).toHaveBeenCalledTimes(1)
    expect(cgApi.blockCuratorGroupMember).toHaveBeenCalledWith('g1', 'u9')
    expect(cgApi.offerCuratorGroupMaster).not.toHaveBeenCalled()
  })

  async function confirmBlock(): Promise<void> {
    buttonWith('Действия с учеником')?.click()
    await flush()
    buttonWith('Заблокировать')?.click()
    await flush()
    exactButton('Заблокировать')?.click()
    await flush()
  }

  it('after the block, «Не сейчас» returns to the roster the person left', async () => {
    mount()
    await flush()
    await confirmBlock()
    exactButton('Не сейчас')?.click()
    await flush()
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'user-curator-group-members', params: { id: 'g1' } }),
    )
  })

  it('block 404 (not a member any more): says so, back to the roster, no success chain', async () => {
    vi.mocked(cgApi.blockCuratorGroupMember).mockRejectedValueOnce(
      new ApiResponseError(404, 'not found', 'not_found'),
    )
    mount()
    await flush()
    await confirmBlock()
    expect(toastError).toHaveBeenCalledWith('Участник уже не в школе')
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'user-curator-group-members' }),
    )
    expect(text()).not.toContain('Пользователь заблокирован')
  })

  it('block refused (409 / 403 / network): the error toast, no success chain, no navigation', async () => {
    vi.mocked(cgApi.blockCuratorGroupMember).mockRejectedValueOnce(
      new ApiResponseError(409, 'cannot block the curator', 'cannot_block_curator'),
    )
    mount()
    await flush()
    await confirmBlock()
    expect(toastError).toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
    expect(text()).not.toContain('Пользователь заблокирован')
  })

  it('«В поддержку» opens the report form; «Не сейчас» just dismisses the chain', async () => {
    mount()
    await flush()

    buttonWith('Действия с учеником')?.click()
    await flush()
    buttonWith('Заблокировать')?.click()
    await flush()
    exactButton('Заблокировать')?.click()
    await flush()

    exactButton('В поддержку')?.click()
    await flush()

    expect(text()).toContain('Сообщить о пользователе')
    expect(exactButton('Отправить')).toBeTruthy()
  })

  it('«Изменить роль»: preselects the CURRENT role; a change sends the interim offer', async () => {
    mount()
    await flush()

    buttonWith('Действия с учеником')?.click()
    await flush()
    buttonWith('Изменить роль')?.click()
    await flush()

    // The who-card and the picker ride the popup.
    expect(text()).toContain('Изменить роль')
    expect(text()).toContain('Выберите роль')
    expect(text()).toContain('Пётр Сидоров')
    // Preselected on the CURRENT role (owner decision 2026-09-22): student.
    expect(exactButton('Ученик')?.getAttribute('aria-checked')).toBe('true')

    exactButton('Мастер')?.click()
    await flush()

    const confirm = exactButton('Изменить')
    expect(confirm?.disabled).toBe(false)
    confirm?.click()
    await flush()

    // INTERIM wiring (stopper BE-59): the same GT-27 offer until the
    // role-request contract lands.
    expect(cgApi.offerCuratorGroupMaster).toHaveBeenCalledWith('g1', 'u9')
    expect(toastSuccess).toHaveBeenCalledWith('Предложение отправлено')
    // The appointment takes effect only when the appointee accepts -- no
    // navigation, no local roster rewrite.
    expect(replace).not.toHaveBeenCalled()
  })

  it('«Изменить» is disabled while the role is unchanged -- nothing is sent', async () => {
    mount()
    await flush()

    buttonWith('Действия с учеником')?.click()
    await flush()
    buttonWith('Изменить роль')?.click()
    await flush()

    const confirm = exactButton('Изменить')
    expect(confirm?.disabled).toBe(true)
    confirm?.click()
    await flush()

    expect(cgApi.offerCuratorGroupMaster).not.toHaveBeenCalled()
  })

  it('a current master gets NO student option -- demotion has no contract (§7.1 №6)', async () => {
    vi.mocked(cgApi.getCuratorGroupMembers).mockResolvedValue({
      items: [
        {
          user_id: 'u9',
          name: 'Пётр Сидоров',
          avatar_url: null,
          kind: 'master',
          joined_at: '2026-09-01T00:00:00Z',
          is_visible: true,
        },
      ],
      total: 1,
      limit: 100,
      offset: 0,
    })
    mount()
    await flush()

    buttonWith('Действия с учеником')?.click()
    await flush()
    buttonWith('Изменить роль')?.click()
    await flush()

    expect(exactButton('Ученик')).toBeUndefined()
    expect(exactButton('Мастер')?.getAttribute('aria-checked')).toBe('true')
    expect(exactButton('Изменить')?.disabled).toBe(true)
    expect(cgApi.offerCuratorGroupMaster).not.toHaveBeenCalled()
  })

  it('master_required surfaces the errorMessages phrase, not a raw code', async () => {
    vi.mocked(cgApi.offerCuratorGroupMaster).mockRejectedValue(
      new ApiResponseError(403, 'master required', 'master_required'),
    )
    mount()
    await flush()

    buttonWith('Действия с учеником')?.click()
    await flush()
    buttonWith('Изменить роль')?.click()
    await flush()
    exactButton('Мастер')?.click()
    await flush()
    exactButton('Изменить')?.click()
    await flush()

    expect(toastError).toHaveBeenCalledWith(
      'Назначить мастером школы можно только верифицированного мастера',
    )
  })

  it('«Написать сообщение» opens the SendMessageModal for THIS student', async () => {
    mount()
    await flush()

    buttonWith('Действия с учеником')?.click()
    await flush()
    buttonWith('Написать сообщение')?.click()
    await flush()

    // The recipient chip carries the roster name; the modal's own pills show.
    expect(exactButton('Отправить')).toBeTruthy()
    expect(exactButton('Отмена')).toBeTruthy()
  })

  it('owner 2026-09-30: an exclusion no longer exists -- no affordance, no removal API calls', async () => {
    mount()
    await flush()

    buttonWith('Действия с учеником')?.click()
    await flush()

    expect(buttonWith('Исключить из школы')).toBeUndefined()
    expect(exactButton('Исключить')).toBeUndefined()
    expect(cgApi.getCuratorGroupRemovePreview).not.toHaveBeenCalled()
    expect(cgApi.removeCuratorGroupMember).not.toHaveBeenCalled()
  })

  it('a masked 404 is its own rung (P-08), not an error and not an empty hero', async () => {
    vi.mocked(cgApi.getCuratorGroupStudentProfile).mockRejectedValue(
      new ApiResponseError(404, 'not found', 'not_found'),
    )
    mount()
    await flush()

    expect(text()).toContain('Ученик недоступен')
    expect(text()).not.toContain('Пётр Сидоров')
    expect(buttonWith('К списку учеников')).toBeTruthy()
  })

  it('a non-404 failure is retryable: «Не удалось загрузить профиль» + «Повторить»', async () => {
    vi.mocked(cgApi.getCuratorGroupStudentProfile).mockRejectedValue(
      new ApiResponseError(500, 'boom', 'internal_error'),
    )
    mount()
    await flush()

    expect(text()).toContain('Не удалось загрузить профиль')
    expect(buttonWith('Повторить')).toBeTruthy()

    vi.mocked(cgApi.getCuratorGroupStudentProfile).mockResolvedValue(profileFixture())
    buttonWith('Повторить')?.click()
    await flush()

    expect(text()).toContain('Пётр Сидоров')
  })

  it('an honest zero: hero stays, both stat cards show «0»', async () => {
    vi.mocked(cgApi.getCuratorGroupStudentProfile).mockResolvedValue(
      profileFixture({ practices_count: 0, hours: 0 }),
    )
    mount()
    await flush()

    expect(text()).toContain('Пётр Сидоров')
    const values = statValues()
    expect(values).toEqual(['0', '0'])
  })

  it('the recent_* contract arrays are NOT rendered (§1.13: no diagnostics on this screen yet)', async () => {
    vi.mocked(cgApi.getCuratorGroupStudentProfile).mockResolvedValue(
      profileFixture({
        recent_checkins: [
          {
            mood: 3,
            comment: 'Секретный чекин',
            practice_id: 'p1',
            practice_title: 'Практика p1',
            created_at: '2026-09-01T00:00:00Z',
          },
        ],
        recent_feedbacks: [
          {
            rating: 9,
            comment: 'Секретный фидбек',
            practice_id: 'p1',
            practice_title: 'Практика p1',
            created_at: '2026-09-01T00:00:00Z',
          },
        ],
      }),
    )
    mount()
    await flush()

    expect(text()).not.toContain('Секретный чекин')
    expect(text()).not.toContain('Секретный фидбек')
  })
})

describe('pending school-master offer', () => {
  it.each([
    ['awaiting_verification', 'Ожидает проверки мастера'],
    ['awaiting_answer', 'Ожидает ответа участника'],
  ] as const)('shows %s and cancels only on confirmation', async (state, label) => {
    vi.mocked(cgApi.getCuratorGroupStudentProfile).mockResolvedValue(
      profileFixture({ master_offer: state }),
    )
    mount()
    await flush()
    expect(text()).toContain(label)
    exactButton('Отменить предложение')?.click()
    await flush()
    expect(cgApi.cancelCuratorGroupMasterOffer).not.toHaveBeenCalled()
    vi.mocked(cgApi.getCuratorGroupStudentProfile).mockResolvedValue(
      profileFixture({ master_offer: null }),
    )
    const dialog = document.body.querySelector('.v-modal__overlay')
    const confirm = Array.from(dialog?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent?.trim() === 'Отменить предложение',
    )
    expect(confirm).toBeTruthy()
    confirm?.click()
    confirm?.click()
    await flush()
    expect(cgApi.cancelCuratorGroupMasterOffer).toHaveBeenCalledTimes(1)
    expect(cgApi.cancelCuratorGroupMasterOffer).toHaveBeenCalledWith('g1', 'u9')
    expect(text()).not.toContain(label)
    expect(toastSuccess).toHaveBeenCalledWith('Предложение отменено')
  })

  it('keeps the offer and exposes failure if cancellation fails', async () => {
    vi.mocked(cgApi.getCuratorGroupStudentProfile).mockResolvedValue(
      profileFixture({ master_offer: 'awaiting_answer' }),
    )
    vi.mocked(cgApi.cancelCuratorGroupMasterOffer).mockRejectedValue(new Error('offline'))
    mount()
    await flush()
    exactButton('Отменить предложение')?.click()
    await flush()
    const dialog = document.body.querySelector('.v-modal__overlay')
    Array.from(dialog?.querySelectorAll('button') ?? [])
      .find((b) => b.textContent?.trim() === 'Отменить предложение')
      ?.click()
    await flush()
    expect(text()).toContain('Ожидает ответа участника')
    expect(toastError).toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('shows the state read back from the server after making an offer', async () => {
    mount()
    await flush()
    buttonWith('Действия с учеником')?.click()
    await flush()
    buttonWith('Изменить роль')?.click()
    await flush()
    exactButton('Мастер')?.click()
    await flush()
    vi.mocked(cgApi.getCuratorGroupStudentProfile).mockResolvedValue(
      profileFixture({ master_offer: 'awaiting_verification' }),
    )
    exactButton('Изменить')?.click()
    await flush()
    expect(text()).toContain('Ожидает проверки мастера')
    expect(cgApi.getCuratorGroupStudentProfile).toHaveBeenCalledTimes(2)
  })

  it('does not allow an offer when the current role lookup fails', async () => {
    vi.mocked(cgApi.getCuratorGroupMembers).mockRejectedValueOnce(new Error('offline'))
    mount()
    await flush()
    buttonWith('Действия с учеником')?.click()
    await flush()
    buttonWith('Изменить роль')?.click()
    await flush()
    expect(text()).toContain('Не удалось проверить роль участника')
    expect(exactButton('Изменить')?.disabled).toBe(true)
    expect(cgApi.offerCuratorGroupMaster).not.toHaveBeenCalled()
  })

  it('a school master can read the student but has no curator actions', async () => {
    const page = await cgApi.getCuratorGroupPage('g1')
    vi.mocked(cgApi.getCuratorGroupPage).mockResolvedValue({
      ...page,
      viewer: { relation: 'master' },
    })
    mount()
    await flush()
    expect(text()).toContain('Пётр Сидоров')
    expect(buttonWith('Действия с учеником')).toBeUndefined()
    expect(exactButton('Отменить предложение')).toBeUndefined()
  })
})
