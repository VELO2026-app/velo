// =============================================================================
// VELO Frontend -- MasterSupportView Screen Tests
// =============================================================================
//
// WHY THIS FILE EXISTS, AND WHY IT ALMOST DIDN'T (probekit-screen-test audit,
// rank 8): the audit's own mechanical grep found 449 lines and 1 computed()
// but ZERO store/API imports, called that "unusual", and explicitly deferred
// ranking it until someone read the file -- "may submit via a different seam
// the mechanical grep missed."
//
// READ IN FULL before deciding. VERDICT: the grep's blind spot was a false
// alarm, not a real seam -- there genuinely is no backend call anywhere in
// this file. The SFC's own banner (.vue:8-13) says so outright: "There is NO
// support backend yet... this is a stub of the designed flow." onSubmit()
// (.vue:197-212) does exactly two things: builds a payload object and
// `console.info`s it, then flips `submitted.value = true`. No fetch, no
// @/api/* import (checked: only @/components/*, @/composables/
// useKeyboardFieldScroll, and vue-router), no non-@/api import that reaches a
// network boundary. The `support@velo.app` mailto: link is the one real
// channel, and it needs no test (a browser-native href, nothing to assert).
//
// So: NOT an inert stub (there IS real branching -- see below), NOT reachable
// through a missed seam (there is no seam) -- it sits in a third category the
// audit's five-signal rubric does not have a bucket for: real CLIENT-ONLY form
// logic with no backend behind it yet. Tested as exactly that: the submit
// gate (topic + message, with the «Другое» free-text sub-requirement), the
// attachment cap/dedup/remove logic, the submitted-state transition, and the
// stub payload SHAPE (so the day a real POST replaces the console.info, this
// file already pins the contract it should send).
//
// PATTERN: no store, no API mock -- nothing to seam. vue-router mocked for
// `back`/`push` only (no RouterView, no transitive @/router import: checked,
// this SFC's only vue-router use is `useRouter()`).
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

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import MasterSupportView from '@/views/master/MasterSupportView.vue'

const back = vi.fn()
const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ back, push }),
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

  describe('submitting (stub flow В -- no backend, honest about it)', () => {
    it('logs the future-ready ticket shape and flips to the terminal screen', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      mount()
      await flush()
      setTextarea('  Проблема с выводом  ')
      await flush()

      submitBtn().click()
      await flush()

      expect(info).toHaveBeenCalledWith('[support] stub — no backend yet; future ticket payload:', {
        topic: 'withdrawal',
        priority: 'P0',
        custom_topic: null,
        message: 'Проблема с выводом', // trimmed
      })
      expect(text()).toContain('Спасибо за обращение')
      // Header hides on the terminal screen -- no back button on a dead end.
      expect(host?.querySelector('[aria-label="Назад"]')).toBeNull()
    })

    it('an «Другое» submission carries the free text as custom_topic, priority from the catalog', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      mount()
      await flush()
      setTextarea('Сообщение')
      radio('Другое')?.click()
      await flush()
      setOtherInput('  Хочу добавить йога-нидру  ')
      await flush()

      submitBtn().click()
      await flush()

      expect(info).toHaveBeenCalledWith('[support] stub — no backend yet; future ticket payload:', {
        topic: 'other',
        priority: 'P2',
        custom_topic: 'Хочу добавить йога-нидру', // trimmed
        message: 'Сообщение',
      })
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
