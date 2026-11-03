// =============================================================================
// @velo/ui -- VBottomSheet Unit Tests (FE-142 pinned the contract app-side
// BEFORE the move; FE-145 P6b carried the file into the kit with it)
// =============================================================================
//
// P6a safety net: these were written app-side when VBottomSheet had no
// tests -- «переносить нетестированное запрещено» -- pinning the
// then-current contract as-is. FE-145 (the move this file travels with)
// changes exactly ONE thing DELIBERATELY, a §7.2 seam re-pinned below:
// caller attrs now MERGE onto the teleported overlay (inheritAttrs:false +
// explicit v-bind, the attrs-root flip). The component had no i18n to cut
// -- every label it renders is caller copy.
//
// What is pinned (markup + events ONLY -- happy-dom, tz-ui-package §4 P6:
// no var() token assertions, no computed-style/DOM-scroll assertions):
//   - the teleported sheet markup (panel role=dialog/aria-modal, the grab
//     handle, the title, the slot body, the one/two-button footers);
//   - the :open + @close contract (NOT v-model) and the @save contract;
//   - the close triggers: a scrim tap (the .self guard), Escape (a DOCUMENT
//     keydown -- no focus trap in this component; see the FE-142 report),
//     the cancel button, and the swipe-to-close drag from the grab zone;
//   - the body-scroll lock seam: the lock module is MOCKED -- the
//     lock/unlock CALLS are asserted, never the DOM. The component imports
//     the module by its relative id, the mock targets the SAME id, so this
//     file and the component share one mocked pair.
//
// SC-07/SC-13b (SendMessageModal.test.ts): the sheet teleports to body, so
// every query goes to document.body; a closed sheet PARKS at
// v-sheet-leave-active in happy-dom -- "closed" is asserted on the emitted
// event and the live-sheet query excludes corpses.
//
// The drag tests use raw Events with pointer fields assigned onto them
// (MoodSlider.test.ts's `point()` idiom -- happy-dom has no PointerEvent
// constructor worth using); the sheet's own setPointerCapture call is a
// happy-dom no-op-level builtin and does not stand in the way.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createApp, nextTick, ref, h, type App, type Ref, type VNode } from 'vue'
import VBottomSheet from './VBottomSheet.vue'
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
const saved = vi.fn()

interface MountOpts {
  /** The :open prop the harness mounts with. */
  open?: boolean
  /** The parent ACTS on @close (sets open=false) instead of just recording. */
  closeOnEmit?: boolean
  /** Extra props/attrs forwarded onto the sheet (title, saveLabel, ...). */
  props?: Record<string, unknown>
  /** Default-slot content; defaults to a recognisable marker paragraph. */
  slot?: () => VNode
}

// createApp is kept in `app` for the afterEach unmount (mount() itself
// returns the root instance, not the app).
function mountSheet(opts: MountOpts = {}): void {
  open = ref(opts.open ?? false)
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({
    render: () =>
      h(
        VBottomSheet,
        {
          ...(opts.props ?? {}),
          open: open.value,
          onClose: () => {
            closed()
            if (opts.closeOnEmit) open.value = false
          },
          onSave: () => saved(),
        },
        { default: opts.slot ?? (() => h('p', 'Тело шторки')) },
      ),
  })
  app.mount(host)
}

// -- helpers ----------------------------------------------------------------

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await nextTick()
}

/** The LIVE overlay -- excludes a corpse parked by an earlier close (SC-13c). */
function liveSheet(): HTMLElement | null {
  return document.body.querySelector('.v-sheet__overlay:not(.v-sheet-leave-active)')
}

function panel(): HTMLElement | null {
  return liveSheet()?.querySelector('.v-sheet__panel') ?? null
}

function handle(): HTMLElement | null {
  return liveSheet()?.querySelector('.v-sheet__handle') ?? null
}

function titleEl(): HTMLHeadingElement | null {
  return liveSheet()?.querySelector('h2.v-sheet__title') ?? null
}

function buttonWith(label: string): HTMLButtonElement | undefined {
  return Array.from(liveSheet()?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (b) => b.textContent?.trim() === label,
  )
}

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
}

