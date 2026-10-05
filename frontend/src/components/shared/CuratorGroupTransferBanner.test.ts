// =============================================================================
// VELO Frontend -- CuratorGroupTransferBanner Tests (schools FE-21 / GT P3)
// =============================================================================
//
// The banner's two faces and its silence: curator sees "sent + cancel",
// addressee sees "accept / decline" (accept hands the NEW CURATOR's page
// up), and everyone else -- a student, a master without an offer -- sees
// nothing at all. `transfer` is filled for exactly two people by contract;
// the banner respects that boundary instead of guessing.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import CuratorGroupTransferBanner from '@/components/shared/CuratorGroupTransferBanner.vue'
import * as cgApi from '@/api/curatorGroups'
import { ApiResponseError } from '@/api/client'
import type { CuratorGroupPageResponse, CuratorGroupTransferRef } from '@/api/types'

vi.mock('@/api/curatorGroups')

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: toastSuccess, error: toastError, info: vi.fn() }),
}))

const transfer: CuratorGroupTransferRef = {
  to_user_id: 'u2',
  to_display_name: 'Пётр Сомов',
  requested_at: '2026-08-20T00:00:00Z',
}

const newCuratorPage: CuratorGroupPageResponse = {
  id: 'g1',
  name: 'Тихая школа',
  description: null,
  curator: { user_id: 'u2', display_name: 'Пётр Сомов', avatar_url: null },
  masters_count: 2,
  students_count: 5,
  viewer: { relation: 'curator' },
  transfer: null,
  created_at: '2026-08-01T00:00:00Z',
}

let app: App | null = null
let host: HTMLElement | null = null
/** Component emits, captured via a wrapper (no @vue/test-utils here). */
let events: Record<string, unknown[]> = {}

function mount(props: {
  relation: 'curator' | 'master' | 'student' | null
  transfer?: CuratorGroupTransferRef | null
  pending?: CuratorGroupTransferRef | null
}): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  events = {}
  const Wrapper = defineComponent({
    setup() {
      return () =>
        h(CuratorGroupTransferBanner, {
          transfer: props.transfer ?? null,
          pending: props.pending ?? null,
          relation: props.relation,
          groupId: 'g1',
          onCancelled: () => events['cancelled']?.push(null) ?? (events['cancelled'] = [null]),
          onAccepted: (page: CuratorGroupPageResponse) =>
            events['accepted']?.push(page) ?? (events['accepted'] = [page]),
          onDeclined: () => events['declined']?.push(null) ?? (events['declined'] = [null]),
        })
    },
  })
  app = createApp(Wrapper)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  await nextTick()
  await nextTick()
  await nextTick()
}

function bodyText(): string {
  return document.body.textContent ?? ''
}

function buttonWith(label: string): HTMLElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLElement>('button')).find(
    (b) => b.textContent?.trim() === label,
  )
}

beforeEach(() => {
  Object.values(cgApi).forEach((fn) => vi.mocked(fn).mockReset())
  toastSuccess.mockReset()
  toastError.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('CuratorGroupTransferBanner', () => {
  it('CURATOR: names the addressee and cancels the offer on demand', async () => {
    vi.mocked(cgApi.cancelCuratorGroupTransfer).mockResolvedValue(undefined)
    mount({ relation: 'curator', transfer })
    await flush()

    expect(bodyText()).toContain('Предложение передать школу отправлено: Пётр Сомов')
    buttonWith('Отменить')?.click()
    await flush()

    expect(cgApi.cancelCuratorGroupTransfer).toHaveBeenCalledWith('g1')
    expect(events['cancelled']).toBeTruthy()
  })

  it('CURATOR: the local pending echo renders before any reload supplies one', async () => {
    mount({ relation: 'curator', transfer: null, pending: transfer })
    await flush()

    expect(bodyText()).toContain('Предложение передать школу отправлено: Пётр Сомов')
  })

  it('ADDRESSEE: accept hands the NEW CURATOR page up (the page flips in place)', async () => {
    vi.mocked(cgApi.acceptCuratorGroupTransfer).mockResolvedValue(newCuratorPage)
    mount({ relation: 'master', transfer })
    await flush()

    expect(bodyText()).toContain('Вам предлагают стать куратором')
    buttonWith('Принять')?.click()
    await flush()

    expect(cgApi.acceptCuratorGroupTransfer).toHaveBeenCalledWith('g1')
    expect(events['accepted']?.[0]).toEqual(newCuratorPage)
  })

  it('ADDRESSEE: decline emits and toasts', async () => {
    vi.mocked(cgApi.declineCuratorGroupTransfer).mockResolvedValue(undefined)
    mount({ relation: 'master', transfer })
    await flush()

    buttonWith('Отклонить')?.click()
    await flush()

    expect(cgApi.declineCuratorGroupTransfer).toHaveBeenCalledWith('g1')
    expect(events['declined']).toBeTruthy()
    expect(toastSuccess).toHaveBeenCalledWith('Предложение отклонено')
  })

  it('everyone else: silence -- a student or an offer-less master sees no banner', async () => {
    mount({ relation: 'student', transfer })
    await flush()
    expect(bodyText()).not.toContain('куратором')

    mount({ relation: 'master', transfer: null })
    await flush()
    expect(bodyText()).not.toContain('куратором')
  })

  it('a failed accept shows the honest toast and emits nothing', async () => {
    vi.mocked(cgApi.acceptCuratorGroupTransfer).mockRejectedValue(
      new ApiResponseError(409, 'taken', 'curator_group_name_taken'),
    )
    mount({ relation: 'master', transfer })
    await flush()

    buttonWith('Принять')?.click()
    await flush()

    expect(toastError).toHaveBeenCalledWith('У вас уже есть школа с таким названием')
    expect(events['accepted']).toBeUndefined()
  })
})
