// =============================================================================
// @velo/ui -- VModal Unit Tests (FE-142 pinned the contract app-side BEFORE
// the move; FE-145 P6b carried the file into the kit with it)
// =============================================================================
//
// P6a safety net: these were written app-side when VModal had no tests --
// «переносить нетестированное запрещено» -- pinning the then-current
// contract as-is. FE-145 (the move this file travels with) changes exactly
// two things DELIBERATELY, both §7.2 seams, both re-pinned below: the ×
// button's aria-label is now the pure `closeLabel` prop (the localized
// default moved to the application barrel wrapper -- pinned app-side by
// VModal.localized.test.ts), and caller attrs now MERGE onto the teleported
// overlay (inheritAttrs:false + explicit v-bind, the attrs-root flip).
//
// What is pinned (markup + events ONLY -- happy-dom, tz-ui-package §4 P6:
// no var() token assertions, no computed-style/DOM-scroll assertions):
//   - the teleported dialog markup (scrim, overlay, role=dialog/aria-modal,
//     the × button, the slot inside the scroll area);
//   - the :open + @close contract (NOT v-model -- the component has none,
//     there is no update:open emit; see the FE-142 report);
//   - the close triggers: the × button, an overlay tap (the .self guard),
//     Escape -- a DOCUMENT keydown, so it fires with focus anywhere; there is
//     NO focus trap in this component (see the FE-142 report);
//   - the body-scroll lock seam: the lock module is MOCKED -- the
//     lock/unlock CALLS are asserted, never the DOM. The component imports
//     the module by its relative id, the mock targets the SAME id, so this
//     file and the component share one mocked pair.
//
// SC-07/SC-13b (SendMessageModal.test.ts): content teleports to body, so
// every query goes to document.body, never to the mount host. A closed modal
// PARKS at v-modal-leave-active in happy-dom (a CSS transition that never
// ends) -- "closed" is asserted on the emitted event, and the live-overlay
// query excludes corpses parked by earlier closes.
//
// Dependency-free SFC mount (createApp + happy-dom), per velo-idiom §1
// (no @vue/test-utils). The parent here is a MINIMAL harness holding the
// open ref, so toggling exercises exactly the component boundary,
// independent of any real screen.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createApp, nextTick, ref, h, type App, type Ref, type VNode } from 'vue'
import VModal from './VModal.vue'
import { lockBodyScroll, unlockBodyScroll } from '../../useBodyScrollLock'

// FE-142: assert the lock CALLS, never body.overflow -- the ref-counted
// composable itself has its own unit tests (useBodyScrollLock.test.ts,
// a kit resident since FE-143). The mock overrides this exact module
// (spread + override: everything else stays real) and the component reads
// the same id, so the mocked pair is shared.
vi.mock('../../useBodyScrollLock', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../useBodyScrollLock')>()),
  lockBodyScroll: vi.fn(),
  unlockBodyScroll: vi.fn(),
}))

const lockSpy = vi.mocked(lockBodyScroll)
const unlockSpy = vi.mocked(unlockBodyScroll)

// -- mount ------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null
let open: Ref<boolean>
const closed = vi.fn()

interface MountOpts {
  /** The :open prop the harness mounts with. */
  open?: boolean
  /** The parent ACTS on `@close` (sets open=false) instead of just recording. */
  closeOnEmit?: boolean
  /** Extra props/attrs forwarded onto VModal (closeOnOverlay, class, ...). */
  props?: Record<string, unknown>
  /** Default-slot content; defaults to a recognisable marker paragraph. */
  slot?: () => VNode
}

// createApp is kept in `app` for the afterEach unmount (mount() itself
// returns the root instance, not the app).
function mountApp(opts: MountOpts = {}): void {
  open = ref(opts.open ?? false)
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({
    render: () =>
      h(
        VModal,
        {
          ...(opts.props ?? {}),
          open: open.value,
          onClose: () => {
            closed()
            if (opts.closeOnEmit) open.value = false
          },
        },
        { default: opts.slot ?? (() => h('p', 'Диалоговое тело')) },
      ),
  })
  app.mount(host)
}

// -- helpers ----------------------------------------------------------------

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await nextTick()
}

/** The LIVE overlay -- excludes a corpse parked by an earlier close (SC-13c). */
function liveModal(): HTMLElement | null {
  return document.body.querySelector('.v-modal__overlay:not(.v-modal-leave-active)')
}