/** Fire a pointer event with a Y coordinate (happy-dom has no PointerEvent). */
function point(type: string, el: Element, y: number, id = 1): void {
  const ev = new Event(type, { bubbles: true })
  Object.assign(ev, { clientY: y, pointerId: id })
  el.dispatchEvent(ev)
}

beforeEach(() => {
  closed.mockReset()
  saved.mockReset()
  lockSpy.mockReset()
  unlockSpy.mockReset()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  // Corpses parked mid-leave never leave on their own in happy-dom (SC-13b).
  document.body.querySelectorAll('.v-sheet__overlay').forEach((n) => n.remove())
  app = null
  host = null
})

// -- tests -------------------------------------------------------------------

describe('VBottomSheet (markup)', () => {
  it('open renders the teleported sheet: panel role=dialog, grab handle, title, slot body', async () => {
    mountSheet({
      open: true,
      props: { title: 'Дата практики' },
      slot: () => h('p', 'Контент шторки'),
    })
    await flush()

    // The whole sheet teleports to body, never into the mount host.
    expect(host?.querySelector('.v-sheet__overlay')).toBeNull()
    expect(liveSheet()).not.toBeNull()

    const sheet = panel()
    expect(sheet?.getAttribute('role')).toBe('dialog')
    expect(sheet?.getAttribute('aria-modal')).toBe('true')
    expect(sheet?.classList.contains('velo-kbd-scroll')).toBe(true)

    expect(handle()?.getAttribute('aria-hidden')).toBe('true')
    expect(titleEl()?.textContent).toBe('Дата практики')

    const body = sheet?.querySelector('.v-sheet__body')
    expect(body?.textContent).toContain('Контент шторки')

    // By design (the DS split with VModal): flush sheet, NO × button -- with
    // no saveLabel there is not a single button in the sheet.
    expect(liveSheet()?.querySelectorAll('button')).toHaveLength(0)
  })

  it("no title renders no heading at all (title defaults to '')", async () => {
    mountSheet({ open: true })
    await flush()

    expect(titleEl()).toBeNull()
    expect(handle()).not.toBeNull()
  })

  it('closed renders no live sheet; flipping :open renders it (the :open + @close contract)', async () => {
    mountSheet()
    await flush()
    expect(liveSheet()).toBeNull()

    open.value = true
    await flush()
    expect(liveSheet()).not.toBeNull()
  })

  it('compactTitle/titleStrong are opt-in modifiers -- the default h2 carries neither', async () => {
    mountSheet({ open: true, props: { title: 'Обычный заголовок' } })
    await flush()
    expect(titleEl()?.classList.contains('v-sheet__title--compact')).toBe(false)
    expect(titleEl()?.classList.contains('v-sheet__title--strong')).toBe(false)

    app?.unmount()
    document.body.querySelectorAll('.v-sheet__overlay').forEach((n) => n.remove())
    mountSheet({
      open: true,
      props: { title: 'Сообщить о пользователе', compactTitle: true, titleStrong: true },
    })
    await flush()
    expect(titleEl()?.classList.contains('v-sheet__title--compact')).toBe(true)
    expect(titleEl()?.classList.contains('v-sheet__title--strong')).toBe(true)
    // The §7.2 additive variant hooks mirror the modifiers; the default
    // h2 above carried neither attribute (undefined attrs are omitted).
    expect(titleEl()?.getAttribute('data-velo-compact')).toBe('true')
    expect(titleEl()?.getAttribute('data-velo-strong')).toBe('true')
  })
})

