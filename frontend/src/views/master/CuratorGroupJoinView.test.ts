// =============================================================================
// VELO Frontend -- CuratorGroupJoinView Screen Tests (schools FE-18 / GT P3)
// =============================================================================
//
// Same idiom as GroupJoinView.test.ts (createApp/mount, real ApiResponseError
// for status-based branching, mocked vue-router + useToast), extended for the
// two-step preview->join contract this screen adds: the preview DESCRIBES a
// refusal instead of raising it, join re-validates everything, and the
// student-upgrade nuance (can_join=true + relation="student") must keep the
// Join button alive.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import CuratorGroupJoinView from '@/views/master/CuratorGroupJoinView.vue'
import * as cgApi from '@/api/curatorGroups'
import { ApiResponseError } from '@/api/client'
import type { CuratorGroupInvitePreviewResponse } from '@/api/types'

vi.mock('@/api/curatorGroups')

const push = vi.fn()
const replace = vi.fn()
const routeParams: { token: string } = { token: 'a'.repeat(43) }
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: routeParams }),
  useRouter: () => ({ push, replace }),
}))

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: toastSuccess, error: toastError, info: vi.fn() }),
}))

// The school page route depends on the viewer's role -- the store mock is
// mutable per test via mockRole.
let mockRole: 'user' | 'master' | 'admin' = 'user'
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ role: mockRole }),
}))

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(CuratorGroupJoinView)
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

function buttonWith(label: string): HTMLElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLElement>('button') ?? []).find((b) =>
    b.textContent?.trim().includes(label),
  )
}

/** A green preview: a school, kind=student, viewer not yet a member. */
function previewResponse(
  overrides: Partial<CuratorGroupInvitePreviewResponse> = {},
): CuratorGroupInvitePreviewResponse {
  return {
    group: {
      id: 'g1',
      name: 'Тихая школа',
      description: 'Практики тишины',
      curator_name: 'Мария Иванова',
      masters_count: 3,
      students_count: 12,
    },
    kind: 'student',
    can_join: true,
    reason: null,
    relation: null,
    ...overrides,
  }
}

