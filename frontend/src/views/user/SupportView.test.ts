// =============================================================================
// VELO Frontend -- SupportView Screen Tests (probekit-screen-test)
// =============================================================================
//
// PATTERN B (local-ref form) -- confirmed by reading every import: no store,
// no fetch ladder. State is local refs (topic / otherText / message /
// submitted / submitting). The FORM -> TERMINAL transition is driven by
// `submitted`, now set only after two real API calls resolve (PROMPT №712,
// owner ruling B): open the caller's support thread, then deliver the topic
// + message as its first message.
//
// External boundaries: vue-router (router.back / router.push),
// useKeyboardFieldScroll, @/api/support (openSupportThread /
// sendSupportMessage), @/composables/useToast (the error path only --
// success never toasts, it flips to the terminal screen instead).
//
// DRIVEN THROUGH THE DOM THROUGHOUT -- click the radio, type into the
// textarea/input, click the button -- never by reaching into topic/otherText/
// message refs directly (the local-form empty-green trap the skill warns
// about: poking refs would assert this file's own fixture, not the screen).
//
// MONEY: none. Cyrillic fixtures/expected strings below were still typed via
// the Write tool, not a shell heredoc, per house habit.
//
// No modal, no v-show (grepped -- v-if throughout), no order dependence --
// every test mounts its own app.
// =============================================================================

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

