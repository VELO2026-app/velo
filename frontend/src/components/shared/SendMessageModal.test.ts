// =============================================================================
// VELO Frontend -- SendMessageModal Tests
// =============================================================================
//
// The master's «Написать сообщение» sheet. REAL since the T3 chat backend:
// «Отправить» open-or-gets the eternal DM with the student and posts the text
// (BookingConfirmedView.onSendRequest's open-then-send split, moved into a
// sheet). Seam: @/api/chats, mocked whole -- BOTH calls asserted.
//
// What is under test, and why:
//   1. SEND -- openStudentChat targets the SHEET's student, the posted body is
//      the trimmed draft, success toasts and asks the parent to close.
//   2. FAILURE -- a failed open toasts the error and keeps the sheet standing
//      with the draft (nothing typed is lost; the retry is safe, the thread
//      dedups on the pair). No success toast, no close.
//   3. PENDING -- one send at a time: while the first send is unresolved, a
//      second tap adds no API call.
//   4. EMPTY -- «Отправить» with a blank field is a no-op, not an empty DM.
//
// SC-07: VModal teleports to body, so every query goes to document.body, never
// to the mount host. SC-13b: a closed VModal parks at v-modal-leave-active in
// happy-dom -- the close is asserted on the emitted event, not on DOM removal.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import SendMessageModal from '@/components/shared/SendMessageModal.vue'
import * as chatsApi from '@/api/chats'
import type { ChatThread } from '@/api/chats'

vi.mock('@/api/chats')

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    success: toastSuccess,
    error: toastError,
    info: vi.fn(),
    dismiss: vi.fn(),
  }),
}))

// -- fixtures ---------------------------------------------------------------

const STUDENT_ID = 'student-7'
const THREAD_ID = 'thread-7'

function thread(): ChatThread {
  return { id: THREAD_ID, created_at: '2026-08-07T09:00:00+00:00' }
}

// -- mount ------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null
const closed = vi.fn()

/** The LIVE overlay -- excludes a corpse parked by an earlier close (SC-13c). */
function liveModal(): HTMLElement | null {
  return document.body.querySelector('.v-modal__overlay:not(.v-modal-leave-active)')
}

function buttonWith(label: string): HTMLElement | undefined {
  return Array.from(liveModal()?.querySelectorAll<HTMLElement>('button') ?? []).find((b) =>
    b.textContent?.includes(label),
  )
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await nextTick()
}

async function typeDraft(body: string): Promise<void> {
  const field = liveModal()?.querySelector<HTMLTextAreaElement>('textarea')
  if (!field) throw new Error('textarea not rendered')
  field.value = body
  field.dispatchEvent(new Event('input'))
  await flush()
}

beforeEach(() => {
  vi.mocked(chatsApi.openStudentChat).mockReset().mockResolvedValue(thread())
  vi.mocked(chatsApi.sendChatMessage).mockReset().mockResolvedValue({
    id: 'm-1',
    thread_id: THREAD_ID,
    sender: STUDENT_ID,
    body: '',
    created_at: '2026-08-07T09:00:01+00:00',
  })
  toastSuccess.mockReset()
  toastError.mockReset()
  closed.mockReset()

  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(SendMessageModal, {
    open: true,
    studentId: STUDENT_ID,
    name: 'Анна Кузнецова',
    onClose: closed,
  })
  app.mount(host)
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  document.body.querySelectorAll('.v-modal__overlay').forEach((n) => n.remove())
})

// -- tests -------------------------------------------------------------------

describe('SendMessageModal', () => {
  it('renders the recipient chip with the named student', async () => {
    await flush()

    expect(liveModal()?.querySelector('.send-msg__name')?.textContent).toBe('Анна Кузнецова')
  })

  it("sends: opens THIS student's thread, posts the trimmed draft, toasts and asks to close", async () => {
    await flush()
    await typeDraft('  Проверьте, пожалуйста, домашку  ')

    buttonWith('Отправить')?.click()
    await flush()

    expect(chatsApi.openStudentChat).toHaveBeenCalledTimes(1)
    expect(chatsApi.openStudentChat).toHaveBeenCalledWith(STUDENT_ID)
    expect(chatsApi.sendChatMessage).toHaveBeenCalledWith(
      THREAD_ID,
      'Проверьте, пожалуйста, домашку',
    )
    expect(toastSuccess).toHaveBeenCalledWith('Сообщение отправлено')
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('failure: toasts the error, keeps the sheet open with the draft, no success', async () => {
    vi.mocked(chatsApi.openStudentChat).mockRejectedValueOnce(new Error('comms down'))
    await flush()
    await typeDraft('Привет')

    buttonWith('Отправить')?.click()
    await flush()

    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(closed).not.toHaveBeenCalled()
    // The draft survives for the retry (the thread dedups, so it is safe).
    expect(liveModal()?.querySelector('textarea')?.value).toBe('Привет')
    expect(chatsApi.sendChatMessage).not.toHaveBeenCalled()
  })

  it('one send at a time: a second tap while the first is unresolved adds no API call', async () => {
    let resolveOpen: (t: ChatThread) => void = () => {}
    vi.mocked(chatsApi.openStudentChat).mockReturnValue(
      new Promise<ChatThread>((res) => {
        resolveOpen = res
      }),
    )
    await flush()
    await typeDraft('Привет')

    buttonWith('Отправить')?.click()
    await flush()
    // The button is :loading now (native disabled), and onSend's own guard is
    // the logic-level twin -- either way, one tap pair must mean ONE send.
    buttonWith('Отправить')?.click()
    await flush()

    expect(chatsApi.openStudentChat).toHaveBeenCalledTimes(1)

    resolveOpen(thread())
    await flush()
    expect(chatsApi.sendChatMessage).toHaveBeenCalledTimes(1)
  })

  it('an empty draft sends nothing -- no thread, no message, no toast', async () => {
    await flush()

    buttonWith('Отправить')?.click()
    await flush()

    expect(chatsApi.openStudentChat).not.toHaveBeenCalled()
    expect(chatsApi.sendChatMessage).not.toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(closed).not.toHaveBeenCalled()
  })
})
