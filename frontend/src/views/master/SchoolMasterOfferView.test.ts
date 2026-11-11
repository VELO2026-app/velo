// =============================================================================
// VELO Frontend -- SchoolMasterOfferView Screen Tests (BE-59/GT-27)
// =============================================================================
//
// Same idiom as SchoolJoinView.test.ts (createApp/mount, real
// ApiResponseError for status-based branching, mocked vue-router +
// useToast), for the consent screen's own contract: the school page paints
// the card, and the offer's existence is proven only by the accept --
// 404 is the honest death of the invite, 403 is the apply wizard's door,
// and decline never fails for a reason the screen could show.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import SchoolMasterOfferView from '@/views/master/SchoolMasterOfferView.vue'
import * as cgApi from '@/api/schools'
import { ApiResponseError } from '@/api/client'
import type { SchoolPageResponse } from '@/api/types'

vi.mock('@/api/schools')

const push = vi.fn()
const replace = vi.fn()
const routeParams: { id: string } = { id: 'g1' }
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

// The new membership re-reads the hub before the navigation (FE-88); the
// order inside membershipChanged is schoolsHub.test's. This app mounts
// without pinia, so the cache is a stub.
const membershipChanged = vi.hoisted(() => vi.fn())
vi.mock('@/composables/queries/schools', () => ({ membershipChanged }))
vi.mock('@pinia/colada', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pinia/colada')>()),
  useQueryCache: () => ({}),
}))

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(SchoolMasterOfferView).use(createTestI18n())
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

/** The addressee's school page: a member's view of a school with a pending
 *  offer (the offer itself is not on this payload by contract). */
