// =============================================================================
// VELO Frontend -- SupportRatingSheet Tests (FE-107 / BE-162 delivery 3)
// =============================================================================
//
// The sheet is self-contained (the pending queue, the POST, the queue's
// advance), so this file owns its BEHAVIOUR end to end: what it opens on,
// what a submit sends, how it moves to the next waiting ticket, what «Позже»
// ends, and what a deep link to an already-rated ticket does (nothing).
//
// Seams mocked: @/api/support (listPendingRatings, rateTicket) and the toast.
// The sheet is teleported (VBottomSheet) -- queries go to document.body.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import SupportRatingSheet from '@/components/shared/SupportRatingSheet.vue'
import * as supportApi from '@/api/support'
import type { PendingRatingTicket } from '@/api/support'
import { ApiResponseError } from '@/api/client'

vi.mock('@/api/support')

const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: toastSuccess, error: vi.fn(), info: vi.fn() }),
}))

function pending(id: string, overrides: Partial<PendingRatingTicket> = {}): PendingRatingTicket {
  return {
    id,
    topic: 'payment',
    category: 'payments',
    status_changed_at: '2026-10-27T10:00:00Z',
    ...overrides,
  }
}

let app: App | null = null
let host: HTMLElement | null = null

function mount(preferredTicketId?: string | null): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(SupportRatingSheet, {
    active: true,
    preferredTicketId: preferredTicketId ?? null,
  })
  app.use(createTestI18n())
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await nextTick()
}

/** The teleported sheet's overlay -- document, never `host`. Its Transition
 *  keeps the element through the leave animation, so a leaving overlay is
 *  NOT an open sheet (same trick as AdminSupportDetailView.test.ts). */
function sheet(): HTMLElement | null {
  const el = document.body.querySelector<HTMLElement>('.v-sheet__overlay')
  return el && !el.classList.contains('v-sheet-leave-active') ? el : null
}

function star(n: number): HTMLButtonElement | null {
  return document.body.querySelector<HTMLButtonElement>(`[data-testid="rating-star-${n}"]`)
}

async function pickStars(n: number): Promise<void> {
  star(n)?.click()
  await flush()
}

async function submit(): Promise<void> {
  const btn = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.v-sheet__save')).find(
    (b) => !b.disabled,
  )
  btn?.click()
  await flush()
}

async function later(): Promise<void> {
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('.v-sheet__cancel')).forEach((b) =>
    b.click(),
  )
  await flush()
}

function commentField(): HTMLTextAreaElement | null {
  return document.body.querySelector<HTMLTextAreaElement>('textarea')
}

const OK = { id: 't_1', stars: 5, comment: null, rated_at: '2026-10-27T12:00:00Z' }

beforeEach(() => {
  toastSuccess.mockReset()
  vi.mocked(supportApi.listPendingRatings).mockReset().mockResolvedValue({ tickets: [] })
  vi.mocked(supportApi.rateTicket).mockReset().mockResolvedValue(OK)
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  document.body.querySelectorAll('.v-sheet__overlay').forEach((el) => el.remove())
  vi.restoreAllMocks()
})

describe('what the sheet opens on', () => {
  it('nothing waits -> nothing opens', async () => {
    vi.mocked(supportApi.listPendingRatings).mockResolvedValue({ tickets: [] })
    mount()
    await flush()

    expect(sheet()).toBeNull()
  })

  it('the newest waiting ticket opens when the chat was opened on its own', async () => {
    vi.mocked(supportApi.listPendingRatings).mockResolvedValue({
      tickets: [pending('t_new'), pending('t_old')],
    })
    mount()
    await flush()

    expect(sheet()).not.toBeNull()
    expect(sheet()?.textContent).toContain('Проблема с оплатой')
  })

  it('a deep link names ITS ticket: the sheet opens on it, not the newest', async () => {
    vi.mocked(supportApi.listPendingRatings).mockResolvedValue({
      tickets: [pending('t_new', { topic: 'technical' }), pending('t_deep', { topic: 'practice' })],
    })
    mount('t_deep')
    await flush()

    expect(sheet()?.textContent).toContain('Проблема с практикой')
  })

  it('a deep link to a ticket that no longer waits opens NOTHING', async () => {
    vi.mocked(supportApi.listPendingRatings).mockResolvedValue({ tickets: [pending('t_new')] })
    mount('t_rated_elsewhere')
    await flush()

    expect(sheet()).toBeNull()
  })

  it('inactive (a plain DM thread) -> the list is not even read', async () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(SupportRatingSheet, { active: false, preferredTicketId: null })
    app.use(createTestI18n())
    app.mount(host)
    await flush()

    expect(supportApi.listPendingRatings).not.toHaveBeenCalled()
  })
})