describe('VBottomSheet (footers)', () => {
  it('saveLabel alone renders ONE full-width save button; a tap emits save, not close', async () => {
    mountSheet({ open: true, props: { saveLabel: 'Сохранить' } })
    await flush()

    expect(liveSheet()?.querySelector('.v-sheet__actions')).toBeNull()
    expect(liveSheet()?.querySelectorAll('button')).toHaveLength(1)

    const save = buttonWith('Сохранить')!
    expect(save.classList.contains('v-sheet__save')).toBe(true)
    expect(save.getAttribute('type')).toBe('button')

    save.click()
    await flush()

    expect(saved).toHaveBeenCalledTimes(1)
    expect(closed).not.toHaveBeenCalled()
  })

  it('saveDisabled disables the save button -- a tap neither saves nor closes', async () => {
    mountSheet({ open: true, props: { saveLabel: 'Отправить', saveDisabled: true } })
    await flush()

    const save = buttonWith('Отправить')!
    expect(save.disabled).toBe(true)
    // The §7.2 additive state hook rides alongside the disabled attribute.
    expect(save.getAttribute('data-velo-disabled')).toBe('true')

    save.click()
    await flush()

    expect(saved).not.toHaveBeenCalled()
    expect(closed).not.toHaveBeenCalled()
  })

  it('cancelLabel + saveLabel render the paired row: cancel emits CLOSE, save emits SAVE', async () => {
    mountSheet({
      open: true,
      props: { saveLabel: 'Отправить', cancelLabel: 'Отмена' },
    })
    await flush()

    expect(liveSheet()?.querySelector('.v-sheet__actions')).not.toBeNull()
    expect(liveSheet()?.querySelectorAll('button')).toHaveLength(2)

    buttonWith('Отмена')!.click()
    await flush()
    expect(closed).toHaveBeenCalledTimes(1)
    expect(saved).not.toHaveBeenCalled()

    buttonWith('Отправить')!.click()
    await flush()
    expect(saved).toHaveBeenCalledTimes(1)
  })

  it("the paired row keeps the owner's default colours (no danger-cancel, no primary-save) and the variants can invert them", async () => {
    mountSheet({ open: true, props: { saveLabel: 'Отправить', cancelLabel: 'Отмена' } })
    await flush()

    const cancel = buttonWith('Отмена')!
    const save = buttonWith('Отправить')!
    expect(cancel.classList.contains('v-sheet__cancel--danger')).toBe(false)
    expect(save.classList.contains('v-sheet__save--primary')).toBe(false)

    app?.unmount()
    document.body.querySelectorAll('.v-sheet__overlay').forEach((n) => n.remove())
    mountSheet({
      open: true,
      props: {
        saveLabel: 'Добавить',
        cancelLabel: 'Отмена',
        cancelVariant: 'danger',
        saveVariant: 'primary',
      },
    })
    await flush()

    // The one owner-ruled exception (Modal E): classes only -- colours are
    // var() tokens and are NOT asserted here (tz-ui-package §4 P6).
    expect(buttonWith('Отмена')!.classList.contains('v-sheet__cancel--danger')).toBe(true)
    expect(buttonWith('Добавить')!.classList.contains('v-sheet__save--primary')).toBe(true)
    // The §7.2 additive variant hooks mirror the BEM modifiers.
    expect(buttonWith('Отмена')!.getAttribute('data-velo-variant')).toBe('danger')
    expect(buttonWith('Добавить')!.getAttribute('data-velo-variant')).toBe('primary')
  })
})