/** The live scrim, same corpse exclusion (it leaves on its own transition). */
function liveScrim(): HTMLElement | null {
  return document.body.querySelector('.v-modal__scrim:not(.v-modal-scrim-leave-active)')
}

function liveContainer(): HTMLElement | null {
  return liveModal()?.querySelector('.v-modal__container') ?? null
}

function closeButton(): HTMLButtonElement | null {
  return liveModal()?.querySelector('button.v-modal__close') ?? null
}

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
}

beforeEach(() => {
  closed.mockReset()
  lockSpy.mockReset()
  unlockSpy.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  // Corpses parked mid-leave never leave on their own in happy-dom (SC-13b).
  document.body.querySelectorAll('.v-modal__overlay, .v-modal__scrim').forEach((n) => n.remove())
  app = null
  host = null
})

// -- tests -------------------------------------------------------------------

describe('VModal (markup)', () => {
  it('open renders the teleported dialog: scrim, overlay, role=dialog, slot in the scroll area', async () => {
    mountApp({ open: true, slot: () => h('div', [h('h2', 'Заголовок'), h('p', 'Текст диалога')]) })
    await flush()

    // The whole dialog teleports to body, never into the mount host.
    expect(host?.querySelector('.v-modal__overlay')).toBeNull()
    expect(liveScrim()?.getAttribute('aria-hidden')).toBe('true')
    expect(liveModal()).not.toBeNull()

    const container = liveContainer()
    expect(container?.getAttribute('role')).toBe('dialog')
    expect(container?.getAttribute('aria-modal')).toBe('true')

    // There is no title prop -- a heading arrives as ordinary slot content.
    const scroll = container?.querySelector('.v-modal__scroll')
    expect(scroll?.querySelector('h2')?.textContent).toBe('Заголовок')
    expect(scroll?.textContent).toContain('Текст диалога')
  })

  it('closed renders no live dialog; flipping :open renders it (the :open + @close contract)', async () => {
    mountApp()
    await flush()
    expect(liveModal()).toBeNull()
    expect(liveScrim()).toBeNull()

    open.value = true
    await flush()
    expect(liveModal()).not.toBeNull()
    expect(liveScrim()).not.toBeNull()
  })

  it('showClose=false hides the × button; the content stays', async () => {
    mountApp({ open: true, props: { showClose: false } })
    await flush()

    expect(closeButton()).toBeNull()
    expect(liveContainer()?.textContent).toContain('Диалоговое тело')
  })
})

