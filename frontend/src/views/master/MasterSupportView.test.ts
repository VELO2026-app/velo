// =============================================================================
// VELO Frontend -- MasterSupportView Screen Tests
// =============================================================================
//
// UPDATED PROMPT №712 (owner ruling B): onSubmit no longer stubs -- it opens
// the caller's support thread (@/api/support::openSupportThread) then
// delivers the topic + message as its first/next message
// (::sendSupportMessage). Attachments stay CAPTURED-LOCALLY-ONLY (no
// upload/storage backend exists, out of that prompt's scope too) -- their
// tests below are unchanged, nothing about them sends anywhere.
//
// PATTERN: no store; API mocked at @/api/support (the two functions the SFC
// calls), toast mocked at @/composables/useToast (error path only -- success
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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import MasterSupportView from '@/views/master/MasterSupportView.vue'

const back = vi.fn()
const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ back, push }),
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

let app: App | null = null
let host: HTMLElement | null = null

function mount(): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(MasterSupportView)
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

function otherInput(): HTMLInputElement | null {
  return host?.querySelector<HTMLInputElement>('.support__other-input') ?? null
}

function setOtherInput(value: string): void {
  const i = otherInput()
  if (!i) throw new Error('.support__other-input did not render (topic is not «Другое»)')
  i.value = value
  i.dispatchEvent(new Event('input'))
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
  openSupportThread.mockReset().mockResolvedValue({
    id: 'thread-1',
    client: 'master-1',
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
    sender: 'master-1',
    body: 'placeholder',
    created_at: '2026-08-14T10:00:00Z',
  })
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

    it('switching to «Другое» re-disables until the free-text field is also filled', async () => {
      mount()
      await flush()
      setTextarea('Сообщение')
      await flush()
      expect(submitBtn().disabled).toBe(false)

      radio('Другое')?.click()
      await flush()

      expect(otherInput()).not.toBeNull()
      expect(submitBtn().disabled).toBe(true) // message alone is no longer enough

      setOtherInput('Свой вариант темы')
      await flush()

      expect(submitBtn().disabled).toBe(false)
    })

    it('the «Другое» field is not even rendered for a normal topic', async () => {
      mount()
      await flush()

      expect(otherInput()).toBeNull()
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

  describe('submitting (PROMPT №712: opens the thread, then sends the topic label + message)', () => {
    it('opens with the topic LABEL, sends the same label, and flips to the terminal screen', async () => {
      mount()
      await flush()
      setTextarea('  Проблема с выводом  ')
      await flush()

      submitBtn().click()
      await flush()

      expect(openSupportThread).toHaveBeenCalledWith('Проблема с выводом')
      expect(sendSupportMessage).toHaveBeenCalledWith(
        'Проблема с выводом',
        'Проблема с выводом', // trimmed message text (coincidentally same as this topic's label)
      )
      expect(text()).toContain('Спасибо за обращение')
      // Header hides on the terminal screen -- no back button on a dead end.
      expect(host?.querySelector('[aria-label="Назад"]')).toBeNull()
    })

    it('an «Другое» submission sends the TRIMMED free text as the topic label', async () => {
      mount()
      await flush()
      setTextarea('Сообщение')
      radio('Другое')?.click()
      await flush()
      setOtherInput('  Хочу добавить йога-нидру  ')
      await flush()

      submitBtn().click()
      await flush()

      expect(openSupportThread).toHaveBeenCalledWith('Хочу добавить йога-нидру')
      expect(sendSupportMessage).toHaveBeenCalledWith('Хочу добавить йога-нидру', 'Сообщение')
    })

    it('attachments are captured locally only -- nothing about them reaches either API call', async () => {
      mount()
      await flush()
      setTextarea('Сообщение')
      await flush()
      pickFiles([file('a.png')])
      await flush()

      submitBtn().click()
      await flush()

      expect(openSupportThread).toHaveBeenCalledWith('Проблема с выводом')
      expect(sendSupportMessage).toHaveBeenCalledWith('Проблема с выводом', 'Сообщение')
    })

    it('a failed open shows a toast, stays on the form, and never sends a message', async () => {
      openSupportThread.mockReset().mockRejectedValue(new Error('boom'))
      mount()
      await flush()
      setTextarea('Сообщение')
      await flush()

      submitBtn().click()
      await flush()

      expect(toastError).toHaveBeenCalled()
      expect(sendSupportMessage).not.toHaveBeenCalled()
      expect(text()).not.toContain('Спасибо за обращение')
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
