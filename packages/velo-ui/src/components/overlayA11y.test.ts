// =============================================================================
// @velo/ui -- overlay accessibility: focus, inert page, backdrop press (FE-233)
// =============================================================================
//
// Runs the REAL VModal / VBottomSheet (VConfirmDialog rides VModal) against
// src/overlayA11y.ts. happy-dom proves the attributes and focus moves, not
// how a browser renders or how iOS behaves -- that stays a device check.
// =============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App, type Component, type Ref } from 'vue'
import VModal from './VModal/VModal.vue'
import VBottomSheet from './VBottomSheet/VBottomSheet.vue'

let apps: App[] = []

interface Mounted {
  open: Ref<boolean>
  onClose: ReturnType<typeof vi.fn>
}

function mountOverlay(component: Component, open: boolean): Mounted {
  const isOpen = ref(open)
  const onClose = vi.fn()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({
    render: () =>
      h(
        component,
        { open: isOpen.value, onClose },
        { default: () => h('p', { class: 'inside' }, 'inside') },
      ),
  })
  app.mount(host)
  apps.push(app)
  return { open: isOpen, onClose }
}

/** A page element standing in for the app root, plus a toast-like live region. */
function mountPage(): { page: HTMLElement; opener: HTMLButtonElement; live: HTMLElement } {
  const page = document.createElement('div')
  const opener = document.createElement('button')
  page.appendChild(opener)
  const live = document.createElement('div')
  live.setAttribute('role', 'status')
  document.body.append(page, live)
  return { page, opener, live }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await nextTick()
}

function dialog(): HTMLElement {
  return document.body.querySelector<HTMLElement>('[role="dialog"]')!
}

function overlay(): HTMLElement {
  return dialog().parentElement!
}

afterEach(() => {
  vi.restoreAllMocks()
  apps.forEach((a) => a.unmount())
  apps = []
  document.body.innerHTML = ''
})

describe.each([
  ['VModal', VModal],
  ['VBottomSheet', VBottomSheet],
] as const)('%s overlay accessibility', (_name, component) => {
  it('open moves focus into the dialog; close hands it back to the opener', async () => {
    const { opener } = mountPage()
    opener.focus()
    const { open } = mountOverlay(component, false)

    open.value = true
    await flush()
    expect(document.activeElement).toBe(dialog())

    open.value = false
    await flush()
    expect(document.activeElement).toBe(opener)
  })

  it('close leaves focus alone when the caller already moved it elsewhere', async () => {
    const { opener, live } = mountPage()
    // A live region stays focusable under the inert page.
    const elsewhere = document.createElement('input')
    live.appendChild(elsewhere)
    opener.focus()
    const { open } = mountOverlay(component, false)
    open.value = true
    await flush()

    elsewhere.focus()
    open.value = false
    await flush()
    expect(document.activeElement).toBe(elsewhere)
  })

  it('makes the page inert while open, keeps live regions and itself reachable, restores on close', async () => {
    const { page, live } = mountPage()
    const { open } = mountOverlay(component, false)

    open.value = true
    await flush()
    expect(page.hasAttribute('inert')).toBe(true)
    expect(live.hasAttribute('inert')).toBe(false)
    expect(overlay().hasAttribute('inert')).toBe(false)

    open.value = false
    await flush()
    expect(page.hasAttribute('inert')).toBe(false)
  })

  it('unmounting while open releases inert and the held page', async () => {
    const { page } = mountPage()
    mountOverlay(component, true)
    await flush()
    expect(page.hasAttribute('inert')).toBe(true)

    apps.forEach((a) => a.unmount())
    apps = []
    expect(page.hasAttribute('inert')).toBe(false)
  })

  it.each([
    ['starts inside the dialog, ends on the backdrop', 'inside', 'backdrop'],
    ['starts on the backdrop, ends inside the dialog', 'backdrop', 'inside'],
  ] as const)('a press that %s does not close it', async (_label, from, to) => {
    mountPage()
    const { onClose } = mountOverlay(component, true)
    await flush()
    const at = (where: 'inside' | 'backdrop') => (where === 'inside' ? dialog() : overlay())

    at(from).dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    at(to).dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    overlay().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onClose).not.toHaveBeenCalled()

    // The next genuine backdrop tap still closes (rejection comes with admission).
    overlay().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    overlay().dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    overlay().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('touch: a press that went down on the backdrop but was released over the dialog does not close it', async () => {
    mountPage()
    const { onClose } = mountOverlay(component, true)
    await flush()
    // A touch pointer is captured by the element it went down on, so its
    // pointerup reports the backdrop; the finger is really over the dialog.
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(dialog())

    overlay().dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }),
    )
    overlay().dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }))
    overlay().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a click with no pointer events (assistive tech) on the backdrop closes it, also after a cancelled gesture', async () => {
    mountPage()
    const { onClose } = mountOverlay(component, true)
    await flush()

    overlay().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onClose).toHaveBeenCalledTimes(1)

    // A cancelled press (the browser took the touch for a scroll) is not a tap.
    overlay().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    overlay().dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }))
    overlay().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onClose).toHaveBeenCalledTimes(1)

    // ...and the cancel does not poison the next click.
    overlay().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('iOS: with no focused element, focus returns to the control of the last pointerdown', async () => {
    const { opener } = mountPage()
    // WebKit leaves <body> focused after a tap on a button.
    ;(document.activeElement as HTMLElement | null)?.blur()
    const icon = document.createElement('span')
    opener.appendChild(icon)
    icon.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    const { open } = mountOverlay(component, false)

    open.value = true
    await flush()
    open.value = false
    await flush()
    expect(document.activeElement).toBe(opener)
  })

  it('does not try to focus an opener that left the document', async () => {
    const { opener } = mountPage()
    opener.focus()
    const focus = vi.spyOn(opener, 'focus')
    const { open } = mountOverlay(component, false)
    open.value = true
    await flush()

    opener.remove()
    open.value = false
    await flush()
    expect(focus).not.toHaveBeenCalled()
  })
})

describe('nested overlays share inert by count', () => {
  it('overlays opened in the same tick do not make each other inert', async () => {
    const { page } = mountPage()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({
      render: () => h(VModal, { open: true }, { default: () => h(VBottomSheet, { open: true }) }),
    })
    app.mount(host)
    apps.push(app)
    await flush()

    const roots = Array.from(document.body.children).filter((el) =>
      el.matches('.v-modal__scrim, .v-modal__overlay, .v-sheet__overlay'),
    )
    expect(roots).toHaveLength(3)
    expect(roots.some((el) => el.hasAttribute('inert'))).toBe(false)
    expect(page.hasAttribute('inert')).toBe(true)
  })

  it('closing the upper overlay keeps the page inert and re-opens the lower one', async () => {
    const { page } = mountPage()
    const lower = mountOverlay(VModal, true)
    await flush()
    const lowerOverlay = overlay()
    const upper = mountOverlay(VBottomSheet, true)
    await flush()
    // The lower overlay is part of the page for the upper one.
    expect(lowerOverlay.hasAttribute('inert')).toBe(true)

    upper.open.value = false
    await flush()
    expect(lowerOverlay.hasAttribute('inert')).toBe(false)
    expect(page.hasAttribute('inert')).toBe(true)

    lower.open.value = false
    await flush()
    expect(page.hasAttribute('inert')).toBe(false)
  })
})
