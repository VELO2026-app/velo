// =============================================================================
// VELO UI -- VMenu inside an overlay: Escape closes only the menu (FE-213)
// =============================================================================
//
// VModal and VBottomSheet close on a DOCUMENT keydown Escape, and they attach
// that listener on mount -- before any menu inside them opens. A VMenu open
// inside one of them must take that Escape for itself: one press closes the
// menu and leaves the overlay open. With the menu closed, Escape reaches the
// overlay as before.
//
// Real document dispatch (no platform/dom mock, unlike VMenu.test.ts): the
// point is the order in which the real listeners see the event. The key goes
// to the focused element and bubbles, like a real key press. The overlay's
// visible contract is its `close` emit, so that is what is counted.
// =============================================================================

import { describe, it, expect, afterEach, vi } from 'vitest'
import { createApp, nextTick, h, type App, type Component } from 'vue'
import VMenu from './VMenu.vue'
import VMenuItem from './VMenuItem.vue'
import VModal from '../VModal/VModal.vue'
import VBottomSheet from '../VBottomSheet/VBottomSheet.vue'

let app: App | null = null
let host: HTMLElement | null = null
const closed = vi.fn()

/** Mount `overlay` open, with a one-item VMenu as its content. */
function mountMenuIn(overlay: Component): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({
    render: () =>
      h(
        overlay,
        { open: true, onClose: closed },
        {
          default: () =>
            h(VMenu, { ariaLabel: 'Menu' }, { default: () => h(VMenuItem, { ariaLabel: 'Edit' }) }),
        },
      ),
  })
  app.mount(host)
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await nextTick()
}

function trigger(): HTMLButtonElement {
  return document.body.querySelector<HTMLButtonElement>('button.v-menu__trigger')!
}

function menuPanel(): HTMLElement | null {
  return document.body.querySelector('.v-menu__panel')
}

/** A keydown on the focused element (or body), bubbling like a real press. */
function press(key: string): void {
  const target = document.activeElement ?? document.body
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  closed.mockClear()
})

describe.each([
  ['VModal', VModal],
  ['VBottomSheet', VBottomSheet],
])('VMenu inside %s (FE-213)', (_name, overlay) => {
  it('Escape on an open menu closes the menu only; the next Escape closes the overlay', async () => {
    mountMenuIn(overlay)
    await flush()
    trigger().focus()
    press('ArrowDown')
    await flush()
    expect(menuPanel()).not.toBeNull()

    press('Escape')
    await flush()
    expect(menuPanel()).toBeNull()
    expect(document.activeElement).toBe(trigger())
    expect(closed).not.toHaveBeenCalled()

    press('Escape')
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('a pointer-opened menu (focus not inside it) still takes the Escape', async () => {
    mountMenuIn(overlay)
    await flush()
    trigger().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    await flush()
    expect(menuPanel()).not.toBeNull()
    ;(document.activeElement as HTMLElement | null)?.blur()

    press('Escape')
    await flush()
    expect(menuPanel()).toBeNull()
    expect(closed).not.toHaveBeenCalled()
  })
})