beforeEach(() => {
  routeParams.token = 'a'.repeat(43)
  mockRole = 'user'
  vi.mocked(cgApi.getCuratorGroupInvitePreview).mockReset()
  vi.mocked(cgApi.joinCuratorGroup).mockReset()
  push.mockReset()
  replace.mockReset()
  toastSuccess.mockReset()
  toastError.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('CuratorGroupJoinView -- preview states', () => {
  it('shows the loading state while the preview is in flight', async () => {
    vi.mocked(cgApi.getCuratorGroupInvitePreview).mockReturnValue(new Promise(() => {}))
    mount()
    await flush()

    expect(text()).toContain('Проверяем приглашение…')
  })

  it('renders the school card for a green preview: name, curator, counts, kind label', async () => {
    vi.mocked(cgApi.getCuratorGroupInvitePreview).mockResolvedValue(previewResponse())
    mount()
    await flush()

    expect(text()).toContain('Тихая школа')
    expect(text()).toContain('Куратор: Мария Иванова')
    expect(text()).toContain('Практики тишины')
    expect(text()).toContain('Мастеров: 3')
    expect(text()).toContain('как ученик')
    expect(buttonWith('Вступить')).toBeTruthy()
    expect(buttonWith('Отказаться')).toBeTruthy()
    // No upgrade hint for a plain stranger.
    expect(text()).not.toContain('повысит вас до мастера')
  })

  it('hides the optional curator line when the preview has none (honest empties)', async () => {
    vi.mocked(cgApi.getCuratorGroupInvitePreview).mockResolvedValue(
      previewResponse({
        group: {
          id: 'g1',
          name: 'Тихая школа',
          description: null,
          curator_name: null,
          masters_count: 0,
          students_count: 0,
        },
      }),
    )
    mount()
    await flush()

    expect(text()).not.toContain('Куратор:')
    expect(buttonWith('Вступить')).toBeTruthy()
  })

  it('the upgrade nuance: student opening a master link keeps the Join button and explains it', async () => {
    vi.mocked(cgApi.getCuratorGroupInvitePreview).mockResolvedValue(
      previewResponse({ kind: 'master', relation: 'student' }),
    )
    mount()
    await flush()

    expect(buttonWith('Вступить')).toBeTruthy()
    expect(text()).toContain('повысит вас до мастера школы')
  })

  it('on 404: the one honest answer for unknown/revoked/frozen/deleted links', async () => {
    vi.mocked(cgApi.getCuratorGroupInvitePreview).mockRejectedValue(
      new ApiResponseError(404, 'invite_not_found', 'not found'),
    )
    mount()
    await flush()

    expect(text()).toContain('Приглашение недействительно')
    expect(text()).not.toContain('Вступить')
  })

  it.each([
    ['master_required', 'Ссылка для верифицированных мастеров'],
    ['blocked_by_curator', 'Вступление недоступно'],
  ] as const)(
    'described refusal %s renders its own copy and no Join button',
    async (reason, title) => {
      vi.mocked(cgApi.getCuratorGroupInvitePreview).mockResolvedValue(
        previewResponse({ can_join: false, reason }),
      )
      mount()
      await flush()

      expect(text()).toContain(title)
      expect(buttonWith('Вступить')).toBeFalsy()
    },
  )

  it.each([
    ['own_group', 'Это ваша школа'],
    ['already_member', 'Вы уже в школе'],
  ] as const)(
    'described refusal %s offers «Открыть» into the school page',
    async (reason, title) => {
      vi.mocked(cgApi.getCuratorGroupInvitePreview).mockResolvedValue(
        previewResponse({ can_join: false, reason, relation: 'master' }),
      )
      mount()
      await flush()

      expect(text()).toContain(title)
      const open = buttonWith('Открыть')
      expect(open).toBeTruthy()
      open?.click()
      await flush()
      expect(replace).toHaveBeenCalledWith({ name: 'user-curator-group', params: { id: 'g1' } })
    },
  )

  it('transient preview error offers a retry, not a dead-link verdict (W11)', async () => {
    vi.mocked(cgApi.getCuratorGroupInvitePreview).mockRejectedValueOnce(new Error('network blip'))
    mount()
    await flush()

    expect(text()).toContain('Не удалось проверить приглашение')
    expect(text()).not.toContain('Приглашение недействительно')

    vi.mocked(cgApi.getCuratorGroupInvitePreview).mockResolvedValueOnce(previewResponse())
    buttonWith('Повторить')?.click()
    await flush()

    expect(text()).toContain('Тихая школа')
  })
})

describe('CuratorGroupJoinView -- the join gate', () => {
  it('on success: joins with the route token, toasts, and lands on the school page in the USER zone', async () => {
    vi.mocked(cgApi.getCuratorGroupInvitePreview).mockResolvedValue(previewResponse())
    vi.mocked(cgApi.joinCuratorGroup).mockResolvedValue({
      group_id: 'g1',
      relation: 'student',
      already_member: false,
    })
    mount()
    await flush()

    buttonWith('Вступить')?.click()
    await flush()

    expect(cgApi.joinCuratorGroup).toHaveBeenCalledWith('a'.repeat(43))
    expect(toastSuccess).toHaveBeenCalledWith('Вы вступили в школу «Тихая школа»')
    expect(replace).toHaveBeenCalledWith({ name: 'user-curator-group', params: { id: 'g1' } })
  })

  it('a MASTER lands on the master zone school page after joining', async () => {
    mockRole = 'master'
    vi.mocked(cgApi.getCuratorGroupInvitePreview).mockResolvedValue(previewResponse())
    vi.mocked(cgApi.joinCuratorGroup).mockResolvedValue({
      group_id: 'g1',
      relation: 'master',
      already_member: false,
    })
    mount()
    await flush()

    buttonWith('Вступить')?.click()
    await flush()

    expect(replace).toHaveBeenCalledWith({ name: 'master-curator-group', params: { id: 'g1' } })
  })

  it('join 404 after a green preview: the link died in between -- switch to the invalid-link state', async () => {
    vi.mocked(cgApi.getCuratorGroupInvitePreview).mockResolvedValue(previewResponse())
    vi.mocked(cgApi.joinCuratorGroup).mockRejectedValue(
      new ApiResponseError(404, 'invite_not_found', 'not found'),
    )
    mount()
    await flush()

    buttonWith('Вступить')?.click()
    await flush()

    expect(text()).toContain('Приглашение недействительно')
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('join 403/409 after a green preview: re-read the preview and render ITS described reason', async () => {
    vi.mocked(cgApi.getCuratorGroupInvitePreview)
      .mockResolvedValueOnce(previewResponse())
      .mockResolvedValueOnce(previewResponse({ can_join: false, reason: 'own_group' }))
    vi.mocked(cgApi.joinCuratorGroup).mockRejectedValue(
      new ApiResponseError(409, 'own_group', 'conflict'),
    )
    mount()
    await flush()

    buttonWith('Вступить')?.click()
    await flush()

    expect(text()).toContain('Это ваша школа')
    expect(buttonWith('Открыть')).toBeTruthy()
  })

  it('a transient join failure toasts and stays on the card (the gate can be retried)', async () => {
    vi.mocked(cgApi.getCuratorGroupInvitePreview).mockResolvedValue(previewResponse())
    vi.mocked(cgApi.joinCuratorGroup).mockRejectedValueOnce(new Error('timeout'))
    mount()
    await flush()

    buttonWith('Вступить')?.click()
    await flush()

    expect(toastError).toHaveBeenCalled()
    expect(text()).toContain('Тихая школа')
  })

  it('«Отказаться» is a pure navigation -- no server state, the link keeps working', async () => {
    vi.mocked(cgApi.getCuratorGroupInvitePreview).mockResolvedValue(previewResponse())
    mount()
    await flush()

    buttonWith('Отказаться')?.click()
    await flush()

    expect(cgApi.joinCuratorGroup).not.toHaveBeenCalled()
    expect(replace).toHaveBeenCalledWith({ name: 'root' })
  })
})
