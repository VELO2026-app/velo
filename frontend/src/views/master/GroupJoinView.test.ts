// =============================================================================
// VELO Frontend -- GroupJoinView Screen Tests (Master GROUPS P4, ПРОМТ №593)
// =============================================================================
//
// Landing for the group_invite__<token> deeplink. Mirrors the state-machine
// shape MasterInviteClaimView established (claim on mount -> success/honest-
// failure/transient-retry), but that view has no existing test file to
// mirror structurally -- this one follows the project's standard screen-test
// idiom instead (createApp/mount, real ApiResponseError for status-based
// branching, mocked useToast + vue-router).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import GroupJoinView from '@/views/master/GroupJoinView.vue'
import * as groupsApi from '@/api/groups'
import { ApiResponseError } from '@/api/client'

vi.mock('@/api/groups')

const push = vi.fn()
const replace = vi.fn()
const routeParams: { token: string } = { token: 'a'.repeat(43) }
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: routeParams }),
  useRouter: () => ({ push, replace }),
}))

const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: toastSuccess, error: vi.fn(), info: vi.fn() }),
}))

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(GroupJoinView)
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

beforeEach(() => {
  routeParams.token = 'a'.repeat(43)
  vi.mocked(groupsApi.joinGroup).mockReset()
  push.mockReset()
  replace.mockReset()
  toastSuccess.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('GroupJoinView', () => {
  it('shows the loading state while the join call is in flight', async () => {
    vi.mocked(groupsApi.joinGroup).mockReturnValue(new Promise(() => {}))
    mount()
    await flush()

    expect(text()).toContain('Проверяем приглашение…')
  })

  it('on success: calls joinGroup with the route token, toasts, and replaces to root', async () => {
    vi.mocked(groupsApi.joinGroup).mockResolvedValue({
      group_id: 'g1',
      group_name: 'VIP',
      master_name: 'Мария Иванова',
    })
    mount()
    await flush()

    expect(groupsApi.joinGroup).toHaveBeenCalledWith('a'.repeat(43))
    expect(toastSuccess).toHaveBeenCalledWith('Вы добавлены в группу "VIP"')
    expect(replace).toHaveBeenCalledWith({ name: 'root' })
  })

  it("on 403 (blocked by the group's master): shows the exact copy, no toast, no auto-redirect", async () => {
    vi.mocked(groupsApi.joinGroup).mockRejectedValue(
      new ApiResponseError(403, 'forbidden', 'forbidden'),
    )
    mount()
    await flush()

    expect(text()).toContain('Мастер ограничил вам доступ')
    expect(text()).toContain('Вы не сможете присоединиться к этой группе.')
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()

    buttonWith('На главную')?.click()
    await flush()
    expect(replace).toHaveBeenCalledWith({ name: 'root' })
  })

  it('on 404 (invalid/unknown token): shows the generic invalid-link copy', async () => {
    vi.mocked(groupsApi.joinGroup).mockRejectedValue(
      new ApiResponseError(404, 'not found', 'not_found'),
    )
    mount()
    await flush()

    expect(text()).toContain('Ссылка недействительна')
    expect(text()).toContain('Возможно, ссылка повреждена или устарела.')
  })

  it('on a transient error (not a genuine 403/404): offers a retry, not a dead-link verdict', async () => {
    vi.mocked(groupsApi.joinGroup).mockRejectedValueOnce(new Error('network blip'))
    mount()
    await flush()

    expect(text()).toContain('Не удалось проверить приглашение')
    expect(text()).not.toContain('Ссылка недействительна')

    vi.mocked(groupsApi.joinGroup).mockResolvedValueOnce({
      group_id: 'g1',
      group_name: 'VIP',
      master_name: 'Мария Иванова',
    })
    buttonWith('Повторить')?.click()
    await flush()

    expect(groupsApi.joinGroup).toHaveBeenCalledTimes(2)
    expect(toastSuccess).toHaveBeenCalledWith('Вы добавлены в группу "VIP"')
  })
})
