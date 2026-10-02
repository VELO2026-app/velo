// =============================================================================
// VELO Frontend -- CuratorGroupPageView Screen Tests (tz-curator.md §1.6)
// =============================================================================
//
// ONE page, three viewers: every behavioural difference keys off the
// server's viewer.relation. Per the owner's 2026-09-19 cut the page is:
// hero → «Редактировать школу» + four nav rows → «Создать практику» →
// «Ближайшие практики» (≤5, the page's LAST element). The rosters, the
// journal, the header «⋯» menu and the invite/transfer/delete actions are
// GONE from this page -- their tests went with them. Still covered: the
// hero counters, relation gating of rows/CTA, the edit sheet, the LEAVE
// flow (advisory preview + frozen-school 404 path), the transfer banner
// (server-driven accept/decline/cancel) and the analytics row, which since
// §6 MVP (owner 2026-10-02) navigates to the school analytics screen -- the
// zone only picks the route family.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import CuratorGroupPageView from '@/views/user/CuratorGroupPageView.vue'
import * as cgApi from '@/api/curatorGroups'
import { ApiResponseError } from '@/api/client'
import type { CuratorGroupPageResponse, PracticeResponse } from '@/api/types'

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

// CalendarPracticeCard reads the viewer timezone; mock the composable to
// keep this suite pinia-free (the page itself never touches the store).
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
  for (let i = 0; i < 6; i++) await nextTick()
  // happy-dom's crypto.subtle settles across a macrotask boundary (the
  // branding hash rides on it) -- nextTick alone does not cross it.
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

// VConfirmDialog / VBottomSheet all <Teleport to="body">, so some queries
// must run against document.body, not the mounted host.
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

/** The §1.6 action/nav rows are VMenuRow DIVs (not buttons) -- look them up
 *  by exact label across body (teleported sheets live there too). */
function rowWith(label: string): HTMLElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLElement>('.v-menu-row')).find(
    (r) => r.textContent?.trim() === label,
  )
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
  vi.mocked(cgApi.getCuratorGroupPractices).mockResolvedValue({
    items: [practiceFixture('p1')],
    total: 1,
    limit: 20,
    offset: 0,
  })
  vi.mocked(cgApi.getCuratorGroupLeavePreview).mockResolvedValue({
    upcoming_practices_targeting_group: 0,
  })
}

