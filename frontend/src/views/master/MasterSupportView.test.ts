// =============================================================================
// VELO Frontend -- MasterSupportView Screen Tests
// =============================================================================
//
// UPDATED FE-104 (owner ruling BE-162): onSubmit creates a NEW ticket -- the
// topic as a CODE and the message, one call (@/api/support::createTicket)
// under the appeal's Idempotency-Key (::createAppealKeys). «Другое» has no
// free text; the master form gains «Жалоба на пользователя»
// (`complaint_user`). Attachments stay CAPTURED-LOCALLY-ONLY (no
// upload/storage backend exists) -- their tests below are unchanged, nothing
// about them sends anywhere.
//
// PATTERN: no store; createTicket mocked, createAppealKeys REAL (its key
// source, newIdempotencyKey in @/api/chats, is a counter), toast mocked at @/composables/useToast (error path only -- success
// never toasts, it flips to the terminal screen). vue-router mocked for
// `back`/`push` only.
//
// TRAPS PRESENT:
//  - File input `.files` is read-only on a real HTMLInputElement; set via
//    Object.defineProperty (the standard test-only workaround), then a real
//    `change` event dispatch drives the real onFilesPicked handler -- no
//    product code touched.
//
// TRAPS ABSENT:
//  - NO VModal/VBottomSheet, no wall clock, no money, no list pagination.
//  - NO floating-header teleport target in this standalone mount: VHeader's
//    Teleport is `:disabled="!floating"| and useFloatingHeader() returns
//    false with no MobileLayout ancestor (useFloatingHeader.ts:29-31) -- so
//    the header renders INLINE under `host`, not on document.body. Verified
//    by reading the injection key's default before relying on host queries
//    for the back button.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import MasterSupportView from '@/views/master/MasterSupportView.vue'

const back = vi.fn()
const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ back, push }),
}))

const createTicket = vi.fn()
vi.mock('@/api/support', async (importOriginal) => ({
  createAppealKeys: (await importOriginal<typeof import('@/api/support')>()).createAppealKeys,
  createTicket: (...args: Parameters<typeof createTicket>) => createTicket(...args),
}))

// FE-103: after the send the view looks up the support ROW (channel
// 'support') to hand over to the conversation.
const listChats = vi.fn()
let minted = 0
vi.mock('@/api/chats', () => ({
  listChats: (...args: Parameters<typeof listChats>) => listChats(...args),
  newIdempotencyKey: () => `key-${++minted}`,
}))

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), info: vi.fn() }),
}))

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(MasterSupportView).use(createTestI18n())
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}

function submitBtn(): HTMLButtonElement {
  const b = host?.querySelector<HTMLButtonElement>('.support__submit')
  if (!b) throw new Error('.support__submit did not render')
  return b
}

function textarea(): HTMLTextAreaElement {
  const t = host?.querySelector<HTMLTextAreaElement>('.v-textarea__field')
  if (!t) throw new Error('textarea did not render')
  return t
}

function setTextarea(value: string): void {
  const t = textarea()
  t.value = value
  t.dispatchEvent(new Event('input'))
}

function radio(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? []).find(
    (b) => b.querySelector('.v-radio__label')?.textContent?.trim() === label,
  )
}

function radioLabels(): string[] {
  return Array.from(host?.querySelectorAll('.v-radio__label') ?? []).map(
    (l) => l.textContent?.trim() ?? '',
  )
}

const CREATED = {
  ticket: {
    id: 'ticket-1',
    topic: 'withdrawal',
    category: 'payments',
    status: 'open',
    created_at: '2026-10-25T10:00:00Z',
    status_changed_at: '2026-10-25T10:00:00Z',
  },
  message: {
    id: 'msg-1',
    thread_id: 'ticket-1',
    sender: 'master-1',
    body: 'placeholder',
    created_at: '2026-10-25T10:00:00Z',
  },
}

function thumbs(): HTMLButtonElement[] {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('.support__thumb') ?? [])
}

function file(name: string): File {
  return new File(['x'], name, { type: 'text/plain' })
}

/** `.files` is read-only on a real input -- defineProperty is the standard
 *  test-only workaround (no product code touched). */
