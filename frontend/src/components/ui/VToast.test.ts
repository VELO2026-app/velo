// =============================================================================
// VELO Frontend -- VToast Component Tests (PROMPT №500)
// =============================================================================
//
// VToast is mounted exactly once (App.vue) and is the ONLY rendering surface
// for every toast.error()/success()/info() call in the app (88 error call
// sites alone). No test file references VToast before this one -- what it
// actually renders for the error variant (the surface a tester stares at)
// had never been asserted.
//
// Dependency-free SFC mount (createApp + happy-dom), per velo-idiom §1, same
// pattern as VEmptyState.test.ts. Drives the REAL useToast() singleton (not
// mocked) so VToast reacts to real state pushes.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import VToast from '@/components/ui/VToast.vue'
import { useToast } from '@/composables/useToast'

let app: App | null = null
let host: HTMLElement | null = null

async function render(): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(VToast)
  app.mount(host)
  await nextTick()
  return document.body
}

function toastEls(): Element[] {
  return Array.from(document.querySelectorAll('.v-toast'))
}

afterEach(() => {
  const { toasts, dismiss } = useToast()
  for (const t of [...toasts.value]) dismiss(t.id)
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('VToast', () => {
  it('renders nothing when there are no active toasts', async () => {
    await render()
    expect(toastEls().length).toBe(0)
  })

  it('renders an error toast with the error variant class and the message text', async () => {
    const toast = useToast()
    toast.error('Недостаточно средств · код 238d15')
    await render()

    const els = toastEls()
    expect(els.length).toBe(1)
    expect(els[0]!.classList.contains('v-toast--error')).toBe(true)
    expect(els[0]!.querySelector('.v-toast__message')?.textContent).toBe(
      'Недостаточно средств · код 238d15',
    )
  })

  it('renders the success and info variants with their own classes', async () => {
    const toast = useToast()
    toast.success('Сохранено')
    toast.info('Обновлено')
    await render()

    const els = toastEls()
    expect(els.length).toBe(2)
    expect(els[0]!.classList.contains('v-toast--success')).toBe(true)
    expect(els[1]!.classList.contains('v-toast--info')).toBe(true)
  })

  it('renders multiple active toasts at once, in push order', async () => {
    const toast = useToast()
    toast.error('first')
    toast.error('second')
    toast.error('third')
    await render()

    const messages = toastEls().map((el) => el.querySelector('.v-toast__message')?.textContent)
    expect(messages).toEqual(['first', 'second', 'third'])
  })

  it('clicking a toast dismisses it (and only it)', async () => {
    // Asserts on the reactive source of truth (toast.toasts.value), not on
    // DOM element count: the clicked element is wrapped by TransitionGroup
    // (VToast.vue:13) and stays in the DOM mid CSS leave-transition until a
    // real `transitionend` fires, which happy-dom does not simulate. That is
    // a rendering/animation detail, not the click -> dismiss behavior this
    // test exists to prove -- verified directly (see commit report) that the
    // lingering DOM node carries `v-toast-leave-active` while the state has
    // already dropped to one entry.
    const toast = useToast()
    toast.error('click-me')
    toast.error('stays')
    await render()

    const els = toastEls()
    expect(els.length).toBe(2)
    ;(els[0] as HTMLElement).click()
    await nextTick()

    expect(toast.toasts.value.map((t) => t.message)).toEqual(['stays'])
  })
})
