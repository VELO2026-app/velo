// =============================================================================
// @velo/ui -- VConfirmDialog Unit Tests (FE-145 P6b: written with the move
// -- the modal family's third member)
// =============================================================================
//
// FE-142 pinned VModal/VBottomSheet app-side before their move; this
// composition layer (VModal + VButton + IconWarning) had no suite of its
// own, and «переносить нетестированное запрещено» applies to it too. The
// move itself cuts ONE seam this file pins first: the action-button labels
// are now PURE prop copy (the localized t('ui.cancel')/t('ui.confirm')
// defaults the app component used to resolve at render time moved to the
// application barrel wrapper -- pinned app-side by
// VConfirmDialog.localized.test.ts). Everything else pins the composition
// as-is: title/message/slot markup, the warning panel, the emits wiring
// over the shared VModal, and the loading guard.
//
// Markup + events ONLY (happy-dom, tz-ui-package §4 P6: no var() token
// assertions). The dialog teleports to body (SC-07), so every query goes to
// document.body; a closed dialog PARKS mid-leave in happy-dom (SC-13b),
// hence the live-overlay filter. The body-scroll lock never engages here:
// the harness mounts :open="true" and VModal's lock watch is not immediate
// (the FE-142 pinned finding), so no mock is needed.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import { createApp, h, type App } from 'vue'
import VConfirmDialog from './VConfirmDialog.vue'

let app: App | null = null
let host: HTMLElement | null = null
let cancelled = 0
let confirmed = 0

interface MountOpts {
  props?: Record<string, unknown>
}

function mountDialog(opts: MountOpts = {}): void {
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
          onConfirm: () => {
            confirmed += 1
          },
          ...opts.props,
        },
        { default: () => h('p', 'Слот между заголовком и текстом') },
      ),
  })
  app.mount(host)
}

function liveModal(): HTMLElement | null {
  return document.body.querySelector('.v-modal__overlay:not(.v-modal-leave-active)')
}

/** The two action buttons in DOM order: [cancel, confirm]. */
function actionButtons(): HTMLButtonElement[] {
  return Array.from(
    liveModal()?.querySelectorAll<HTMLButtonElement>('.v-confirm__actions button') ?? [],
  )
}

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  // The teleported overlay parks mid-leave in happy-dom (SC-13b).
  document.body.querySelectorAll('.v-modal__overlay, .v-modal__scrim').forEach((n) => n.remove())
  app = null
  host = null
  cancelled = 0
  confirmed = 0
})

describe('VConfirmDialog (markup)', () => {
  it('renders title, the slot between title and message, and the two-button actions row', () => {
    mountDialog({ props: { title: 'Заблокировать пользователя?' } })

    expect(liveModal()?.querySelector('h2.v-confirm__title')?.textContent).toBe(
      'Заблокировать пользователя?',
    )
    // The default slot (PROMPT №610, owner Q9) renders between title and
    // message.
    expect(liveModal()?.textContent).toContain('Слот между заголовком и текстом')
    expect(liveModal()?.querySelector('p.v-confirm__text')?.textContent).toBe('Точно удалить?')
    expect(actionButtons()).toHaveLength(2)
  })

  it('no title renders no heading; the message stays', () => {
    mountDialog()
    expect(liveModal()?.querySelector('.v-confirm__title')).toBeNull()
    expect(liveModal()?.textContent).toContain('Точно удалить?')
  })

  it('warningPanel moves the message into the peach panel (icon per warningPanelIcon)', () => {
    mountDialog({ props: { warningPanel: true } })
    expect(liveModal()?.querySelector('.v-confirm__panel')).not.toBeNull()
    expect(liveModal()?.querySelector('.v-confirm__panel .v-confirm__panel-icon')).not.toBeNull()

    app?.unmount()
    document.body.querySelectorAll('.v-modal__overlay, .v-modal__scrim').forEach((n) => n.remove())
    mountDialog({ props: { warningPanel: true, warningPanelIcon: false } })
    expect(liveModal()?.querySelector('.v-confirm__panel')).not.toBeNull()
    // T24-15: the confirmation drops the icon entirely while keeping the
    // panel + text.
    expect(liveModal()?.querySelector('.v-confirm__panel-icon')).toBeNull()
  })

  it('there is no × button -- the shared VModal is asked not to show one', () => {
    mountDialog()
    expect(liveModal()?.querySelector('button.v-modal__close')).toBeNull()
  })
})

describe('VConfirmDialog (the i18n seam -- pure labels)', () => {
  it("with NO labels the action buttons render EMPTY (the localized defaults are the app barrel's job)", () => {
    mountDialog()
    const [cancel, confirm] = actionButtons()
    expect(cancel?.textContent).toBe('')
    expect(confirm?.textContent).toBe('')
  })

  it('explicit labels are plain prop copy', () => {
    mountDialog({ props: { cancelLabel: 'Не сейчас', confirmLabel: 'Сообщить в поддержку' } })
    const [cancel, confirm] = actionButtons()
    expect(cancel?.textContent).toBe('Не сейчас')
    expect(confirm?.textContent).toBe('Сообщить в поддержку')
  })
})

describe('VConfirmDialog (events + the loading guard)', () => {
  it('the action buttons emit cancel/confirm exactly once each', () => {
    mountDialog({ props: { cancelLabel: 'Отмена', confirmLabel: 'Подтвердить' } })
    const [cancel, confirm] = actionButtons()

    cancel!.click()
    expect(cancelled).toBe(1)
    expect(confirmed).toBe(0)

    confirm!.click()
    expect(confirmed).toBe(1)
    expect(cancelled).toBe(1)
  })

  it('Escape travels the shared VModal and re-emits as cancel', () => {
    mountDialog()
    pressEscape()
    expect(cancelled).toBe(1)
  })

  it('loading guards BOTH buttons and turns the scrim tap into a no-op (close-on-overlay off)', () => {
    mountDialog({ props: { cancelLabel: 'Отмена', confirmLabel: 'Подтвердить', loading: true } })
    const [cancel] = actionButtons()
    expect(cancel?.disabled).toBe(true)

    cancel!.click()
    expect(cancelled).toBe(0)

    // The scrim (the overlay around the card) does not close either -- the
    // in-flight request owns the dialog.
    liveModal()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(cancelled).toBe(0)
  })
})
