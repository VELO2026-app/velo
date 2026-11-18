// =============================================================================
// @velo/ui -- overlays mounted already open lock page scroll (FE-205)
// =============================================================================
//
// VModal and VBottomSheet used to take the body-scroll lock only on a
// false→true flip of :open, so an overlay MOUNTED with open=true left the
// page scrolling under it. Unlike the per-component suites (which mock the
// lock module and count calls), this file runs the REAL lock and asserts
// what a host layout keys on: the SCROLL_LOCK_CLASS root class on <html>.
// =============================================================================

import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, ref, type App, type Component } from 'vue'
import VModal from './VModal/VModal.vue'
import VBottomSheet from './VBottomSheet/VBottomSheet.vue'
import { SCROLL_LOCK_CLASS } from '../useBodyScrollLock'

let app: App | null = null

function mountOverlay(component: Component, open: boolean) {
  const isOpen = ref(open)
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(component, { open: isOpen.value }) })
  app.mount(host)
  return isOpen
}

function isLocked(): boolean {
  return document.documentElement.classList.contains(SCROLL_LOCK_CLASS)
}

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ''
})

describe.each([
  ['VModal', VModal],
  ['VBottomSheet', VBottomSheet],
] as const)('%s scroll lock (real lock module)', (_name, component) => {
  it('mounted open: locked from the first frame, released on unmount', () => {
    mountOverlay(component, true)
    expect(isLocked()).toBe(true)

    app?.unmount()
    app = null
    expect(isLocked()).toBe(false)
  })

  it('mounted open then closed: closing releases the lock', async () => {
    const isOpen = mountOverlay(component, true)
    expect(isLocked()).toBe(true)

    isOpen.value = false
    await nextTick()
    expect(isLocked()).toBe(false)
  })
})
