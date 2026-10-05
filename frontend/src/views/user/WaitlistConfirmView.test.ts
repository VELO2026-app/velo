// =============================================================================
// VELO Frontend -- WaitlistConfirmView tests (Links, 3 October)
// =============================================================================
//
// The «Освободилось место» screen: the entry from GET /waitlist/me by id,
// «Подтвердить место» -> POST /waitlist/{id}/confirm -> the practice page;
// every other state says what it is. A 400 does not say which case it was,
// so the screen re-reads the entry and shows its state.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createPinia } from 'pinia'
import WaitlistConfirmView from '@/views/user/WaitlistConfirmView.vue'
import * as waitlistApi from '@/api/waitlist'
import { ApiResponseError } from '@/api/client'
import type { PaginatedWaitlistResponse, WaitlistWithPracticeResponse } from '@/api/types'

vi.mock('@/api/waitlist')

const push = vi.fn()
const back = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, back }),
  useRoute: () => ({ params: { id: 'w1' } }),
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: vi.fn() }),
}))

const HOUR = 3600 * 1000

function entry(
  overrides: Partial<WaitlistWithPracticeResponse> = {},
): WaitlistWithPracticeResponse {
  return {
    id: 'w1',
    practice_id: 'p1',
    user_id: 'u1',
    position: 1,
    status: 'notified',
    joined_at: '2026-10-01T10:00:00Z',
    notified_at: new Date(Date.now() - HOUR).toISOString(),
    expires_at: new Date(Date.now() + HOUR).toISOString(),
    created_at: '2026-10-01T10:00:00Z',
    updated_at: null,
    practice: {
      id: 'p1',
      title: 'Утренняя медитация',
      scheduled_at: '2026-10-05T07:00:00Z',
      timezone: 'Europe/Berlin',
      master_name: 'Анна',
    },
    ...overrides,
  } as WaitlistWithPracticeResponse
}

function page(items: WaitlistWithPracticeResponse[]): PaginatedWaitlistResponse {
  return { items, total: items.length, limit: 100, offset: 0 }
}

let app: App | null = null
let host: HTMLElement | null = null

function mount(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(WaitlistConfirmView)
  app.use(createPinia())
  app.mount(host)
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}

function buttonWith(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll('button') ?? []).find((b) =>
    b.textContent?.includes(label),
  )
}

beforeEach(() => {
  push.mockReset()
  back.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
  vi.mocked(waitlistApi.getMyWaitlist)
    .mockReset()
    .mockResolvedValue(page([entry()]))
  vi.mocked(waitlistApi.confirmWaitlist)
    .mockReset()
    .mockResolvedValue({
      waitlist_entry: entry({ status: 'converted' }),
      booking_id: 'b1',
    } as never)
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('WaitlistConfirmView', () => {
  it('shows the practice and the deadline; «Подтвердить место» confirms THAT entry, then the practice', async () => {
    mount()
    await flush()

    expect(text()).toContain('Утренняя медитация')
    expect(text()).toContain('Подтвердите участие до')
    buttonWith('Подтвердить место')!.click()
    await flush()

    expect(waitlistApi.confirmWaitlist).toHaveBeenCalledWith('w1')
    expect(toastSuccess).toHaveBeenCalledWith('Место подтверждено')
    expect(push).toHaveBeenCalledWith({ name: 'practice-detail', params: { id: 'p1' } })
  })

  it('a deadline already passed says so honestly, with no confirm button', async () => {
    vi.mocked(waitlistApi.getMyWaitlist).mockResolvedValue(
      page([entry({ expires_at: new Date(Date.now() - HOUR).toISOString() })]),
    )
    mount()
    await flush()

    expect(text()).toContain('Срок подтверждения истёк')
    expect(buttonWith('Подтвердить место')).toBeUndefined()
    buttonWith('Открыть практику')!.click()
    expect(push).toHaveBeenCalledWith({ name: 'practice-detail', params: { id: 'p1' } })
  })

  it.each([
    ['expired', 'Срок подтверждения истёк'],
    ['converted', 'Место уже подтверждено'],
    ['waiting', 'Вы в очереди'],
  ] as const)('status %s -> its own text and the practice link', async (status, phrase) => {
    vi.mocked(waitlistApi.getMyWaitlist).mockResolvedValue(page([entry({ status })]))
    mount()
    await flush()

    expect(text()).toContain(phrase)
    expect(buttonWith('Подтвердить место')).toBeUndefined()
    expect(buttonWith('Открыть практику')).toBeDefined()
  })

  it('no such entry -> «Запись не найдена», no confirm', async () => {
    vi.mocked(waitlistApi.getMyWaitlist).mockResolvedValue(page([entry({ id: 'other' })]))
    mount()
    await flush()

    expect(text()).toContain('Запись не найдена')
    expect(buttonWith('Подтвердить место')).toBeUndefined()
  })

  it('confirm 400 -> the entry is re-read and shows what happened (here: expired)', async () => {
    vi.mocked(waitlistApi.getMyWaitlist)
      .mockResolvedValueOnce(page([entry()]))
      .mockResolvedValueOnce(page([entry({ status: 'expired' })]))
    vi.mocked(waitlistApi.confirmWaitlist).mockRejectedValueOnce(
      new ApiResponseError(400, 'Waitlist offer has expired', 'bad_request'),
    )
    mount()
    await flush()
    buttonWith('Подтвердить место')!.click()
    await flush()

    expect(waitlistApi.getMyWaitlist).toHaveBeenCalledTimes(2)
    expect(text()).toContain('Срок подтверждения истёк')
    expect(push).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('confirm failing otherwise -> the error toast, the button stays, no navigation', async () => {
    vi.mocked(waitlistApi.confirmWaitlist).mockRejectedValueOnce(new TypeError('net'))
    mount()
    await flush()
    buttonWith('Подтвердить место')!.click()
    await flush()

    expect(toastError).toHaveBeenCalled()
    expect(buttonWith('Подтвердить место')).toBeDefined()
    expect(push).not.toHaveBeenCalled()
  })
})