describe('VModal (close events)', () => {
  it('the × button emits close exactly once (aria-labelled via the pure closeLabel prop)', async () => {
    mountApp({ open: true, props: { closeLabel: 'Закрыть' } })
    await flush()

    expect(closeButton()?.getAttribute('aria-label')).toBe('Закрыть')
    closeButton()!.click()
    await flush()

    expect(closed).toHaveBeenCalledTimes(1)
  })

  it("the i18n seam: with NO closeLabel the × button carries no aria-label (the label is the host barrel's job)", async () => {
    // §7.2, the VLoader pattern: the kit component is pure -- the localized
    // default (t('ui.close')) is anchored by the APPLICATION barrel wrapper
    // until P3, pinned app-side by VModal.localized.test.ts. Here: nothing
    // passed -> nothing rendered.
    mountApp({ open: true })
    await flush()

    expect(closeButton()?.hasAttribute('aria-label')).toBe(false)
  })

  it('a tap on the overlay itself (the scrim area around the card) emits close', async () => {
    mountApp({ open: true })
    await flush()

    liveModal()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('a click INSIDE the card bubbles to the overlay but does not close (.self guard)', async () => {
    mountApp({ open: true })
    await flush()

    liveContainer()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    expect(closed).not.toHaveBeenCalled()
  })

  it('closeOnOverlay=false turns the overlay tap into a no-op (the × stays the only way)', async () => {
    mountApp({ open: true, props: { closeOnOverlay: false } })
    await flush()

    liveModal()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    expect(closed).not.toHaveBeenCalled()
  })

  it('Escape emits close -- a DOCUMENT keydown, so it needs no focus inside the dialog', async () => {
    mountApp({ open: true })
    await flush()

    pressEscape()
    await flush()

    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('Escape while closed emits nothing (the open guard, not a blanket listener)', async () => {
    mountApp()
    await flush()

    pressEscape()
    await flush()

    expect(closed).not.toHaveBeenCalled()
  })

  it('a close parks the overlay at v-modal-leave-active in happy-dom -- closed is the EVENT (SC-13b)', async () => {
    mountApp({ open: true, closeOnEmit: true })
    await flush()

    closed() // not emitted yet -- reset the recorder used as the trigger below
    closed.mockReset()
    pressEscape()
    await flush()

    expect(closed).toHaveBeenCalledTimes(1)
    // happy-dom never ends the CSS leave transition: the old overlay stays in
    // the DOM parked at v-modal-leave-active. That is exactly why "closed"
    // above is asserted on the event, and why every live* query filters it.
    expect(liveModal()).toBeNull()
    expect(document.body.querySelector('.v-modal__overlay.v-modal-leave-active')).not.toBeNull()
  })
})

describe('VModal (body scroll lock -- useBodyScrollLock mocked, calls only)', () => {
  it('open false→true locks ONCE; closing unlocks ONCE (paired 1:1)', async () => {
    mountApp({ closeOnEmit: true })
    await flush()
    expect(lockSpy).not.toHaveBeenCalled()

    open.value = true
    await flush()
    expect(lockSpy).toHaveBeenCalledTimes(1)
    expect(unlockSpy).not.toHaveBeenCalled()

    pressEscape() // parent acts: open flips back to false
    await flush()
    expect(unlockSpy).toHaveBeenCalledTimes(1)
    expect(lockSpy).toHaveBeenCalledTimes(1)
  })

  it('lock/unlock stay 1:1 across open→close→open cycles (no double lock)', async () => {
    mountApp({ closeOnEmit: true })
    await flush()

    open.value = true
    await flush()
    open.value = false
    await flush()
    open.value = true
    await flush()

    expect(lockSpy).toHaveBeenCalledTimes(2)
    expect(unlockSpy).toHaveBeenCalledTimes(1)
  })

  it('staying closed never calls either seam', async () => {
    mountApp()
    await flush()
    pressEscape()
    await flush()

    expect(lockSpy).not.toHaveBeenCalled()
    expect(unlockSpy).not.toHaveBeenCalled()
  })

  it('unmounting while open releases the lock (no leak into the next screen)', async () => {
    // Mounted CLOSED first: only the false→true transition takes the lock
    // (the watch is not immediate -- see the finding case below), so this is
    // the path where an unmount actually has a lock to release.
    mountApp()
    await flush()
    open.value = true
    await flush()
    expect(lockSpy).toHaveBeenCalledTimes(1)

    app?.unmount()
    await flush()

    expect(unlockSpy).toHaveBeenCalledTimes(1)
  })

  it("a modal MOUNTED already-open never locks -- the watch is not immediate (pins today's contract)", async () => {
    // FE-142 finding, pinned as-is: the lock lives in a non-immediate watch,
    // so the lock only engages on a false→true TRANSITION after mount. Every
    // in-app caller mounts VModal closed and toggles the ref, so this never
    // bites today -- but a caller that mounts :open="true" gets an unlocked
    // body. Flagged in the report for the P6 move; NOT fixed here.
    mountApp({ open: true })
    await flush()

    expect(liveModal()).not.toBeNull()
    expect(lockSpy).not.toHaveBeenCalled()
  })
})

describe('VModal (attrs root -- the §7.2 flip this move makes)', () => {
  it('a caller class lands on the teleported OVERLAY root (inheritAttrs:false + explicit merge)', async () => {
    // The FE-142 baseline pinned the OPPOSITE: a Teleport root silently
    // dropped caller attrs (the dev warning VBottomSheet's header documents
    // hitting «the hard way»). The FE-145 move flips it deliberately --
    // inheritAttrs:false + v-bind="attrs" on the overlay -- so a caller
    // class/data-* finally reaches the dialog, and no Vue warning fires.
    mountApp({ open: true, props: { class: 'caller-class' } })
    await flush()

    expect(liveModal()).not.toBeNull()
    expect(liveModal()?.classList.contains('caller-class')).toBe(true)
    // The merge is additive on the ROOT only -- the container inside stays
    // untouched.
    expect(liveContainer()?.classList.contains('caller-class')).toBe(false)
  })

  it('a caller data-velo-* attribute rides the same merge (kit-wide variant hooks)', async () => {
    mountApp({ open: true, props: { 'data-velo-surface': 'caller' } })
    await flush()

    expect(liveModal()?.getAttribute('data-velo-surface')).toBe('caller')
  })
})
