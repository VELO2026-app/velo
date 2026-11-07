// =============================================================================
// VConfirmDialog -- localized label pin (APPLICATION-side, FE-145 P6b)
// =============================================================================
//
// The i18n seam of the modal-family move: the kit VConfirmDialog renders
// its action-button labels PURE (empty until the props say something), so
// the localized defaults ('ui.cancel'/'ui.confirm') -- which the component
// itself used to resolve at render time via ?? t() -- are re-anchored in
// the application barrel until P3. This test pins what the app's ~20
// consumers actually see through @/components/ui in the default ru locale:
// the ru defaults, the consumer-override win, and that the dialog's own
// contract (title/slot/cancel wiring over the shared VModal) survives the
// functional wrapper.
//
// The global i18n singleton (imported by the wrapper) carries the eager ru
// catalog, so no plugin install is needed for the assertions.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import { createApp, h, type App } from 'vue'
import { VConfirmDialog } from '@/components/ui'

let app: App | null = null
let host: HTMLElement | null = null
let cancelled = 0

function mountDialog(props: Record<string, unknown> = {}): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({
    render: () =>
      h(
        VConfirmDialog,
        {
          open: true,
          message: 'Точно удалить?',
          onCancel: () => {
            cancelled += 1
          },
          ...props,
        },
        { default: () => h('p', 'Слот между заголовком и текстом') },
      ),
  })
  app.mount(host)
}

function liveModal(): HTMLElement | null {
  return document.body.querySelector('.v-modal__overlay:not(.v-modal-leave-active)')
}

function buttonWith(label: string): HTMLButtonElement | undefined {
  return Array.from(liveModal()?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (b) => b.textContent?.trim() === label,
  )
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  // The teleported overlay parks mid-leave in happy-dom (SC-13b).
  document.body.querySelectorAll('.v-modal__overlay, .v-modal__scrim').forEach((n) => n.remove())
  app = null
  host = null
  cancelled = 0
})

describe('VConfirmDialog (barrel): the localized action labels', () => {
  it("renders the localized ui.cancel/ui.confirm defaults ('Отмена'/'Подтвердить')", () => {
    mountDialog()
    expect(buttonWith('Отмена')).toBeDefined()
    expect(buttonWith('Подтвердить')).toBeDefined()
  })

  it('explicit consumer labels win over the seam defaults (§7.2 flip)', () => {
    mountDialog({ cancelLabel: 'Не сейчас', confirmLabel: 'Сообщить в поддержку' })
    expect(buttonWith('Не сейчас')).toBeDefined()
    expect(buttonWith('Сообщить в поддержку')).toBeDefined()
    expect(buttonWith('Отмена')).toBeUndefined()
    expect(buttonWith('Подтвердить')).toBeUndefined()
  })

  it('template-style kebab-case :cancel-label/:confirm-label bindings win too (both spellings read)', () => {
    // Every real caller binds kebab-case from a template; a functional
    // wrapper receives those attrs verbatim, so the seam reads both
    // spellings (the regression the AdminPromosView suite caught).
    mountDialog({ 'cancel-label': 'Не сейчас', 'confirm-label': 'Сообщить в поддержку' })
    expect(buttonWith('Не сейчас')).toBeDefined()
    expect(buttonWith('Сообщить в поддержку')).toBeDefined()
    expect(buttonWith('Отмена')).toBeUndefined()
    expect(buttonWith('Подтвердить')).toBeUndefined()
  })

  it('the wrapper forwards the default slot, and cancel still wires to the shared VModal', () => {
    mountDialog({ title: 'Заблокировать пользователя?' })
    expect(liveModal()?.textContent).toContain('Заблокировать пользователя?')
    expect(liveModal()?.textContent).toContain('Слот между заголовком и текстом')

    buttonWith('Отмена')!.click()
    expect(cancelled).toBe(1)
  })
})