beforeEach(() => {
  routeState.name = 'user-curator-group'
  routeState.id = 'g1'
  Object.values(cgApi).forEach((fn) => vi.mocked(fn).mockReset())
  // §1.6 (owner 2026-09-22): the curator mounts SchoolInviteField under the
  // hero; give it an honest resolved link (the endpoint is get-or-mint).
  vi.mocked(cgApi.createCuratorGroupInvite).mockResolvedValue({
    invite_url: 'https://t.me/velopractice_bot?start=curator_group_invite__tok1',
  })
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
  // node from an already-unmounted app.
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

// -- The relation matrix ------------------------------------------------------

describe('CuratorGroupPageView -- relation matrix', () => {
  it('STUDENT: header offers «Покинуть школу», no management rows, no student roster', async () => {
    mockHappyLoad('student')
    mount()
    await flush()

    expect(buttonWith('Покинуть школу')).toBeTruthy()
    expect(rowWith('Редактировать школу')).toBeUndefined()
    // §1.11 (owner 2026-09-22): the merged «Участники» row is curator-only.
    expect(rowWith('Участники')).toBeUndefined()
    expect(rowWith('Аналитика')).toBeUndefined()
    // §1.6 (owner 2026-09-22): the invite field is curator-only too.
    expect(text()).not.toContain('Ссылка-приглашение')
    expect(text()).not.toContain('Ученики')
    // The feed is for everyone.
    expect(text()).toContain('Практика p1')
  })

  it('MASTER: same student view of the page, plus the leave action', async () => {
    mockHappyLoad('master')
    mount()
    await flush()

    expect(buttonWith('Покинуть школу')).toBeTruthy()
    expect(rowWith('Удалить школу')).toBeUndefined()
    expect(rowWith('Создать практику')).toBeUndefined()
    // §1.11 (owner 2026-09-22): a master of the school is not the curator --
    // no participants row (the server masks the roster handle anyway).
    expect(rowWith('Участники')).toBeUndefined()
    expect(text()).not.toContain('Ученики')
  })

  it('CURATOR: the full row set, no leave', async () => {
    mockHappyLoad('curator')
    mount()
    await flush()

    expect(buttonWith('Покинуть школу')).toBeFalsy()
    // Owner 2026-09-19: the page is hero + these rows + CTA + feed. The nav
    // rows carry no icons; «Участники» (§1.11, merged rosters) is the
    // curator's privilege.
    for (const row of ['Редактировать школу', 'Участники', 'Предстоящие практики', 'Аналитика']) {
      expect(rowWith(row)).toBeTruthy()
    }
    expect(buttonWith('Создать практику')).toBeTruthy()
    // §1.6 (owner 2026-09-22): the invite field rides the hero for the
    // curator (Group 3801 form: the label pill reads «Ссылка-приглашение»);
    // the mint fired exactly once on mount (get-or-get by contract).
    expect(text()).toContain('Ссылка-приглашение')
    expect(cgApi.createCuratorGroupInvite).toHaveBeenCalledTimes(1)
  })

  it('«Предстоящие практики» opens the school-scoped calendar (owner 2026-10-01)', async () => {
    // Was a scroll to the feed below; the owner moved the entry point onto
    // the calendar view, which carries the school's full upcoming list.
    mockHappyLoad('curator')
    mount()
    await flush()

    rowWith('Предстоящие практики')?.click()
    await flush()

    expect(push).toHaveBeenCalledWith({
      name: 'user-calendar-school',
      params: { groupId: 'g1' },
    })
  })

  it('a frozen/absent school is the honest 404', async () => {
    vi.mocked(cgApi.getCuratorGroupPage).mockRejectedValue(
      new ApiResponseError(404, 'not_found', 'not_found'),
    )
    mount()
    await flush()

    expect(text()).toContain('Школа не найдена')
  })

  it('transient failure: retry reloads', async () => {
    vi.mocked(cgApi.getCuratorGroupPage).mockRejectedValueOnce(new Error('blip'))
    mount()
    await flush()

    expect(text()).toContain('Не удалось загрузить школу')
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
    vi.mocked(cgApi.getCuratorGroupPage).mockRejectedValue(
      new ApiResponseError(404, 'not_found', 'not_found'),
    )
    vi.mocked(cgApi.getCuratorGroupLeavePreview).mockRejectedValue(
      new ApiResponseError(404, 'not_found', 'not_found'),
    )
    vi.mocked(cgApi.leaveCuratorGroup).mockResolvedValue(undefined)
    mount()
    await flush()

    expect(text()).toContain('Школа не найдена')
    buttonWith('Я состою в этой школе — покинуть её')?.click()
    await flush()

    expect(text()).toContain('даже если школа сейчас не активна')
    expect(text()).not.toContain('станут скрыты')
    buttonExact('Покинуть')?.click()
    await flush()

    expect(cgApi.leaveCuratorGroup).toHaveBeenCalledWith('g1')
    expect(replace).toHaveBeenCalledWith({ name: 'user-curator-groups' })
  })
})

// -- Edit school (curator) ----------------------------------------------------

describe('CuratorGroupPageView -- edit', () => {
  it('the «Редактировать школу» row prefills the sheet; save PATCHes a trimmed name', async () => {
    mockHappyLoad('curator')
    mount()
    await flush()

    rowWith('Редактировать школу')?.click()
    await flush()

    const fields = Array.from(
      document.body.querySelectorAll('input, textarea'),
    ) as HTMLInputElement[]
    expect(fields[0]!.value).toBe('Тихая школа')

    fields[0]!.value = '  Новое имя  '
    fields[0]!.dispatchEvent(new Event('input'))
    await flush()

    vi.mocked(cgApi.updateCuratorGroup).mockResolvedValue({
      ...pageFixture('curator'),
      name: 'Новое имя',
    })
    buttonWith('Сохранить')?.click()
    await flush()

    expect(cgApi.updateCuratorGroup).toHaveBeenCalledWith(
      'g1',
      'Новое имя',
      'Практики тишины',
      undefined,
    )
    expect(text()).toContain('Новое имя')
  })

  it('BE-20: avatar link is PATCHed when typed, and «сохранено как …» surfaces the normalization', async () => {
    mockHappyLoad('curator')
    mount()
    await flush()

    rowWith('Редактировать школу')?.click()
    await flush()

    const fields = Array.from(
      document.body.querySelectorAll('input, textarea'),
    ) as HTMLInputElement[]
    fields[2]!.value = 'https://CDN.Example.COM/school.png'
    fields[2]!.dispatchEvent(new Event('input'))
    await flush()

    vi.mocked(cgApi.updateCuratorGroup).mockResolvedValue(
      pageFixture('curator', null, 'https://cdn.example.com/school.png'),
    )
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
    // The hero renders the school's own logo (not the curator's).
    const img = document.body.querySelector('.school-hero__logo img')
    expect(img?.getAttribute('src')).toBe('https://cdn.example.com/school.png')
  })

  it('BE-20: clearing the link on a school that HAS an avatar PATCHes null (remove)', async () => {
    vi.mocked(cgApi.getCuratorGroupPage).mockResolvedValue(
      pageFixture('curator', null, 'https://cdn.example.com/old.png'),
    )
    mount()
    await flush()

    expect(document.body.querySelector('.school-hero__logo img')?.getAttribute('src')).toBe(
      'https://cdn.example.com/old.png',
    )

    rowWith('Редактировать школу')?.click()
    await flush()

    const fields = Array.from(
      document.body.querySelectorAll('input, textarea'),
    ) as HTMLInputElement[]
    expect(fields[2]!.value).toBe('https://cdn.example.com/old.png')
    fields[2]!.value = ''
    fields[2]!.dispatchEvent(new Event('input'))
    await flush()

    vi.mocked(cgApi.updateCuratorGroup).mockResolvedValue(pageFixture('curator'))
    buttonWith('Сохранить')?.click()
    await flush()

    expect(cgApi.updateCuratorGroup).toHaveBeenCalledWith(
      'g1',
      'Тихая школа',
      'Практики тишины',
      null,
    )
    expect(toastInfo).not.toHaveBeenCalled()
    // The logo falls back to the generated mandala: an <img> fed by a
    // data-URL SVG derived from the hash -- never the dead avatar URL.
    // The badge's own root IS the img (the class rides the child root), so
    // the lookup goes through the frame, not the logo class.
    const fallbackSrc = document.body
      .querySelector('.school-hero__logo-frame img')
      ?.getAttribute('src')
    expect(fallbackSrc ?? '').not.toContain('cdn.example.com')
    expect(fallbackSrc ?? '').toContain('data:image/svg')
  })
})

// -- Transfer banner (FE-21, server-driven) ------------------------------------

describe('CuratorGroupPageView -- transfer banner', () => {
  it('addressee accepts: the accept response REPLACES the page -- curator mode without a reload', async () => {
    mockHappyLoad('master', transferFixture)
    vi.mocked(cgApi.acceptCuratorGroupTransfer).mockResolvedValue(pageFixture('curator'))
    mount()
    await flush()

    expect(text()).toContain('Вам предлагают стать куратором')
    buttonWith('Принять')?.click()
    await flush()

    expect(cgApi.acceptCuratorGroupTransfer).toHaveBeenCalledWith('g1')
    // Flipped into curator mode in place: the management rows appeared, the
    // banner went.
    expect(rowWith('Редактировать школу')).toBeTruthy()
    expect(text()).not.toContain('Вам предлагают стать куратором')
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

  it('a member with no offer sees no banner at all (transfer is two-people-only)', async () => {
    mockHappyLoad('student')
    mount()
    await flush()

    expect(text()).not.toContain('Вам предлагают стать куратором')
    expect(text()).not.toContain('Предложение передать школу отправлено')
  })
})

// -- §1.6 hero + rows + feed (tz-curator.md, ред. 13/14 text contract) --------

describe('CuratorGroupPageView -- §1.6 page body', () => {
  it('the hero counters read the page payload -- students first, then masters', async () => {
    mockHappyLoad('student')
    mount()
    await flush()

    const counts = text()
    expect(counts).toContain('5 учеников')
    expect(counts).toContain('2 мастера')
    // The mockup's order: students pair before the masters pair.
    expect(counts.indexOf('5 учеников')).toBeLessThan(counts.indexOf('2 мастера'))
  })

  it('no avatar stack and no invite anywhere on the page (§1.8 + owner)', async () => {
    mockHappyLoad('curator')
    mount()
    await flush()

    expect(document.body.querySelector('.avs')).toBeNull()
    const hero = document.body.querySelector('.school-hero')
    expect(hero?.textContent).not.toContain('Пригласить')
    expect(rowWith('Пригласить')).toBeUndefined()
  })

  it('the curator page carries the edit row, the nav rows and the create CTA', async () => {
    mockHappyLoad('curator')
    mount()
    await flush()

    // VMenuRow renders a div, so these are text-level assertions.
    expect(text()).toContain('Редактировать школу')
    // §1.11 (owner 2026-09-22): one merged «Участники» row replaces the two
    // roster rows.
    expect(text()).toContain('Участники')
    expect(text()).not.toContain('Список мастеров')
    expect(text()).not.toContain('Список учеников')
    expect(text()).toContain('Предстоящие практики')
    // The analytics row is always surfaced now (owner 2026-09-19).
    expect(text()).toContain('Аналитика')

    buttonWith('Создать практику')?.click()
    await flush()
    expect(push).toHaveBeenCalledWith({
      name: 'master-practice-new',
      query: { groupId: 'g1' },
    })
  })

  it('a non-curator gets no edit row, no participants row and no create CTA', async () => {
    mockHappyLoad('master')
    mount()
    await flush()

    expect(text()).not.toContain('Редактировать школу')
    // §1.11 (owner 2026-09-22): the merged «Участники» row is the curator's
    // privilege -- the rosters are the curator handle on the server, which
    // already answered non-curators with the masked 404.
    expect(text()).not.toContain('Участники')
    expect(text()).not.toContain('Список мастеров')
    expect(text()).not.toContain('Список учеников')
    expect(rowWith('Аналитика')).toBeUndefined()
    expect(buttonWith('Создать практику')).toBeUndefined()
    // The rows every member shares still render.
    expect(text()).toContain('Предстоящие практики')
  })

  it('§1.11: the participants row opens the merged roster screen (user zone)', async () => {
    mockHappyLoad('curator')
    mount()
    await flush()

    rowWith('Участники')?.click()
    await flush()
    expect(push).toHaveBeenCalledWith({ name: 'user-curator-group-members', params: { id: 'g1' } })
  })

  it('§1.11: the zone picks the participants route family (master zone)', async () => {
    routeState.name = 'master-curator-group'
    mockHappyLoad('curator')
    mount()
    await flush()

    rowWith('Участники')?.click()
    await flush()
    expect(push).toHaveBeenCalledWith({
      name: 'master-curator-group-members',
      params: { id: 'g1' },
    })
  })

  it('§6 MVP: the analytics row opens the school analytics screen (user zone)', async () => {
    mockHappyLoad('curator')
    mount()
    await flush()

    rowWith('Аналитика')?.click()
    await flush()
    expect(push).toHaveBeenCalledWith({
      name: 'user-curator-group-analytics',
      params: { id: 'g1' },
    })
  })

  it('§6 MVP: the analytics row follows the zone (master zone)', async () => {
    routeState.name = 'master-curator-group'
    mockHappyLoad('curator')
    mount()
    await flush()

    rowWith('Аналитика')?.click()
    await flush()
    expect(push).toHaveBeenCalledWith({
      name: 'master-curator-group-analytics',
      params: { id: 'g1' },
    })
  })

  it("the feed shows at most five practices and is the page's last section", async () => {
    const seven = Array.from({ length: 7 }, (_, i) => practiceFixture(`p${i + 1}`))
    mockHappyLoad('curator')
    vi.mocked(cgApi.getCuratorGroupPractices).mockResolvedValue({
      items: seven,
      total: 7,
      limit: 20,
      offset: 0,
    })
    mount()
    await flush()

    expect(text()).toContain('Практика p5')
    expect(text()).not.toContain('Практика p6')
    expect(text()).not.toContain('Практика p7')
    // Nothing follows the feed: the journal and the rosters are gone.
    expect(text()).not.toContain('Журнал школы')
    expect(text()).not.toContain('Мастеров пока нет')
    expect(text()).not.toContain('Учеников пока нет')
  })
})
