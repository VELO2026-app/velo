// =============================================================================
// VELO Frontend -- VToast Component Tests (PROMPT №500; FE-141 inject state)
// =============================================================================
//
// VToast is mounted exactly once (App.vue) and is the ONLY rendering surface
// for every toast.error()/success()/info() call in the app (88 error call
// sites alone). No test file references VToast before this one -- what it
// actually renders for the error variant (the surface a tester stares at)
// had never been asserted.
//
// FE-141: toasts now reach VToast through provide/inject, not the module
// singleton. VToast has no props/emits, so every mount is wrapped in a host
// component that calls provideToast() exactly like App.vue does, and the
// tests drive that provided instance. Its state is fresh per mount and
// fully isolated from the singleton fallback, so rendering anything at all
// proves VToast reads the injection.
//
// Dependency-free SFC mount (createApp + happy-dom), per velo-idiom §1, same
// pattern as VEmptyState.test.ts. Drives the REAL composable state (not
// mocked) so VToast reacts to real state pushes.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import VToast from './VToast.vue'
import { provideToast, type ToastApi } from '../../toast'

let app: App | null = null
let host: HTMLElement | null = null
let provided: ToastApi | null = null

/**
 * Mount wrapper: the FE-141 host shape. VToast reads toasts via inject, so
 * the provider must sit above it -- provideToast() in a parent setup, the
 * same call App.vue makes. The provided instance is captured for the tests
 * to push through (the only path VToast listens to).
 */
const ToastHost = defineComponent({
  setup() {
    provided = provideToast()
    return () => h(VToast)
  },
})

async function render(): Promise<ToastApi> {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(ToastHost)
  app.mount(host)
  await nextTick()
  return provided!
}

function toastEls(): Element[] {
  return Array.from(document.querySelectorAll('.v-toast'))
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  provided = null
})

describe('VToast', () => {
  it('renders nothing when there are no active toasts', async () => {
    await render()
    expect(toastEls().length).toBe(0)
  })

  it('renders an error toast with the error variant class and the message text', async () => {
    const toast = await render()
    toast.error('Недостаточно средств · код 238d15')
    await nextTick()

    const els = toastEls()
    expect(els.length).toBe(1)
    expect(els[0]!.classList.contains('v-toast--error')).toBe(true)
    expect(els[0]!.querySelector('.v-toast__message')?.textContent).toBe(
      'Недостаточно средств · код 238d15',
    )
  })

  it('renders the success and info variants with their own classes', async () => {
    const toast = await render()
    toast.success('Сохранено')
    toast.info('Обновлено')
    await nextTick()

    const els = toastEls()
    expect(els.length).toBe(2)
    expect(els[0]!.classList.contains('v-toast--success')).toBe(true)
    expect(els[1]!.classList.contains('v-toast--info')).toBe(true)
  })

  it('renders multiple active toasts at once, in push order', async () => {
    const toast = await render()
    toast.error('first')
    toast.error('second')
    toast.error('third')
    await nextTick()

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
    const toast = await render()
    toast.error('click-me')
    toast.error('stays')
    await nextTick()

    const els = toastEls()
    expect(els.length).toBe(2)
    ;(els[0] as HTMLElement).click()
    await nextTick()

    expect(toast.toasts.value.map((t) => t.message)).toEqual(['stays'])
  })
})
