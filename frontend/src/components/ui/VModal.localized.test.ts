// =============================================================================
// VModal -- localized close-label pin (APPLICATION-side, FE-145 P6b)
// =============================================================================
//
// The i18n seam of the modal-family move: the kit VModal is pure and its ×
// button's aria-label arrives through the `closeLabel` prop (§7.2), so the
// LOCALIZED default ('ui.close') is re-anchored in the application barrel
// until P3 gives the kit its own i18n story. This test pins what the app's
// consumers actually see through @/components/ui -- in the default ru
// locale -- and must stay green across the flip (and until P3 moves the
// seam again).
//
// It also pins the wrapper's two mechanical duties beyond the label: caller
// attrs keep flowing (the kit's §7.2 attrs-root merge happens under the
// wrapper) and the DEFAULT SLOT survives the functional wrapper (h(…, slots)).
//
// The global i18n singleton (imported by the wrapper) carries the eager ru
// catalog, so no plugin install is needed for the assertions.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import { createApp, h, type App } from 'vue'
import { VModal } from '@/components/ui'

let app: App | null = null
let host: HTMLElement | null = null

function mountModal(props: Record<string, unknown>): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({
    render: () => h(VModal, { open: true, ...props }, { default: () => h('p', 'Тело диалога') }),
  })
  app.mount(host)
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  // The teleported overlay parks mid-leave in happy-dom (SC-13b).
  document.body.querySelectorAll('.v-modal__overlay, .v-modal__scrim').forEach((n) => n.remove())
  app = null
  host = null
})

describe('VModal (barrel): the localized × label', () => {
  it("announces the × button with the localized ui.close string ('Закрыть')", () => {
    mountModal({})
    const button = document.body.querySelector<HTMLButtonElement>('button.v-modal__close')
    expect(button?.getAttribute('aria-label')).toBe('Закрыть')
  })

  it("an explicit consumer closeLabel wins over the seam's default (§7.2 flip)", () => {
    mountModal({ closeLabel: 'Dismiss' })
    const button = document.body.querySelector<HTMLButtonElement>('button.v-modal__close')
    expect(button?.getAttribute('aria-label')).toBe('Dismiss')
  })

  it('a template-style kebab-case :close-label binding wins too (the wrapper reads both spellings)', () => {
    // A functional wrapper without declared runtime props receives a
    // compiled template's attrs VERBATIM -- '<VModal :close-label="...">'
    // arrives as attrs['close-label'], never camelized (measured; the
    // wrapper reads both so every caller spelling keeps the override).
    mountModal({ 'close-label': 'Закрыть окно' })
    const button = document.body.querySelector<HTMLButtonElement>('button.v-modal__close')
    expect(button?.getAttribute('aria-label')).toBe('Закрыть окно')
  })

  it('the wrapper forwards the default slot -- the dialog body renders through the barrel', () => {
    mountModal({})
    const overlay = document.body.querySelector('.v-modal__overlay:not(.v-modal-leave-active)')
    expect(overlay?.textContent).toContain('Тело диалога')
  })

  it('caller attrs still reach the teleported overlay through the wrapper (the §7.2 attrs-root merge)', () => {
    mountModal({ class: 'caller-class' })
    const overlay = document.body.querySelector('.v-modal__overlay:not(.v-modal-leave-active)')
    expect(overlay?.classList.contains('caller-class')).toBe(true)
  })
})
