// =============================================================================
// VELO Frontend -- SupportView Screen Tests (probekit-screen-test)
// =============================================================================
//
// PATTERN B (local-ref form) -- confirmed by reading every import: no store,
// no fetch ladder. State is local refs (topic / message / submitted /
// submitting). The FORM -> TERMINAL transition is driven by `submitted`, set
// only after the ticket call resolves (FE-104, owner ruling BE-162: every
// appeal is a NEW ticket -- the topic as a CODE and the message, one call,
// under the appeal's Idempotency-Key).
//
// External boundaries: vue-router (router.back / router.push),
// useKeyboardFieldScroll, @/api/support (createTicket mocked; createAppealKeys
// is the REAL keeper -- its key source, newIdempotencyKey in @/api/chats, is
// mocked to a counter so "same key" / "new key" are observable),
// @/composables/useToast (the error path only -- success never toasts, it
// flips to the terminal screen instead).
//
// DRIVEN THROUGH THE DOM THROUGHOUT -- click the radio, type into the
// textarea, click the button -- never by reaching into the refs directly (the
// local-form empty-green trap the skill warns about).
//
// MONEY: none. No modal, no v-show (v-if throughout), no order dependence --
// every test mounts its own app.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import SupportView from '@/views/user/SupportView.vue'

const back = vi.fn()
const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ back, push }),
}))

const onFieldFocus = vi.fn()
vi.mock('@/composables/useKeyboardFieldScroll', () => ({
  useKeyboardFieldScroll: () => ({ onFieldFocus }),
}))

const createTicket = vi.fn()
vi.mock('@/api/support', async (importOriginal) => ({
  // The real keeper: what the form promises about keys is the keeper's
  // behaviour seen through the DOM, not this file's stub.
  createAppealKeys: (await importOriginal<typeof import('@/api/support')>()).createAppealKeys,
  createTicket: (...args: Parameters<typeof createTicket>) => createTicket(...args),
}))

// FE-103: after the send the view looks up the support ROW (channel
// 'support') to hand over to the conversation. newIdempotencyKey is the
// keeper's key source -- a counter, so each fresh key is distinguishable.
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

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(SupportView).use(createTestI18n())
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await nextTick()
}

// The labels of the one topic table (supportTopics, ru). `technical` reads
// «Технические проблемы» on both forms since FE-104 (owner ruling).
const TOPIC_LABEL = {
  payment: 'Проблема с оплатой / транзакцией',
  complaint_master: 'Жалоба на мастера',
  practice: 'Проблема с практикой',
  technical: 'Технические проблемы',
  other: 'Другое',
} as const

const CREATED = {
  ticket: {
    id: 'ticket-1',
    topic: 'payment',
    category: 'payments',
    status: 'open',
    created_at: '2026-10-25T10:00:00Z',
    status_changed_at: '2026-10-25T10:00:00Z',
  },
  message: {
    id: 'msg-1',
    thread_id: 'ticket-1',
    sender: 'user-1',
    body: 'placeholder',
    created_at: '2026-10-25T10:00:00Z',
  },
}

function radioByLabel(label: string): HTMLButtonElement {
  const btn = Array.from(host?.querySelectorAll<HTMLButtonElement>('.v-radio') ?? []).find(
    (b) => b.querySelector('.v-radio__label')?.textContent?.trim() === label,
  )
  if (!btn) throw new Error(`no radio labelled «${label}»`)
  return btn
}
function messageField(): HTMLTextAreaElement {
  const el = host?.querySelector<HTMLTextAreaElement>('.v-textarea__field')
  if (!el) throw new Error('message textarea did not render')
  return el
}
function radioLabels(): string[] {
  return Array.from(host?.querySelectorAll('.v-radio__label') ?? []).map(
    (l) => l.textContent?.trim() ?? '',
  )
}
function submitBtn(): HTMLButtonElement {
  const el = host?.querySelector<HTMLButtonElement>('.support__submit')
  if (!el) throw new Error('submit button did not render')
  return el
}
function homeBtn(): HTMLButtonElement | null {
  return host?.querySelector<HTMLButtonElement>('.support__ok-cta') ?? null
}
function isTerminal(): boolean {
  return !!host?.querySelector('.support__done')
}
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value
  el.dispatchEvent(new Event('input'))
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  back.mockReset()
  push.mockReset()
  onFieldFocus.mockReset()
  toastError.mockReset()
  minted = 0
  createTicket.mockReset().mockResolvedValue(CREATED)
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
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.restoreAllMocks()
})

