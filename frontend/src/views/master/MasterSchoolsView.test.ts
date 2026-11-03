// =============================================================================
// VELO Frontend -- MasterSchoolsView Screen Tests (schools FE-20 / GT P3)
// =============================================================================
//
// Same idiom as UserMySchoolsView.test.ts, plus the master list's own
// distinctions: the curator/member section tabs
// (i18n:masterScreens.masterSchools.tab.curator, i18n:masterScreens.masterSchools.tab.member)
// over one /mine payload, and -- since BE-18 -- the «+» gated on the
// admin-issued can_create_schools flag that rides on GET /masters/me/schools.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import MasterSchoolsView from '@/views/master/MasterSchoolsView.vue'
import * as cgApi from '@/api/schools'
import type { SchoolMineResponse } from '@/api/types'

vi.mock('@/api/schools')

const push = vi.fn()
const replace = vi.fn()
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: {}, name: 'master-schools' }),
  useRouter: () => ({ push, replace }),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}))

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(MasterSchoolsView).use(createTestI18n())
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

function buttonWith(label: string): HTMLElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLElement>('button') ?? []).find(
    (b) => b.textContent?.trim().includes(label) || b.getAttribute('aria-label') === label,
  )
}

const row = (id: string, relation: 'curator' | 'master' | 'student') => ({
  id,
  name: `Школа ${id}`,
  description: null,
  curator: { user_id: 'u1', display_name: 'Мария Иванова', avatar_url: null },
  masters_count: 2,
  students_count: 7,
  relation,
  transfer_offered: false,
})

beforeEach(() => {
  vi.mocked(cgApi.getMySchools).mockReset()
  // BE-18: the flag rides on the CURATOR list call. Default true keeps the
  // pre-BE-18 behaviour for the row/section tests; the gate has its own.
  vi.mocked(cgApi.getSchools).mockReset().mockResolvedValue({ items: [], can_create_schools: true })
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

describe('MasterSchoolsView', () => {
  it('sections one /mine payload into «Я куратор» and «Я участник»', async () => {
    vi.mocked(cgApi.getMySchools).mockResolvedValue({
      items: [row('g1', 'curator'), row('g2', 'master'), row('g3', 'student')],
    } satisfies SchoolMineResponse)
    mount()
    await flush()

    const sections = Array.from(host?.querySelectorAll('.velo-section-title') ?? []).map(
      (h) => h.textContent,
    )
    expect(sections).toEqual(['Я куратор', 'Я участник'])
    // Curated first even though a student row came in between.
    const curated = host?.querySelector('.mcg__content')?.textContent ?? ''
    expect(curated.indexOf('Школа g1')).toBeLessThan(curated.indexOf('Школа g2'))
  })

  it('tap navigates into the MASTER zone page', async () => {
    vi.mocked(cgApi.getMySchools).mockResolvedValue({
      items: [row('g1', 'curator')],
    } satisfies SchoolMineResponse)
    mount()
    await flush()

    const first = host?.querySelector('.cg-row') as HTMLElement
    first.click()
    await flush()
    expect(push).toHaveBeenCalledWith({ name: 'master-school', params: { id: 'g1' } })
  })

  it('the «+» is present with the right (BE-18) and opens the create form', async () => {
    vi.mocked(cgApi.getMySchools).mockResolvedValue({
      items: [],
    } satisfies SchoolMineResponse)
    mount()
    await flush()

    const add = buttonWith('Новая школа')
    expect(add).toBeTruthy()
    add?.click()
    await flush()
    expect(push).toHaveBeenCalledWith({ name: 'master-school-create' })
  })

  it('BE-18: NO right -> no «+», no create button, and the hint says who issues it', async () => {
    vi.mocked(cgApi.getMySchools).mockResolvedValue({
      items: [row('g1', 'curator')],
    } satisfies SchoolMineResponse)
    vi.mocked(cgApi.getSchools).mockResolvedValue({
      items: [],
      can_create_schools: false,
    })
    mount()
    await flush()

    expect(buttonWith('Новая школа')).toBeFalsy()
    expect(buttonWith('Создать школу')).toBeFalsy()
    // Rows still render; the right is about FOUNDING, not about membership.
    expect(text()).toContain('Школа g1')
    expect(text()).toContain('Создавать школы может мастер, которому администратор выдал это право')
  })

  it('BE-18: no right and no schools -> the empty state offers only the invite-link way in', async () => {
    vi.mocked(cgApi.getMySchools).mockResolvedValue({
      items: [],
    } satisfies SchoolMineResponse)
    vi.mocked(cgApi.getSchools).mockResolvedValue({
      items: [],
      can_create_schools: false,
    })
    mount()
    await flush()

    expect(text()).toContain('Вступите по ссылке от куратора')
    expect(buttonWith('Создать школу')).toBeFalsy()
  })

  it('BE-18: a FAILED flag call degrades to "no «+»" -- rows still render, no error screen', async () => {
    vi.mocked(cgApi.getMySchools).mockResolvedValue({
      items: [row('g1', 'curator')],
    } satisfies SchoolMineResponse)
    vi.mocked(cgApi.getSchools).mockRejectedValue(new Error('blip'))
    mount()
    await flush()

    // The two calls are not equal: /mine is the screen, the flag is a bonus.
    expect(text()).toContain('Школа g1')
    expect(text()).not.toContain('Не удалось загрузить школы')
    expect(buttonWith('Новая школа')).toBeFalsy()
    expect(text()).toContain('администратор выдал это право')
  })

  it('empty list: the hint covers BOTH ways in (create or join by link)', async () => {
    vi.mocked(cgApi.getMySchools).mockResolvedValue({
      items: [],
    } satisfies SchoolMineResponse)
    mount()
    await flush()

    expect(text()).toContain('Создайте школу или вступите по ссылке от куратора')
    const create = buttonWith('Создать школу')
    expect(create).toBeTruthy()
  })

  it('load failure: error state with a working retry', async () => {
    vi.mocked(cgApi.getMySchools).mockRejectedValueOnce(new Error('network'))
    mount()
    await flush()

    expect(text()).toContain('Не удалось загрузить школы')

    vi.mocked(cgApi.getMySchools).mockResolvedValueOnce({
      items: [row('g1', 'curator')],
    } satisfies SchoolMineResponse)
    buttonWith('Повторить')?.click()
    await flush()

    expect(text()).toContain('Я куратор')
  })
})
