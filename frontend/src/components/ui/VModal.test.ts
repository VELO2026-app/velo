// =============================================================================
// VELO Frontend -- VModal Unit Tests (FE-142: written BEFORE the @velo/ui move)
// =============================================================================
//
// P6a safety net: VModal moves to @velo/ui in FE-121 (P6), and until now it
// had no tests -- "переносить нетестированное запрещено". These pin the
// CURRENT component's contract as-is. Zero component edits: anything that
// could only pass after an edit is a component finding for the FE-142 report,
// not a fix in here.
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
//   - the body-scroll lock seam: the lock module is MOCKED (per FE-142) --
//     the lock/unlock CALLS are asserted, never the DOM. FE-143 moved the
//     module into @velo/ui (the component now reads it through the app's
//     ui barrel), so the mock targets the kit module and the spies travel
//     the same barrel the component does.
//
// SC-07/SC-13b (SendMessageModal.test.ts): content teleports to body, so
// every query goes to document.body, never to the mount host. A closed modal
// PARKS at v-modal-leave-active in happy-dom (a CSS transition that never
// ends) -- "closed" is asserted on the emitted event, and the live-overlay
// query excludes corpses parked by earlier closes.
//
// Dependency-free SFC mount (createApp + happy-dom), per velo-idiom §1
// (matches VInput.test.ts / DatePickerSheet.test.ts -- no @vue/test-utils).
// The parent here is a MINIMAL harness holding the open ref, so toggling
// exercises exactly the component boundary, independent of any real screen.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createApp, nextTick, ref, h, type App, type Ref, type VNode } from 'vue'
import VModal from '@/components/ui/VModal.vue'
import { lockBodyScroll, unlockBodyScroll } from '@/components/ui'

// FE-142: assert the lock CALLS, never body.overflow -- the ref-counted
// composable itself has its own unit tests (useBodyScrollLock.test.ts,
// living in @velo/ui since FE-143). FE-143 moved the module into the kit
// and the component onto the app barrel, so the mock overrides the kit
// module itself (spread + override: everything else stays real) -- the
// barrel's re-export then hands this file and the component the SAME
// mocked pair.
vi.mock('@velo/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@velo/ui')>()),
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
  /** The parent ACTS on @close (sets open=false) instead of just recording. */
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
  }).use(createTestI18n())
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
  it('the × button emits close exactly once (aria-labelled for screen readers)', async () => {
    mountApp({ open: true })
    await flush()

    expect(closeButton()?.getAttribute('aria-label')).toBe('Закрыть')
    closeButton()!.click()
    await flush()

    expect(closed).toHaveBeenCalledTimes(1)
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

describe('VModal (attrs root -- §7.2 status quo, Teleport root)', () => {
  it('a caller class neither crashes nor reaches the teleported dialog (no inheritAttrs merge today)', async () => {
    // VModal's root is a Teleport: Vue does not forward caller attrs onto a
    // teleported root (the dev warning VBottomSheet's header documents hitting
    // "the hard way"). The §7.2 attrs-root convention (inheritAttrs:false +
    // explicit merge) is therefore NOT satisfied yet -- a finding for the
    // FE-121 move. Pinned so the move has a baseline to change deliberately.
    mountApp({ open: true, props: { class: 'caller-class' } })
    await flush()

    expect(liveModal()).not.toBeNull()
    expect(liveModal()?.classList.contains('caller-class')).toBe(false)
    expect(liveContainer()?.classList.contains('caller-class')).toBe(false)
  })
})