describe('SupportView', () => {
  // ===========================================================================
  describe('canSubmit truth table, asserted via the submit button', () => {
    it('empty message: disabled', async () => {
      mount()
      await flush()

      expect(submitBtn().disabled).toBe(true)
    })

    it('message present: ENABLED', async () => {
      mount()
      await flush()

      setValue(messageField(), 'У меня вопрос')
      await flush()

      expect(submitBtn().disabled).toBe(false)
    })

    it('whitespace-only message: disabled -- trimmed before the check', async () => {
      mount()
      await flush()

      setValue(messageField(), '   ')
      await flush()

      expect(submitBtn().disabled).toBe(true)
    })

    // Was: «Другое» with an EMPTY free-text field stayed disabled. Right while
    // «Другое» carried its own topic text; FE-104 (owner ruling) removed that
    // text -- the substance is the message -- so «Другое» + message is enough.
    it('topic «Другое» + message: ENABLED -- no free text is required', async () => {
      mount()
      await flush()

      radioByLabel(TOPIC_LABEL.other).click()
      await flush()
      setValue(messageField(), 'У меня вопрос')
      await flush()

      expect(submitBtn().disabled).toBe(false)
    })
  })

  // ===========================================================================
  // Was: selecting «Другое» revealed a free-text input. Cancelled by FE-104
  // (owner ruling: «Другое» without free text); the form has one text field.
  describe('the topic list (FE-104)', () => {
    it('offers exactly the five user topics, labelled from the one table', async () => {
      mount()
      await flush()

      expect(radioLabels()).toEqual([
        TOPIC_LABEL.payment,
        TOPIC_LABEL.complaint_master,
        TOPIC_LABEL.practice,
        TOPIC_LABEL.technical,
        TOPIC_LABEL.other,
      ])
    })

    it('selecting «Другое» renders no field of its own -- one textarea, one input set', async () => {
      mount()
      await flush()

      radioByLabel(TOPIC_LABEL.other).click()
      await flush()

      expect(host?.querySelectorAll('textarea')).toHaveLength(1)
      expect(host?.querySelectorAll('input[type="text"]')).toHaveLength(0)
    })

    it('the message field is capped at the contract limit (4000)', async () => {
      mount()
      await flush()

      expect(messageField().getAttribute('maxlength')).toBe('4000')
    })
  })

  // ===========================================================================
  describe('submit -> terminal transition', () => {
    it('a valid submit flips to the terminal screen; the form is gone', async () => {
      mount()
      await flush()

      setValue(messageField(), 'У меня вопрос')
      await flush()
      submitBtn().click()
      await flush()

      expect(isTerminal()).toBe(true)
      // FE-103 (owner wording 25.10): the reply arrives in «Сообщения»...
      expect(host?.textContent).toContain('Обращение отправлено')
      expect(host?.textContent).toContain('Ответ придёт в «Сообщения»')
      expect(host?.querySelector('.support__content')).toBeNull()
      expect(host?.querySelector('.v-header')).toBeNull()
    })

    it('a click while canSubmit is false does nothing (real disabled button, no submit)', async () => {
      mount()
      await flush()

      // Message stays empty -> button is a genuinely disabled <button>; a real
      // browser (and happy-dom) refuses to dispatch click on it.
      submitBtn().click()
      await flush()

      expect(isTerminal()).toBe(false)
    })
  })

  // ===========================================================================
  // Was: the submit opened the eternal thread with the topic LABEL, then sent
  // the label + message (PROMPT №712). Right for that contract; BE-162
  // removed both routes -- one call now carries the topic CODE.
  describe('the wiring (onSubmit) -- one ticket call: the topic CODE + the message', () => {
    it.each([['payment'], ['complaint_master'], ['practice'], ['technical'], ['other']] as const)(
      'topic "%s" is sent as its CODE, never as a label',
      async (code) => {
        mount()
        await flush()

        radioByLabel(TOPIC_LABEL[code]).click()
        await flush()
        setValue(messageField(), 'Текст обращения')
        await flush()
        submitBtn().click()
        await flush()

        expect(createTicket).toHaveBeenCalledTimes(1)
        expect(createTicket).toHaveBeenCalledWith(code, 'Текст обращения', 'key-1')
      },
    )

    it('message is trimmed before it is sent', async () => {
      mount()
      await flush()

      setValue(messageField(), '  Текст с пробелами  ')
      await flush()
      submitBtn().click()
      await flush()

      expect(createTicket.mock.calls[0]?.[1]).toBe('Текст с пробелами')
    })

    // Was: two calls, and a failed OPEN never sent. One call now: a failure
    // of it toasts and leaves the form standing.
    it('a failed ticket call shows a toast and stays on the form', async () => {
      createTicket.mockReset().mockRejectedValue(new Error('boom'))
      mount()
      await flush()

      setValue(messageField(), 'У меня вопрос')
      await flush()
      submitBtn().click()
      await flush()

      expect(toastError).toHaveBeenCalled()
      expect(isTerminal()).toBe(false)
    })

    it('the submit button shows loading while the call is in flight', async () => {
      let resolveCreate!: (v: unknown) => void
      createTicket.mockReset().mockReturnValue(
        new Promise((resolve) => {
          resolveCreate = resolve
        }),
      )
      mount()
      await flush()

      setValue(messageField(), 'У меня вопрос')
      await flush()
      submitBtn().click()
      await flush()

      expect(submitBtn().classList.contains('v-btn--loading')).toBe(true)

      resolveCreate(CREATED)
      await flush()
      expect(isTerminal()).toBe(true)
    })
  })

  // ===========================================================================
  describe('one appeal, one key (FE-104)', () => {
    it('a double tap while the call is in flight sends ONE ticket call', async () => {
      let resolveCreate!: (v: unknown) => void
      createTicket.mockReset().mockReturnValue(
        new Promise((resolve) => {
          resolveCreate = resolve
        }),
      )
      mount()
      await flush()

      setValue(messageField(), 'У меня вопрос')
      await flush()
      submitBtn().click()
      submitBtn().click()
      await flush()

      expect(createTicket).toHaveBeenCalledTimes(1)
      resolveCreate(CREATED)
      await flush()
    })

    it('a retry after a failure, nothing edited, carries the SAME key', async () => {
      createTicket
        .mockReset()
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValue(CREATED)
      mount()
      await flush()

      setValue(messageField(), 'У меня вопрос')
      await flush()
      submitBtn().click()
      await flush()
      submitBtn().click()
      await flush()

      expect(createTicket).toHaveBeenCalledTimes(2)
      const [first, second] = createTicket.mock.calls
      expect(first?.[2]).toBe('key-1')
      expect(second?.[2]).toBe('key-1')
      expect(isTerminal()).toBe(true)
    })

    it('an edit of the message after a failure mints a NEW key', async () => {
      createTicket
        .mockReset()
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValue(CREATED)
      mount()
      await flush()

      setValue(messageField(), 'У меня вопрос')
      await flush()
      submitBtn().click()
      await flush()
      setValue(messageField(), 'У меня другой вопрос')
      await flush()
      submitBtn().click()
      await flush()

      expect(createTicket.mock.calls.map((c) => c[2])).toEqual(['key-1', 'key-2'])
    })

    it('a change of the topic after a failure mints a NEW key', async () => {
      createTicket
        .mockReset()
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValue(CREATED)
      mount()
      await flush()

      setValue(messageField(), 'У меня вопрос')
      await flush()
      submitBtn().click()
      await flush()
      radioByLabel(TOPIC_LABEL.technical).click()
      await flush()
      submitBtn().click()
      await flush()

      expect(createTicket.mock.calls.map((c) => [c[0], c[2]])).toEqual([
        ['payment', 'key-1'],
        ['technical', 'key-2'],
      ])
    })
  })

  // ===========================================================================
  describe('FE-103: the hand-over to the conversation', () => {
    it('after the send, the support ROW from listChats() opens user-chat', async () => {
      mount()
      await flush()

      setValue(messageField(), 'У меня вопрос')
      await flush()
      submitBtn().click()
      for (let i = 0; i < 12; i++) await nextTick()

      expect(push).toHaveBeenCalledWith({ name: 'user-chat', params: { id: 'support-row-1' } })
    })

    it('no support row in the list yet -- the terminal screen stays (honest fallback)', async () => {
      listChats.mockReset().mockResolvedValue({ threads: [], next_cursor: null })
      mount()
      await flush()

      setValue(messageField(), 'У меня вопрос')
      await flush()
      submitBtn().click()
      for (let i = 0; i < 12; i++) await nextTick()

      expect(push).not.toHaveBeenCalled()
      expect(isTerminal()).toBe(true)
    })

    it('a failed listChats lookup is swallowed -- no toast over a delivered message', async () => {
      listChats.mockReset().mockRejectedValue(new Error('down'))
      mount()
      await flush()

      setValue(messageField(), 'У меня вопрос')
      await flush()
      submitBtn().click()
      for (let i = 0; i < 12; i++) await nextTick()

      expect(toastError).not.toHaveBeenCalled()
      expect(isTerminal()).toBe(true)
    })
  })

  // ===========================================================================
  describe('goHome (.vue:152-154)', () => {
    it("«На главную» on the terminal screen pushes { name: 'user-dashboard' }", async () => {
      mount()
      await flush()

      setValue(messageField(), 'У меня вопрос')
      await flush()
      submitBtn().click()
      await flush()

      homeBtn()?.click()
      await flush()

      expect(push).toHaveBeenCalledWith({ name: 'user-dashboard' })
    })
  })
})