function pickFiles(files: File[]): void {
  const input = host?.querySelector<HTMLInputElement>('.support__file-input')
  if (!input) throw new Error('.support__file-input did not render')
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  input.dispatchEvent(new Event('change'))
}

function fileInputValue(): string {
  return host?.querySelector<HTMLInputElement>('.support__file-input')?.value ?? 'MISSING'
}

beforeEach(() => {
  listChats.mockReset().mockResolvedValue({
    threads: [
      {
        id: 'support-row-1',
        channel: 'support',
        created_at: '2026-08-14T10:00:00Z',
        last_message: null,
        peer: null,
      },
    ],
    next_cursor: null,
  })
  minted = 0
  createTicket.mockReset().mockResolvedValue(CREATED)
  toastError.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('MasterSupportView', () => {
  describe('the submit gate (canSubmit)', () => {
    it('starts disabled -- default topic, empty message', async () => {
      mount()
      await flush()

      expect(submitBtn().disabled).toBe(true)
    })

    it('a non-empty message with the default topic arms the submit', async () => {
      mount()
      await flush()

      setTextarea('У меня проблема с выводом средств')
      await flush()

      expect(submitBtn().disabled).toBe(false)
    })

    it('whitespace-only message does NOT arm it -- trimmed before the check', async () => {
      mount()
      await flush()

      setTextarea('   \n  ')
      await flush()

      expect(submitBtn().disabled).toBe(true)
    })

    // Was: switching to «Другое» re-disabled until a free-text topic was
    // filled. Right while «Другое» carried its own text; FE-104 (owner
    // ruling) removed it -- the substance is the message.
    it('switching to «Другое» keeps it armed -- the message alone is enough', async () => {
      mount()
      await flush()
      setTextarea('Сообщение')
      await flush()

      radio('Другое')?.click()
      await flush()

      expect(submitBtn().disabled).toBe(false)
    })

    // Was: the «Другое» free-text field was absent for a normal topic. Now it
    // is absent for EVERY topic, «Другое» included -- one text field.
    it('no topic renders a field of its own -- «Другое» included', async () => {
      mount()
      await flush()
      radio('Другое')?.click()
      await flush()

      expect(host?.querySelectorAll('textarea')).toHaveLength(1)
      expect(host?.querySelector('.support__other-input')).toBeNull()
    })
  })

  describe('the topic list (FE-104)', () => {
    it('offers the six master topics, «Жалоба на пользователя» included', async () => {
      mount()
      await flush()

      expect(radioLabels()).toEqual([
        'Проблема с выводом',
        'Вопрос по практикам',
        'Технические проблемы',
        'Добавить направление практики',
        'Жалоба на пользователя',
        'Другое',
      ])
    })

    it('the message field is capped at the contract limit (4000)', async () => {
      mount()
      await flush()

      expect(textarea().getAttribute('maxlength')).toBe('4000')
    })
  })

  describe('attachments', () => {
    it('adds picked files as thumbnails', async () => {
      mount()
      await flush()

      pickFiles([file('a.png'), file('b.png')])
      await flush()

      expect(thumbs()).toHaveLength(2)
      expect(thumbs().map((t) => t.title)).toEqual(['a.png', 'b.png'])
    })

    it('caps at 5 -- a 6th file is silently dropped', async () => {
      mount()
      await flush()

      pickFiles([file('1'), file('2'), file('3'), file('4'), file('5'), file('6')])
      await flush()

      expect(thumbs()).toHaveLength(5)
      expect(thumbs().map((t) => t.title)).toEqual(['1', '2', '3', '4', '5'])
    })

    it('a second pick APPENDS to the existing set, capped at 5 total (not replaced)', async () => {
      mount()
      await flush()
      pickFiles([file('1'), file('2'), file('3')])
      await flush()
      expect(thumbs()).toHaveLength(3)

      pickFiles([file('4'), file('5'), file('6')])
      await flush()

      // 3 existing + 3 new = 6, sliced to the first 5 -> the 6th ('6') is
      // dropped, not the oldest.
      expect(thumbs().map((t) => t.title)).toEqual(['1', '2', '3', '4', '5'])
    })

    it('removes exactly the tapped attachment by index, keeping the others', async () => {
      mount()
      await flush()
      pickFiles([file('a'), file('b'), file('c')])
      await flush()

      thumbs()[1]?.click() // remove 'b'
      await flush()

      expect(thumbs().map((t) => t.title)).toEqual(['a', 'c'])
    })

    it('resets the file input value after processing, so re-picking the SAME file re-fires change', async () => {
      mount()
      await flush()

      pickFiles([file('a')])
      await flush()

      expect(fileInputValue()).toBe('')
    })
  })

  // Was: open the thread with the topic LABEL, then send label + message
  // (PROMPT №712). Right for that contract; BE-162 removed both routes.
  describe('submitting (FE-104: one ticket call -- the topic CODE + the message)', () => {
    it('sends the default topic as its CODE with the trimmed message, and flips to the terminal screen', async () => {
      mount()
      await flush()
      setTextarea('  Проблема с выводом  ')
      await flush()

      submitBtn().click()
      await flush()

      expect(createTicket).toHaveBeenCalledTimes(1)
      expect(createTicket).toHaveBeenCalledWith('withdrawal', 'Проблема с выводом', 'key-1')
      expect(text()).toContain('Обращение отправлено')
      // Header hides on the terminal screen -- no back button on a dead end.
      expect(host?.querySelector('[aria-label="Назад"]')).toBeNull()
    })

    it.each([
      ['Вопрос по практикам', 'practices'],
      ['Технические проблемы', 'technical'],
      ['Добавить направление практики', 'add_direction'],
      ['Жалоба на пользователя', 'complaint_user'],
      ['Другое', 'other'],
    ] as const)('«%s» is sent as the code "%s"', async (label, code) => {
      mount()
      await flush()
      radio(label)?.click()
      await flush()
      setTextarea('Сообщение')
      await flush()

      submitBtn().click()
      await flush()

      expect(createTicket).toHaveBeenCalledWith(code, 'Сообщение', 'key-1')
    })

    it('attachments are captured locally only -- nothing about them reaches the API call', async () => {
      mount()
      await flush()
      setTextarea('Сообщение')
      await flush()
      pickFiles([file('a.png')])
      await flush()

      submitBtn().click()
      await flush()

      expect(createTicket).toHaveBeenCalledTimes(1)
      expect(createTicket).toHaveBeenCalledWith('withdrawal', 'Сообщение', 'key-1')
    })

    // Was: a failed OPEN never sent the message. One call now.
    it('a failed ticket call shows a toast and stays on the form', async () => {
      createTicket.mockReset().mockRejectedValue(new Error('boom'))
      mount()
      await flush()
      setTextarea('Сообщение')
      await flush()

      submitBtn().click()
      await flush()

      expect(toastError).toHaveBeenCalled()
      expect(text()).not.toContain('Обращение отправлено')
    })

    it('a retry after a failure, nothing edited, carries the SAME key; an edit mints a new one', async () => {
      createTicket
        .mockReset()
        .mockRejectedValueOnce(new Error('network'))
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValue(CREATED)
      mount()
      await flush()
      setTextarea('Сообщение')
      await flush()

      submitBtn().click()
      await flush()
      submitBtn().click()
      await flush()
      setTextarea('Сообщение, исправленное')
      await flush()
      submitBtn().click()
      await flush()

      expect(createTicket.mock.calls.map((c) => c[2])).toEqual(['key-1', 'key-1', 'key-2'])
    })

    it('«На главную» from the terminal screen routes to the master dashboard', async () => {
      mount()
      await flush()
      setTextarea('Сообщение')
      await flush()
      submitBtn().click()
      await flush()

      const cta = Array.from(host?.querySelectorAll('button') ?? []).find(
        (b) => b.textContent?.trim() === 'На главную',
      )
      cta?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'master-dashboard' })
    })

    it('the back button on the FORM routes back, not to the dashboard', async () => {
      mount()
      await flush()

      host?.querySelector<HTMLButtonElement>('[aria-label="Назад"]')?.click()
      await flush()

      expect(back).toHaveBeenCalledTimes(1)
      expect(push).not.toHaveBeenCalled()
    })
  })
})

// =============================================================================
// NOT COVERED, deliberately
// =============================================================================
// - Attachment upload/storage: does not exist yet (no storage backend per the
//   SFC's own banner) -- nothing to test beyond the local capture already
//   covered above.
// - mailto:support@velo.app: a plain href, not product logic.
// =============================================================================
