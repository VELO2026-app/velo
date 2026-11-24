// =============================================================================
// VELO Frontend -- ReportUserSheet: leaving with unsaved edits (FE-233)
// =============================================================================
//
// Typed edits make the sheet non-dismissible: Escape (any dismissal) opens
// the discard question instead of closing. A clean sheet closes as before.
// The send flow itself is not under test here.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import ReportUserSheet from '@/components/shared/ReportUserSheet.vue'

vi.mock('@/api/reports')
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}))

let app: App | null = null
let host: HTMLElement | null = null
const closed = vi.fn()

function mountSheet(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(ReportUserSheet, {
    open: true,
    studentId: 's1',
    studentName: 'Anna',
    onClose: () => closed(),
  })
  app.use(createTestI18n())
  app.mount(host)
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick()
}

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
}

function typeComment(text: string): void {
  const field = document.body.querySelector('textarea')!
  field.value = text
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

function buttonWith(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  )
}

beforeEach(() => closed.mockReset())

afterEach(() => {
  app?.unmount()
  host?.remove()
  document.body.innerHTML = ''
  app = null
  host = null
})

describe('ReportUserSheet (unsaved edits)', () => {
  it('closes at once while nothing has been typed or chosen', async () => {
    mountSheet()
    await flush()
    pressEscape()
    await flush()

    expect(closed).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).not.toContain('Сбросить изменения?')
  })

  it('asks before closing once a comment is typed; keeping the edits leaves the sheet open', async () => {
    mountSheet()
    await flush()
    typeComment('details')
    await flush()
    pressEscape()
    await flush()

    expect(closed).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Сбросить изменения?')

    buttonWith('Продолжить')!.click()
    await flush()
    // The dialog parks mid-leave in happy-dom, so only the sheet is asserted.
    expect(closed).not.toHaveBeenCalled()
    expect(document.body.querySelector('textarea')).not.toBeNull()
  })

  it('discarding closes the sheet', async () => {
    mountSheet()
    await flush()
    typeComment('details')
    await flush()
    pressEscape()
    await flush()
    buttonWith('Сбросить')!.click()
    await flush()

    expect(closed).toHaveBeenCalledTimes(1)
  })
})
