// =============================================================================
// VELO Frontend -- VFieldError Contract Tests (owner TZ 2026-11-01)
// =============================================================================
//
// The component replaces BOTH the constant-height error slots
// (`min-height: 17px; opacity: 0`) of the form screens AND the v-if error
// lines inside VInput / VTextarea / VSelect. The contract that makes both
// migrations safe:
//
//   - no message  -> the row renders COLLAPSED (no `--open`): zero reserved
//     space, which is exactly what the old reserves existed to prevent;
//   - a message   -> the row opens, the text is in the DOM;
//   - clearing the message -> the `--open` class drops but the text STAYS in
//     the DOM (the collapse animation needs content to animate over); the
//     closed row is aria-hidden, so the stale text never reaches assistive
//     tech and the caller's aria-describedby binding is gone anyway.
//
// Dependency-free SFC mount (createApp + happy-dom), per velo-idiom §1.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import { createApp, nextTick, ref, h, type App, type Ref } from 'vue'
import VFieldError from './VFieldError.vue'

let app: App | null = null
let host: HTMLElement | null = null

/** Parent harness holding a live message ref, i.e. a form driving the row. */
function mountWith(message: Ref<string | null>, props: Record<string, unknown> = {}): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({
    render: () => h(VFieldError, { ...props, message: message.value }),
  })
  app.mount(host)
}

function root(): HTMLElement | null {
  return host?.querySelector('.v-field-error') ?? null
}

function text(): string {
  return host?.querySelector('.v-field-error__text')?.textContent ?? ''
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('VFieldError', () => {
  it('no message: collapsed (no --open), no text, hidden from AT', () => {
    mountWith(ref(''))

    expect(root()?.classList.contains('v-field-error--open')).toBe(false)
    expect(text()).toBe('')
    expect(root()?.getAttribute('aria-hidden')).toBe('true')
  })

  it('null message mounts collapsed the same as empty string', () => {
    mountWith(ref(null))

    expect(root()?.classList.contains('v-field-error--open')).toBe(false)
  })

  it('a message: --open, the text rendered, visible to AT, id on the text node', () => {
    mountWith(ref('Введите название'), { id: 'err-name' })

    expect(root()?.classList.contains('v-field-error--open')).toBe(true)
    expect(text()).toBe('Введите название')
    expect(root()?.getAttribute('aria-hidden')).toBeNull()
    expect(host?.querySelector('.v-field-error__text')?.getAttribute('id')).toBe('err-name')
  })

  it('clearing the message: --open removed, the text STAYS in the DOM (collapse animation), row aria-hidden', async () => {
    const message = ref<string | null>('Ошибка')
    mountWith(message)

    message.value = null
    await nextTick()

    expect(root()?.classList.contains('v-field-error--open')).toBe(false)
    expect(text()).toBe('Ошибка')
    expect(root()?.getAttribute('aria-hidden')).toBe('true')
  })

  it('a new message replaces the held one', async () => {
    const message = ref<string | null>('Ошибка')
    mountWith(message)

    message.value = 'Другая ошибка'
    await nextTick()

    expect(text()).toBe('Другая ошибка')
  })

  it('size="lg" carries the lg modifier (MasterApplyView fs-16 line)', () => {
    mountWith(ref('Ошибка'), { size: 'lg' })

    expect(root()?.classList.contains('v-field-error--lg')).toBe(true)
  })
})
