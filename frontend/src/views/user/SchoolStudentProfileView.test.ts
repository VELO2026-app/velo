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
import type { CuratorGroupPageResponse } from '@/api/types'

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

function pageFixture(relation: 'curator' | 'master' | 'student'): CuratorGroupPageResponse {
  return {
    id: 'g1',
    name: 'Школа г1',
    description: null,
    avatar_url: null,
    masters_count: 1,
    students_count: 3,
    viewer: { relation },
    curator: { user_id: 'cur1', display_name: 'Куратор', avatar_url: null },
    transfer: null,
  } as unknown as CuratorGroupPageResponse
}

beforeEach(() => {
  routeState.name = 'user-curator-group-student'
  routeState.groupId = 'g1'
  routeState.userId = 'u9'
  routeState.nameQuery = 'Пётр Сидоров'
  Object.values(cgApi).forEach((fn) => vi.mocked(fn).mockReset())
  vi.mocked(cgApi.getCuratorGroupPage).mockResolvedValue(pageFixture('curator'))
  vi.mocked(cgApi.getCuratorGroupRemovePreview).mockResolvedValue({
    upcoming_practices_targeting_group: 0,
  })
  vi.mocked(cgApi.offerCuratorGroupMaster).mockResolvedValue(undefined)
  vi.mocked(cgApi.removeCuratorGroupMember).mockResolvedValue(undefined)
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
  it('the hero renders from the roster row query data', async () => {
    mount()
    await flush()

    expect(text()).toContain('Пётр Сидоров')
    expect(text()).not.toContain('Школа недоступна')
  })

  it("the «⋯» menu is the curator's alone (viewer.relation, §1.12.1)", async () => {
    mount()
    await flush()
    expect(buttonWith('Действия с учеником')).toBeTruthy()

    app?.unmount()
    vi.mocked(cgApi.getCuratorGroupPage).mockResolvedValue(pageFixture('student'))
    mount()
    await flush()
    expect(buttonWith('Действия с учеником')).toBeUndefined()
  })

  it('«Предложить стать мастером»: success toasts, nothing mutates locally', async () => {
    mount()
    await flush()

    buttonWith('Действия с учеником')?.click()
    await flush()
    buttonWith('Предложить стать мастером')?.click()
    await flush()

    expect(cgApi.offerCuratorGroupMaster).toHaveBeenCalledWith('g1', 'u9')
    expect(toastSuccess).toHaveBeenCalledWith('Предложение отправлено')
    // The appointment takes effect only when the appointee accepts -- no
    // navigation, no local roster rewrite.
    expect(replace).not.toHaveBeenCalled()
  })

  it('master_required surfaces the errorMessages phrase, not a raw code', async () => {
    vi.mocked(cgApi.offerCuratorGroupMaster).mockRejectedValue(
      new ApiResponseError(403, 'master required', 'master_required'),
    )
    mount()
    await flush()

    buttonWith('Действия с учеником')?.click()
    await flush()
    buttonWith('Предложить стать мастером')?.click()
    await flush()

    expect(toastError).toHaveBeenCalledWith(
      'Назначить мастером школы можно только верифицированного мастера',
    )
  })

  it('«Исключить из школы»: preview -> confirm -> DELETE -> back to the roster', async () => {
    vi.mocked(cgApi.getCuratorGroupRemovePreview).mockResolvedValue({
      upcoming_practices_targeting_group: 2,
    })
    mount()
    await flush()

    buttonWith('Действия с учеником')?.click()
    await flush()
    buttonWith('Исключить из школы')?.click()
    await flush()

    expect(cgApi.getCuratorGroupRemovePreview).toHaveBeenCalledWith('g1', 'u9')
    // The advisory line rides the dialog message.
    expect(text()).toContain('Исключить ученика «Пётр Сидоров» из школы «Школа г1»?')

    buttonWith('Исключить')?.click()
    await flush()

    expect(cgApi.removeCuratorGroupMember).toHaveBeenCalledWith('g1', 'u9')
    expect(toastSuccess).toHaveBeenCalledWith('Ученик исключён из школы')
    // Back lands on the merged roster screen, on the tab the row came from.
    expect(replace).toHaveBeenCalledWith({
      name: 'user-curator-group-members',
      params: { id: 'g1' },
      query: { kind: 'student' },
    })
  })

  it('a school 404 is its own rung (P-08), not an error and not an empty hero', async () => {
    vi.mocked(cgApi.getCuratorGroupPage).mockRejectedValue(
      new ApiResponseError(404, 'not found', 'not_found'),
    )
    mount()
    await flush()

    expect(text()).toContain('Школа недоступна')
    expect(text()).not.toContain('Пётр Сидоров')
  })
})