describe('a submit', () => {
  it('sends the stars and the trimmed comment; a thank-you lands and the sheet closes', async () => {
    vi.mocked(supportApi.listPendingRatings).mockResolvedValue({ tickets: [pending('t_1')] })
    mount()
    await flush()

    await pickStars(4)
    const field = commentField()
    if (!field) throw new Error('no comment field')
    field.value = '  Спасибо  '
    field.dispatchEvent(new Event('input'))
    await flush()
    await submit()

    expect(supportApi.rateTicket).toHaveBeenCalledWith('t_1', 4, '  Спасибо  ')
    expect(toastSuccess).toHaveBeenCalled()
    expect(sheet()).toBeNull()
  })

  it('two waiting tickets: the first submit advances to the second, the second closes', async () => {
    vi.mocked(supportApi.listPendingRatings).mockResolvedValue({
      tickets: [pending('t_1', { topic: 'payment' }), pending('t_2', { topic: 'technical' })],
    })
    mount()
    await flush()

    await pickStars(5)
    await submit()
    expect(supportApi.rateTicket).toHaveBeenCalledWith('t_1', 5, '')
    // The second ticket's topic is now in the sheet.
    expect(sheet()?.textContent).toContain('Технические проблемы')

    await pickStars(3)
    await submit()
    expect(supportApi.rateTicket).toHaveBeenCalledWith('t_2', 3, '')
    expect(sheet()).toBeNull()
  })

  it('a 409 (rated already / reopened) drops the ticket and asks the next', async () => {
    vi.mocked(supportApi.listPendingRatings).mockResolvedValue({
      tickets: [pending('t_1', { topic: 'payment' }), pending('t_2', { topic: 'technical' })],
    })
    vi.mocked(supportApi.rateTicket).mockRejectedValueOnce(
      new ApiResponseError(409, 'conflict', 'conflict'),
    )
    mount()
    await flush()

    await pickStars(4)
    await submit()

    expect(supportApi.rateTicket).toHaveBeenCalledTimes(1)
    expect(sheet()?.textContent).toContain('Технические проблемы')
  })

  it('a 404 (the ticket is gone -- spam past the retention) drops it and asks the next', async () => {
    vi.mocked(supportApi.listPendingRatings).mockResolvedValue({
      tickets: [pending('t_1', { topic: 'payment' }), pending('t_2', { topic: 'technical' })],
    })
    vi.mocked(supportApi.rateTicket).mockRejectedValueOnce(
      new ApiResponseError(404, 'not found', 'not_found'),
    )
    mount()
    await flush()

    await pickStars(5)
    await submit()

    expect(supportApi.rateTicket).toHaveBeenCalledTimes(1)
    expect(sheet()?.textContent).toContain('Технические проблемы')
  })

  it('«Позже» in flight lands nowhere: the sheet stays until the answer arrives', async () => {
    let resolveSend!: (v: typeof OK) => void
    vi.mocked(supportApi.listPendingRatings).mockResolvedValue({ tickets: [pending('t_1')] })
    vi.mocked(supportApi.rateTicket).mockReturnValueOnce(
      new Promise<typeof OK>((resolve) => {
        resolveSend = resolve
      }),
    )
    mount()
    await flush()

    await pickStars(4)
    void submit() // in flight -- no await
    await flush()

    // The scrim, Escape and the button all arrive as close: a dismissal
    // mid-flight must not close the sheet nor end the asking.
    await later()
    expect(sheet()).not.toBeNull()

    resolveSend(OK)
    await flush()
    expect(sheet()).toBeNull()
    expect(toastSuccess).toHaveBeenCalled()
  })
})

describe('«Позже»', () => {
  it('ends the asking for this visit -- the other waiting ticket is not asked', async () => {
    vi.mocked(supportApi.listPendingRatings).mockResolvedValue({
      tickets: [pending('t_1'), pending('t_2')],
    })
    mount()
    await flush()

    await later()

    expect(sheet()).toBeNull()
    // No further submit could happen; nothing else opened on its own.
    expect(supportApi.rateTicket).not.toHaveBeenCalled()
  })
})
