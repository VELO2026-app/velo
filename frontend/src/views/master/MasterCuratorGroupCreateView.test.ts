// =============================================================================
// VELO Frontend -- MasterCuratorGroupCreateView Screen Tests (FE-20 / GT P3)
// =============================================================================
//
// Mirrors MasterGroupCreateView's own test concerns: client-side required
// check (no POST on a blank name), trimmed payloads, success navigation
// (tz-curator.md §1.6: to the SCHOOL PAGE, not the list), and the 409
// curator_group_name_taken path surfacing as an inline field error. The §1.5
// media block is tested through the SCHOOL_MEDIA_UPLOAD_ENABLED kill-switch:
// OFF (the shipped default) renders no pickers, ON renders both.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import MasterCuratorGroupCreateView from '@/views/master/MasterCuratorGroupCreateView.vue'
import * as cgApi from '@/api/curatorGroups'
import { ApiResponseError } from '@/api/client'

vi.mock('@/api/curatorGroups')

const push = vi.fn()
const replace = vi.fn()
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: {}, name: 'master-curator-group-create' }),
  useRouter: () => ({ push, replace }),
}))

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: toastSuccess, error: toastError, info: vi.fn() }),
}))

// §1.5 kill-switch, mutable per test through the getter (the module namespace
// property is read at render time, so flipping the flag mid-file works).
const mediaFlag = vi.hoisted(() => ({ enabled: false }))
vi.mock('@/utils/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/constants')>()),
  get SCHOOL_MEDIA_UPLOAD_ENABLED() {
    return mediaFlag.enabled
  },
}))

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(MasterCuratorGroupCreateView)
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

/** The component's two VInput/VTextarea fields, in template order. */
function inputs(): HTMLInputElement[] {
  return Array.from(host?.querySelectorAll('input, textarea') ?? [])
}

async function type(values: [string, string]): Promise<void> {
  const fields = inputs()
  for (let i = 0; i < values.length; i++) {
    fields[i]!.value = values[i]!
    fields[i]!.dispatchEvent(new Event('input'))
  }
  await flush()
}

beforeEach(() => {
  vi.mocked(cgApi.createCuratorGroup).mockReset()
  push.mockReset()
  replace.mockReset()
  toastSuccess.mockReset()
  toastError.mockReset()
  mediaFlag.enabled = false
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('MasterCuratorGroupCreateView', () => {
  it('blank name: inline error, no POST', async () => {
    mount()
    await flush()

    buttonWith('Создать школу')?.click()
    await flush()

    expect(text()).toContain('Введите название школы')
    expect(cgApi.createCuratorGroup).not.toHaveBeenCalled()
  })

  it('success: posts the TRIMMED name, omits a blank description, lands on the SCHOOL PAGE (§1.6)', async () => {
    vi.mocked(cgApi.createCuratorGroup).mockResolvedValue({
      id: 'g1',
      name: 'Тихая школа',
      description: null,
      masters_count: 0,
      students_count: 0,
      transfer: null,
      created_at: '2026-08-26T00:00:00Z',
    })
    mount()
    await flush()

    await type(['  Тихая школа  ', '   '])
    buttonWith('Создать школу')?.click()
    await flush()

    expect(cgApi.createCuratorGroup).toHaveBeenCalledWith('Тихая школа', undefined)
    expect(toastSuccess).toHaveBeenCalledWith('Школа «Тихая школа» создана')
    // §1.6 (owner): creation lands on the school page with the NEW id.
    expect(replace).toHaveBeenCalledWith({ name: 'master-curator-group', params: { id: 'g1' } })
  })

  it('media kill-switch OFF (shipped default): no pickers render', async () => {
    mount()
    await flush()

    expect(host?.querySelector('label.sap')).toBeNull()
    expect(host?.querySelector('label.sbp')).toBeNull()
    // §1.5: the media sections disappear from the flow entirely -- no
    // «Аватар школы»/«Фон школы» titles without the flag.
    expect(text()).not.toContain('Аватар школы')
    expect(text()).not.toContain('Фон школы')
  })

  it('media kill-switch ON: two sequential sections AFTER «Основное» (§1.5)', async () => {
    mediaFlag.enabled = true
    mount()
    await flush()

    expect(host?.querySelector('label.sap')).toBeTruthy()
    expect(host?.querySelector('label.sbp')).toBeTruthy()
    const body = text()
    expect(body).toContain('Аватар школы')
    expect(body).toContain('Фон школы')
    // The mockup order: «Основное» first, then avatar, then banner.
    expect(body.indexOf('Основное')).toBeLessThan(body.indexOf('Аватар школы'))
    expect(body.indexOf('Аватар школы')).toBeLessThan(body.indexOf('Фон школы'))
  })

  it('a real description is forwarded trimmed', async () => {
    vi.mocked(cgApi.createCuratorGroup).mockResolvedValue({
      id: 'g1',
      name: 'Ш',
      description: 'd',
      masters_count: 0,
      students_count: 0,
      transfer: null,
      created_at: '2026-08-26T00:00:00Z',
    })
    mount()
    await flush()

    await type(['Ш', '  Практики тишины  '])
    buttonWith('Создать школу')?.click()
    await flush()

    expect(cgApi.createCuratorGroup).toHaveBeenCalledWith('Ш', 'Практики тишины')
  })

  it('409 curator_group_name_taken: inline field error + toast, stays on the form', async () => {
    vi.mocked(cgApi.createCuratorGroup).mockRejectedValue(
      new ApiResponseError(409, 'taken', 'curator_group_name_taken'),
    )
    mount()
    await flush()

    await type(['Дубль', ''])
    buttonWith('Создать школу')?.click()
    await flush()

    expect(text()).toContain('У вас уже есть школа с таким названием')
    expect(toastError).toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it('403 group_creation_not_allowed (BE-18): the form is REPLACED by the refusal, no retry loop', async () => {
    vi.mocked(cgApi.createCuratorGroup).mockRejectedValue(
      new ApiResponseError(403, 'forbidden', 'group_creation_not_allowed'),
    )
    mount()
    await flush()

    await type(['Школа', ''])
    buttonWith('Создать школу')?.click()
    await flush()

    // The honest refusal: not a field error, not a retryable failure -- the
    // RIGHT is missing, and the screen says who issues it.
    expect(text()).toContain('Создание школ недоступно')
    expect(text()).toContain('администратор выдал это право')
    expect(toastError).toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()

    // Back to the list is the only honest action left.
    buttonWith('К моим школам')?.click()
    await flush()
    expect(replace).toHaveBeenCalledWith({ name: 'master-curator-groups' })
  })
})