const openSupportThread = vi.fn()
const sendSupportMessage = vi.fn()
vi.mock('@/api/support', () => ({
  openSupportThread: (...args: unknown[]) => openSupportThread(...args),
  sendSupportMessage: (...args: unknown[]) => sendSupportMessage(...args),
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
  app = createApp(SupportView)
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await nextTick()
}

const TOPIC_LABEL = {
  payment: 'Проблема с оплатой / транзакцией',
  complaint_master: 'Жалоба на мастера',
  practice: 'Проблема с практикой',
  technical: 'Технический вопрос',
  other: 'Другое',
} as const

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
function otherInput(): HTMLInputElement | null {
  return host?.querySelector<HTMLInputElement>('.support__other-input') ?? null
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
  openSupportThread.mockReset().mockResolvedValue({
    id: 'thread-1',
    client: 'user-1',
    operator_kind: 'section',
    operator_value: 'section-1',
    assignee: null,
    kind: 'dm',
    status: 'open',
    subject_type: null,
    subject_id: null,
    title: null,
    priority: null,
    last_message_at: null,
    created_at: '2026-08-14T10:00:00Z',
  })
  sendSupportMessage.mockReset().mockResolvedValue({
    id: 'msg-1',
    thread_id: 'thread-1',
    sender: 'user-1',
    body: 'placeholder',
    created_at: '2026-08-14T10:00:00Z',
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
  describe('canSubmit truth table (.vue:127-131), asserted via the submit button)', () => {
    it('empty message: disabled (default topic is NOT "other")', async () => {
      mount()
      await flush()

      expect(submitBtn().disabled).toBe(true)
    })

    it('message present, topic != "other": ENABLED', async () => {
      mount()
      await flush()

      setValue(messageField(), 'У меня вопрос')
      await flush()

      expect(submitBtn().disabled).toBe(false)
    })

    it('topic == "other" with an EMPTY otherText: disabled even with a message', async () => {
      mount()
      await flush()

      radioByLabel(TOPIC_LABEL.other).click()
      await flush()
      setValue(messageField(), 'У меня вопрос')
      await flush()

      expect(submitBtn().disabled).toBe(true)
    })

    it('topic == "other" with otherText filled + message: ENABLED', async () => {
      mount()
      await flush()

      radioByLabel(TOPIC_LABEL.other).click()
      await flush()
      setValue(otherInput()!, 'Другой вопрос')
      setValue(messageField(), 'У меня вопрос')
      await flush()

      expect(submitBtn().disabled).toBe(false)
    })
  })

  // ===========================================================================
  describe('"other" branch reveal (.vue:52)', () => {
    it('selecting «Другое» renders the otherText input; switching away hides it', async () => {
      mount()
      await flush()

      expect(otherInput()).toBeNull()

      radioByLabel(TOPIC_LABEL.other).click()
      await flush()
      expect(otherInput()).not.toBeNull()

      radioByLabel(TOPIC_LABEL.technical).click()
      await flush()
      expect(otherInput()).toBeNull()
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
      expect(host?.textContent).toContain('Спасибо за обращение')
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
  describe('the wiring (.vue: onSubmit) -- opens the thread, then sends the topic label + message', () => {
    it.each([
      ['payment', 'Проблема с оплатой / транзакцией'],
      ['complaint_master', 'Жалоба на мастера'],
      ['practice', 'Проблема с практикой'],
      ['technical', 'Технический вопрос'],
    ] as const)(
      'topic "%s" opens with its LABEL and sends the same label',
      async (topicValue, label) => {
        mount()
        await flush()

        radioByLabel(TOPIC_LABEL[topicValue]).click()
        await flush()
        setValue(messageField(), 'Текст обращения')
        await flush()
        submitBtn().click()
        await flush()

        expect(openSupportThread).toHaveBeenCalledWith(label)
        expect(sendSupportMessage).toHaveBeenCalledWith(label, 'Текст обращения')
        // Open happens BEFORE send -- the thread must exist first.
        expect(openSupportThread.mock.invocationCallOrder[0]).toBeLessThan(
          sendSupportMessage.mock.invocationCallOrder[0]!,
        )
      },
    )

    it('topic "other": the TRIMMED otherText is sent as the topic label, not the raw value', async () => {
      mount()
      await flush()

      radioByLabel(TOPIC_LABEL.other).click()
      await flush()
      setValue(otherInput()!, '  Свой вариант  ')
      setValue(messageField(), 'Текст обращения')
      await flush()
      submitBtn().click()
      await flush()

      expect(openSupportThread).toHaveBeenCalledWith('Свой вариант')
      expect(sendSupportMessage).toHaveBeenCalledWith('Свой вариант', 'Текст обращения')
    })

    it('message is trimmed before it is sent', async () => {
      mount()
      await flush()

      setValue(messageField(), '  Текст с пробелами  ')
      await flush()
      submitBtn().click()
      await flush()

      expect(sendSupportMessage.mock.calls[0]?.[1]).toBe('Текст с пробелами')
    })

    it('a failed open shows a toast, stays on the form, and never sends a message', async () => {
      openSupportThread.mockReset().mockRejectedValue(new Error('boom'))
      mount()
      await flush()

      setValue(messageField(), 'У меня вопрос')
      await flush()
      submitBtn().click()
      await flush()

      expect(toastError).toHaveBeenCalled()
      expect(sendSupportMessage).not.toHaveBeenCalled()
      expect(isTerminal()).toBe(false)
    })

    it('a failed send shows a toast and stays on the form', async () => {
      sendSupportMessage.mockReset().mockRejectedValue(new Error('boom'))
      mount()
      await flush()

      setValue(messageField(), 'У меня вопрос')
      await flush()
      submitBtn().click()
      await flush()

      expect(toastError).toHaveBeenCalled()
      expect(isTerminal()).toBe(false)
    })

    it('the submit button shows loading while the calls are in flight', async () => {
      let resolveOpen!: (v: unknown) => void
      openSupportThread.mockReset().mockReturnValue(
        new Promise((resolve) => {
          resolveOpen = resolve
        }),
      )
      mount()
      await flush()

      setValue(messageField(), 'У меня вопрос')
      await flush()
      submitBtn().click()
      await flush()

      expect(submitBtn().classList.contains('v-btn--loading')).toBe(true)

      resolveOpen({
        id: 'thread-1',
        client: 'user-1',
        operator_kind: 'section',
        operator_value: 'section-1',
        assignee: null,
        kind: 'dm',
        status: 'open',
        subject_type: null,
        subject_id: null,
        title: null,
        priority: null,
        last_message_at: null,
        created_at: '2026-08-14T10:00:00Z',
      })
      await flush()
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
