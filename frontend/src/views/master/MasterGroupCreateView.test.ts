// =============================================================================
// VELO Frontend -- MasterGroupCreateView Screen Tests (Master GROUPS P2, ПРОМТ №591)
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import MasterGroupCreateView from '@/views/master/MasterGroupCreateView.vue'
import * as groupsApi from '@/api/groups'
import { ApiResponseError } from '@/api/client'

vi.mock('@/api/groups')

const push = vi.fn()
const back = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back }),
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: vi.fn() }),
}))

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(MasterGroupCreateView)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  await nextTick()
  await nextTick()
}

function nameInput(): HTMLInputElement | null {
  return host?.querySelector<HTMLInputElement>('input') ?? null
}
function submitBtn(): HTMLElement | undefined {
  return Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
    b.textContent?.includes('Создать группу'),
  )
}

beforeEach(() => {
  vi.mocked(groupsApi.createGroup).mockReset()
  push.mockReset()
  back.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('MasterGroupCreateView', () => {
  it('renders a single «Название» field and the submit button', () => {
    mount()

    expect(host?.textContent).toContain('Название')
    expect(submitBtn()).toBeDefined()
  })

  it('an empty name toasts and does not call createGroup', async () => {
    mount()

    submitBtn()?.click()
    await flush()

    expect(toastError).toHaveBeenCalledWith('Введите название группы')
    expect(groupsApi.createGroup).not.toHaveBeenCalled()
  })

  it('on success: calls createGroup with the trimmed name, toasts, and navigates to the list', async () => {
    vi.mocked(groupsApi.createGroup).mockResolvedValue({
      id: 'g1',
      name: 'VIP',
      members_count: 0,
    })
    mount()

    nameInput()!.value = '  VIP  '
    nameInput()!.dispatchEvent(new Event('input'))
    submitBtn()?.click()
    await flush()

    expect(groupsApi.createGroup).toHaveBeenCalledWith('VIP')
    expect(toastSuccess).toHaveBeenCalledWith('Группа создана')
    expect(push).toHaveBeenCalledWith({ name: 'master-groups' })
  })

  it('409 duplicate name: shows the inline field error AND a toast, does not navigate', async () => {
    vi.mocked(groupsApi.createGroup).mockRejectedValue(
      new ApiResponseError(409, "Группа с именем 'VIP' уже существует", 'conflict'),
    )
    mount()

    nameInput()!.value = 'VIP'
    nameInput()!.dispatchEvent(new Event('input'))
    submitBtn()?.click()
    await flush()

    expect(toastError).toHaveBeenCalledWith("Группа с именем 'VIP' уже существует")
    expect(host?.querySelector('.v-input__error')?.textContent).toContain('уже существует')
    expect(push).not.toHaveBeenCalled()
  })
})
