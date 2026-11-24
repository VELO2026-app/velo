// =============================================================================
// VMenuRow Unit Tests
// =============================================================================
//
// Dependency-free SFC mount (createApp + happy-dom container), like the other
// kit tests. The row is a real button: it takes keyboard focus and Enter/Space
// activate it (it was a click-only div, so a screen made only of menu rows had
// nothing focusable on it -- axe scrollable-region-focusable, FE-248).
// =============================================================================

import { describe, it, expect, afterEach, vi } from 'vitest'
import { createApp, h, type App } from 'vue'
import VMenuRow from './VMenuRow.vue'

let app: App | null = null
let host: HTMLElement | null = null

function mount(onClick: () => void): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({
    render: () => h(VMenuRow, { label: 'Edit profile', onClick }),
  })
  app.mount(host)
  return host
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('VMenuRow', () => {
  it('is a button with the label, and a click reaches the host handler', () => {
    const onClick = vi.fn()
    const el = mount(onClick)

    const row = el.querySelector('.v-menu-row')
    expect(row?.tagName).toBe('BUTTON')
    expect(row?.getAttribute('type')).toBe('button')
    expect(row?.textContent).toContain('Edit profile')
    ;(row as HTMLButtonElement).click()
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