describe('VBottomSheet (close events)', () => {
  it('a tap on the scrim (the overlay itself) emits close', async () => {
    mountSheet({ open: true })
    await flush()

    liveSheet()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('a click on the PANEL bubbles to the overlay but does not close (.self guard)', async () => {
    mountSheet({ open: true, props: { title: 'Дата практики' } })
    await flush()

    titleEl()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    panel()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    expect(closed).not.toHaveBeenCalled()
  })

  it('closeOnOverlay=false turns the scrim tap into a no-op', async () => {
    mountSheet({ open: true, props: { closeOnOverlay: false } })
    await flush()

    liveSheet()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    expect(closed).not.toHaveBeenCalled()
  })

  it('Escape emits close -- a DOCUMENT keydown, no focus needed inside the sheet', async () => {
    mountSheet({ open: true })
    await flush()

    pressEscape()
    await flush()

    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('Escape while closed emits nothing (the open guard)', async () => {
    mountSheet()
    await flush()

    pressEscape()
    await flush()

    expect(closed).not.toHaveBeenCalled()
  })

  it('a close parks the sheet at v-sheet-leave-active in happy-dom -- closed is the EVENT (SC-13b)', async () => {
    mountSheet({ open: true, closeOnEmit: true })
    await flush()

    pressEscape()
    await flush()

    expect(closed).toHaveBeenCalledTimes(1)
    expect(liveSheet()).toBeNull()
    expect(document.body.querySelector('.v-sheet__overlay.v-sheet-leave-active')).not.toBeNull()
  })
})

describe('VBottomSheet (swipe-to-close from the grab zone)', () => {
  it('a press-and-release WITHOUT movement does not close (settles back in place)', async () => {
    mountSheet({ open: true })
    await flush()

    point('pointerdown', handle()!, 100)
    point('pointerup', handle()!, 100)
    await flush()

    expect(closed).not.toHaveBeenCalled()
    expect(liveSheet()).not.toBeNull()
  })

  it('an upward (negative) drag never closes -- dy is clamped at zero', async () => {
    mountSheet({ open: true })
    await flush()

    point('pointerdown', handle()!, 100)
    point('pointermove', handle()!, 40)
    point('pointerup', handle()!, 40)
    await flush()

    expect(closed).not.toHaveBeenCalled()
  })

  it('the panel follows the finger 1:1, and a far-enough release closes', async () => {
    mountSheet({ open: true })
    await flush()

    point('pointerdown', handle()!, 100)
    point('pointermove', handle()!, 160)
    await flush()

    // Inline transform set by the component (JS style, not a var() token):
    // dy = 160 - 100 = 60px down.
    expect(panel()?.style.transform).toBe('translate3d(0, 60px, 0)')

    // happy-dom reports offsetHeight 0, so closeAt collapses to min(160, 0):
    // ANY positive travel is "past the quarter". The real threshold maths is
    // a layout fact this DOM cannot express -- what is pinned here is that a
    // travelled drag ends in close and a motionless one does not.
    point('pointerup', handle()!, 160)
    await flush()

    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('pointercancel aborts the drag without closing (the system took over)', async () => {
    mountSheet({ open: true })
    await flush()

    point('pointerdown', handle()!, 100)
    point('pointermove', handle()!, 180)
    point('pointercancel', handle()!, 180)
    await flush()

    expect(closed).not.toHaveBeenCalled()
    expect(liveSheet()).not.toBeNull()
  })
})

describe('VBottomSheet (body scroll lock -- useBodyScrollLock mocked, calls only)', () => {
  it('open false→true locks ONCE; closing unlocks ONCE (paired 1:1)', async () => {
    mountSheet({ closeOnEmit: true })
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

  it('unmounting while open releases the lock (no leak into the next screen)', async () => {
    // Mounted CLOSED first: only the false→true transition takes the lock
    // (the watch is not immediate -- see the finding case below), so this is
    // the path where an unmount actually has a lock to release.
    mountSheet()
    await flush()
    open.value = true
    await flush()
    expect(lockSpy).toHaveBeenCalledTimes(1)

    app?.unmount()
    await flush()

    expect(unlockSpy).toHaveBeenCalledTimes(1)
  })

  it("a sheet MOUNTED already-open never locks -- the watch is not immediate (pins today's contract)", async () => {
    // FE-142 finding, pinned as-is (identical to VModal's): the lock lives
    // in a non-immediate watch, so mounting with :open="true" never locks the
    // body. Every in-app caller mounts closed and toggles. Flagged in the
    // report for the P6 move; NOT fixed here.
    mountSheet({ open: true })
    await flush()

    expect(liveSheet()).not.toBeNull()
    expect(lockSpy).not.toHaveBeenCalled()
  })
})

describe('VBottomSheet (attrs root -- the §7.2 flip this move makes)', () => {
  it('a caller class lands on the teleported OVERLAY root (inheritAttrs:false + explicit merge)', async () => {
    // The FE-142 baseline pinned the OPPOSITE: the component header's own
    // «the hard way» story -- attrs fallthrough onto a Teleported root was
    // a silent no-op, which is why titleStrong had to become a prop. The
    // FE-145 move flips it deliberately (inheritAttrs:false + v-bind="attrs"
    // on the overlay), so a caller class finally reaches the sheet.
    mountSheet({ open: true, props: { class: 'caller-class' } })
    await flush()

    expect(liveSheet()).not.toBeNull()
    expect(liveSheet()?.classList.contains('caller-class')).toBe(true)
    // The merge is additive on the ROOT only -- the panel inside stays
    // untouched.
    expect(panel()?.classList.contains('caller-class')).toBe(false)
  })
})
