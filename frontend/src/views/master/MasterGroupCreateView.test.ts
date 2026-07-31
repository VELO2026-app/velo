// =============================================================================
// VELO Frontend -- MasterGroupCreateView Screen Tests (Master GROUPS P2, PROMPT №591)
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

  it('G17 (PROMPT №609): shows the «Основное» section heading', () => {
    mount()

    expect(host?.querySelector('.velo-section-title')?.textContent).toBe('Основное')
  })

  it('owner Q6 (PROMPT №610): shows the required-fields legend', () => {
    mount()

    expect(host?.textContent).toContain('— поля, обязательные для заполнения')
  })

  it('owner Q6/Q4 (PROMPT №610): «Название» carries the required seal, «Описание» does not', () => {
    mount()

    expect(host?.querySelector('.v-input__seal')).not.toBeNull()
    expect(host?.querySelector('.v-textarea__seal')).toBeNull()
  })

  it('owner Q4 (PROMPT №610): renders an optional «Описание» textarea', () => {
    mount()

    expect(host?.textContent).toContain('Описание')
    expect(host?.querySelector('textarea')).not.toBeNull()
  })

  it('an empty name toasts and does not call createGroup', async () => {
    mount()

    submitBtn()?.click()
    await flush()

    expect(toastError).toHaveBeenCalledWith('Введите название группы')
    expect(groupsApi.createGroup).not.toHaveBeenCalled()
  })

  it('on success: calls createGroup with the trimmed name + description, toasts, and navigates to the list', async () => {
    vi.mocked(groupsApi.createGroup).mockResolvedValue({
      id: 'g1',
      name: 'VIP',
      members_count: 0,
      description: null,
    })
    mount()

    nameInput()!.value = '  VIP  '
    nameInput()!.dispatchEvent(new Event('input'))
    submitBtn()?.click()
    await flush()

    expect(groupsApi.createGroup).toHaveBeenCalledWith('VIP', '')
    expect(toastSuccess).toHaveBeenCalledWith('Группа создана')
    expect(push).toHaveBeenCalledWith({ name: 'master-groups' })
  })

  it('on success with a description: calls createGroup with the trimmed description too (owner Q4, PROMPT №610)', async () => {
    vi.mocked(groupsApi.createGroup).mockResolvedValue({
      id: 'g1',
      name: 'VIP',
      members_count: 0,
      description: 'Для продвинутых',
    })
    mount()

    nameInput()!.value = 'VIP'
    nameInput()!.dispatchEvent(new Event('input'))
    const descField = host?.querySelector<HTMLTextAreaElement>('textarea')
    descField!.value = '  Для продвинутых  '
    descField!.dispatchEvent(new Event('input'))
    submitBtn()?.click()
    await flush()

    expect(groupsApi.createGroup).toHaveBeenCalledWith('VIP', 'Для продвинутых')
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