function pageResponse(overrides: Partial<SchoolPageResponse> = {}): SchoolPageResponse {
  return {
    id: 'g1',
    name: 'Тихая школа',
    description: 'Практики тишины',
    avatar_url: null,
    curator: { user_id: 'u1', display_name: 'Мария Иванова', avatar_url: null },
    masters_count: 3,
    students_count: 12,
    viewer: { relation: 'student' },
    transfer: null,
    created_at: '2026-08-01T00:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  routeParams.id = 'g1'
  mockRole = 'user'
  vi.mocked(cgApi.getSchoolPage).mockReset()
  vi.mocked(cgApi.acceptSchoolMasterOffer).mockReset()
  vi.mocked(cgApi.declineSchoolMasterOffer).mockReset()
  push.mockReset()
  replace.mockReset()
  membershipChanged.mockReset().mockResolvedValue(undefined)
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

describe('SchoolMasterOfferView -- page states', () => {
  it('shows the loading state while the school page is in flight', async () => {
    vi.mocked(cgApi.getSchoolPage).mockReturnValue(new Promise(() => {}))
    mount()
    await flush()

    expect(text()).toContain('Проверяем приглашение…')
  })

  it('renders the invite card: name, curator, counts, description, heading, both buttons', async () => {
    vi.mocked(cgApi.getSchoolPage).mockResolvedValue(pageResponse())
    mount()
    await flush()

    expect(text()).toContain('Тихая школа')
    expect(text()).toContain('Куратор: Мария Иванова')
    expect(text()).toContain('12 учеников')
    expect(text()).toContain('3 мастера')
    expect(text()).toContain('Практики тишины')
    expect(text()).toContain('Приглашение стать мастером школы!')
    expect(buttonWith('Принять')).toBeTruthy()
    expect(buttonWith('Отказаться')).toBeTruthy()
  })

  it('page 404: the school is dark/gone or the reader left -- the invite is dead', async () => {
    vi.mocked(cgApi.getSchoolPage).mockRejectedValue(
      new ApiResponseError(404, 'not_found', 'not found'),
    )
    mount()
    await flush()

    expect(text()).toContain('Приглашение недействительно')
    expect(buttonWith('Принять')).toBeFalsy()
  })

  it('transient page error offers a retry, not a dead-invite verdict (W11)', async () => {
    vi.mocked(cgApi.getSchoolPage).mockRejectedValueOnce(new Error('network blip'))
    mount()
    await flush()

    expect(text()).toContain('Не удалось проверить приглашение')

    vi.mocked(cgApi.getSchoolPage).mockResolvedValueOnce(pageResponse())
    buttonWith('Повторить')?.click()
    await flush()

    expect(text()).toContain('Тихая школа')
  })
})

describe('SchoolMasterOfferView -- the accept gate', () => {
  it('on success: accepts, toasts, and lands on the school page in the USER zone', async () => {
    vi.mocked(cgApi.getSchoolPage).mockResolvedValue(pageResponse())
    vi.mocked(cgApi.acceptSchoolMasterOffer).mockResolvedValue(undefined)
    mount()
    await flush()

    buttonWith('Принять')?.click()
    await flush()

    expect(cgApi.acceptSchoolMasterOffer).toHaveBeenCalledWith('g1')
    expect(toastSuccess).toHaveBeenCalledWith('Вы теперь мастер школы «Тихая школа»')
    expect(membershipChanged).toHaveBeenCalledWith(expect.anything(), 'acceptSchoolMasterOffer')
    expect(replace).toHaveBeenCalledWith({ name: 'user-school', params: { id: 'g1' } })
    // The hub was re-read BEFORE the navigation.
    expect(membershipChanged.mock.invocationCallOrder[0]!).toBeLessThan(
      replace.mock.invocationCallOrder[0]!,
    )
  })

  it('a MASTER lands on the master zone school page after accepting', async () => {
    mockRole = 'master'
    vi.mocked(cgApi.getSchoolPage).mockResolvedValue(pageResponse())
    vi.mocked(cgApi.acceptSchoolMasterOffer).mockResolvedValue(undefined)
    mount()
    await flush()

    buttonWith('Принять')?.click()
    await flush()

    expect(replace).toHaveBeenCalledWith({ name: 'master-school', params: { id: 'g1' } })
  })

  it('accept 404: the offer is gone -- the errorMessages phrase, no retry loop', async () => {
    vi.mocked(cgApi.getSchoolPage).mockResolvedValue(pageResponse())
    vi.mocked(cgApi.acceptSchoolMasterOffer).mockRejectedValue(
      new ApiResponseError(404, 'master_offer_not_found', 'not found'),
    )
    mount()
    await flush()

    buttonWith('Принять')?.click()
    await flush()

    expect(text()).toContain('Назначение недействительно или уже отменено')
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('accept 403 master_required: the apply wizard is the way out -- the offer survives', async () => {
    vi.mocked(cgApi.getSchoolPage).mockResolvedValue(pageResponse())
    vi.mocked(cgApi.acceptSchoolMasterOffer).mockRejectedValue(
      new ApiResponseError(403, 'forbidden', 'master_required'),
    )
    mount()
    await flush()

    buttonWith('Принять')?.click()
    await flush()

    expect(text()).toContain('Нужна верификация мастера')
    const apply = buttonWith('Подать заявку')
    expect(apply).toBeTruthy()
    apply?.click()
    await flush()
    expect(replace).toHaveBeenCalledWith({ name: 'master-apply' })
  })

  it('a transient accept failure toasts and stays on the card', async () => {
    vi.mocked(cgApi.getSchoolPage).mockResolvedValue(pageResponse())
    vi.mocked(cgApi.acceptSchoolMasterOffer).mockRejectedValueOnce(new Error('timeout'))
    mount()
    await flush()

    buttonWith('Принять')?.click()
    await flush()

    expect(toastError).toHaveBeenCalled()
    expect(text()).toContain('Тихая школа')
  })
})

describe('SchoolMasterOfferView -- decline', () => {
  it('declines, toasts, and lands on the school page (FE-67: both decisions do)', async () => {
    vi.mocked(cgApi.getSchoolPage).mockResolvedValue(pageResponse())
    vi.mocked(cgApi.declineSchoolMasterOffer).mockResolvedValue(undefined)
    mount()
    await flush()

    buttonWith('Отказаться')?.click()
    await flush()

    expect(cgApi.declineSchoolMasterOffer).toHaveBeenCalledWith('g1')
    expect(toastSuccess).toHaveBeenCalledWith('Предложение отклонено')
    expect(replace).toHaveBeenCalledWith({ name: 'user-school', params: { id: 'g1' } })
  })

  it('a transient decline failure toasts and stays on the card', async () => {
    vi.mocked(cgApi.getSchoolPage).mockResolvedValue(pageResponse())
    vi.mocked(cgApi.declineSchoolMasterOffer).mockRejectedValueOnce(new Error('timeout'))
    mount()
    await flush()

    buttonWith('Отказаться')?.click()
    await flush()

    expect(toastError).toHaveBeenCalled()
    expect(text()).toContain('Тихая школа')
  })
})
