// =============================================================================
// VELO Frontend -- VMenu / VMenuItem Unit Tests (FE-144: written BEFORE the
// @velo/ui move)
// =============================================================================
//
// P6a-2 safety net, same pattern as VModal.test.ts from FE-142: VMenu and
// VMenuItem move to @velo/ui under FE-121 (P6), and until now neither had
// tests -- "moving untested code is forbidden". These pin the CURRENT
// components' contract as-is. Zero component edits: anything that could only
// pass after an edit is a component finding for the FE-144 report, not a fix
// in here.
//
// What is pinned (markup + events ONLY -- happy-dom: no var() tokens, no
// computed-style assertions):
//   - the trigger: the i18n-defaulted aria-label (the singleton t from
//     '@/locales', so no app-level i18n is involved), aria-haspopup=menu, the
//     aria-expanded toggle, the --open modifier, the default kebab glyph and
//     the #trigger slot's { open } scope;
//   - the panel: v-if open, role=menu, the default slot's { close } scope --
//     an item runs its action AND dismisses the menu;
//   - dismissal: an outside pointerdown (a DOCUMENT listener), Escape (also a
//     document keydown), the slot close() and the exposed close();
//   - the document-listener lifecycle: @/platform/dom is MOCKED with a
//     DELEGATING recorder -- attach/detach CALLS are asserted while real
//     document dispatch still reaches the component, so the dismissal cases
//     fire through the exact seam the lifecycle cases count.
//
// Findings pinned as-is (NOT fixed here, see the FE-144 report): the panel is
// role=menu but the items are plain buttons with no role=menuitem, and there
// is no arrow-key navigation or focus management at all.
//
// Dependency-free SFC mount (createApp + happy-dom), per velo-idiom §1 (no
// @vue/test-utils). The parent is a MINIMAL harness, so every case exercises
// exactly the component boundary, independent of any real screen.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { onDocumentEvent, offDocumentEvent } from '@/platform/dom'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createApp, nextTick, defineComponent, h, type App, type Component, type VNode } from 'vue'
import VMenu from '@/components/ui/VMenu.vue'
import VMenuItem from '@/components/ui/VMenuItem.vue'

// FE-144: the seam mock. vi.fn wrappers DELEGATE to the real document, so
// dispatch-based cases work unchanged while the CALLS stay countable. The
// partial factory keeps every other export real ('@/locales' itself imports
// setRootLang from this module, so a full stub would break module loading).
vi.mock('@/platform/dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/platform/dom')>()
  return {
    ...actual,
    onDocumentEvent: vi.fn((type: string, listener: (ev: Event) => unknown) =>
      document.addEventListener(type, listener as EventListener),
    ),
    offDocumentEvent: vi.fn((type: string, listener: (ev: Event) => unknown) =>
      document.removeEventListener(type, listener as EventListener),
    ),
  }
})

const onDoc = vi.mocked(onDocumentEvent)
const offDoc = vi.mocked(offDocumentEvent)

// A glyph stand-in for the `icon` prop: renders no text (VMenuItem carries no
// visible label) and mirrors the :size it received into data-size.
const DummyIcon = defineComponent({
  props: { size: { type: Number, default: 0 } },
  setup: (props) => () => h('i', { class: 'dummy-icon', 'data-size': String(props.size) }),
})

// -- mount ------------------------------------------------------------------

let app: App | null = null
let host: HTMLElement | null = null
const actions: string[] = []

interface MountOpts {
  /** Extra props forwarded onto VMenu (ariaLabel, ...). */
  props?: Record<string, unknown>
  /** Default-slot factory receiving VMenu's `{ close }` scope. */
  slot?: (scope: { close: () => void }) => VNode
  /** #trigger slot factory receiving the `{ open }` scope. */
  trigger?: (scope: { open: boolean }) => VNode
}

function mountApp(opts: MountOpts = {}): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({
    render: () =>
      h(VMenu, opts.props ?? {}, {
        // The every-call shape: an item that runs its action but does NOT
        // dismiss (the close-scope case opts in with its own factory).
        default:
          opts.slot ??
          (() =>
            h(VMenuItem, {
              ariaLabel: 'Действие',
              icon: DummyIcon,
              onClick: () => actions.push('ran'),
            })),
        ...(opts.trigger ? { trigger: opts.trigger } : {}),
      }),
  }).use(createTestI18n())
  app.mount(host)
}

/** Standalone VMenuItem mount (the component outside any VMenu). */
interface MountItemProps {
  ariaLabel: string
  icon?: Component
  iconSize?: number
  danger?: boolean
  onClick?: () => void
}

function mountItem(itemProps: MountItemProps, slot?: () => VNode): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(() => h(VMenuItem, itemProps, slot ? { default: slot } : {})).use(
    createTestI18n(),
  )
  app.mount(host)
}

// -- helpers ----------------------------------------------------------------

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await nextTick()
}

function trigger(): HTMLButtonElement | null {
  return host?.querySelector('button.v-menu__trigger') ?? null
}

function panel(): HTMLElement | null {
  return host?.querySelector('.v-menu__panel') ?? null
}

function item(): HTMLButtonElement | null {
  return host?.querySelector('button.v-menu-item') ?? null
}

/** A pointerdown whose target is OUTSIDE the menu root (here: the document). */
function pointerDownOutside(): void {
  document.dispatchEvent(new MouseEvent('pointerdown'))
}

/** A pointerdown INSIDE the panel that bubbles up to the document. */
function pointerDownInside(): void {
  item()!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
}

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
}

function attaches(type: 'pointerdown' | 'keydown'): number {
  return onDoc.mock.calls.filter(([t]) => t === type).length
}

function detaches(type: 'pointerdown' | 'keydown'): number {
  return offDoc.mock.calls.filter(([t]) => t === type).length
}

beforeEach(() => {
  actions.length = 0
  onDoc.mockClear()
  offDoc.mockClear()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

// -- tests -------------------------------------------------------------------

describe('VMenu (trigger markup)', () => {
  it('closed at rest: the kebab trigger with the i18n DEFAULT label, aria-haspopup=menu, aria-expanded=false; no panel', async () => {
    mountApp()
    await flush()

    const btn = trigger()
    expect(btn?.getAttribute('type')).toBe('button')
    // The default comes from the module-singleton t (shared.components.menuAria
    // -> "Menu"), not from any app-level i18n -- pinned as-is.
    expect(btn?.getAttribute('aria-label')).toBe('Меню')
    expect(btn?.getAttribute('aria-haspopup')).toBe('menu')
    expect(btn?.getAttribute('aria-expanded')).toBe('false')
    expect(btn?.classList.contains('v-menu__trigger--open')).toBe(false)
    expect(btn?.querySelector('svg')).not.toBeNull() // the default IconDots kebab
    expect(panel()).toBeNull()
  })

  it('a custom aria-label replaces the i18n default', async () => {
    mountApp({ props: { ariaLabel: 'Действия с записью' } })
    await flush()

    expect(trigger()?.getAttribute('aria-label')).toBe('Действия с записью')
  })

  it('the #trigger slot replaces the kebab glyph and receives { open }', async () => {
    mountApp({
      trigger: (scope) => h('span', { class: 'custom-glyph' }, scope.open ? 'открыто' : 'закрыто'),
    })
    await flush()

    expect(trigger()?.querySelector('svg')).toBeNull()
    expect(trigger()?.querySelector('.custom-glyph')?.textContent).toBe('закрыто')

    trigger()!.click()
    await flush()
    expect(trigger()?.querySelector('.custom-glyph')?.textContent).toBe('открыто')
  })
})

describe('VMenu (open/close + panel markup)', () => {
  it('the trigger toggles the panel: role=menu with the slotted items, aria-expanded and --open flip BOTH ways', async () => {
    mountApp()
    await flush()

    trigger()!.click()
    await flush()
    expect(panel()).not.toBeNull()
    expect(panel()?.getAttribute('role')).toBe('menu')
    expect(panel()?.contains(item())).toBe(true)
    expect(trigger()?.getAttribute('aria-expanded')).toBe('true')
    expect(trigger()?.classList.contains('v-menu__trigger--open')).toBe(true)

    trigger()!.click()
    await flush()
    expect(panel()).toBeNull()
    expect(trigger()?.getAttribute('aria-expanded')).toBe('false')
    expect(trigger()?.classList.contains('v-menu__trigger--open')).toBe(false)
  })

  it('the default slot receives { close }: an item runs its action AND dismisses the panel', async () => {
    mountApp({
      slot: (scope) =>
        h(VMenuItem, {
          ariaLabel: 'Редактировать',
          icon: DummyIcon,
          onClick: () => {
            actions.push('edit')
            scope.close()
          },
        }),
    })
    await flush()

    trigger()!.click()
    await flush()
    expect(panel()).not.toBeNull()

    item()!.click()
    await flush()
    expect(actions).toEqual(['edit'])
    expect(panel()).toBeNull()
    expect(trigger()?.getAttribute('aria-expanded')).toBe('false')
  })

  it('defineExpose({ close }): a parent closes the menu programmatically', async () => {
    mountApp()
    await flush()
    trigger()!.click()
    await flush()
    expect(panel()).not.toBeNull()

    const vm = app?._instance?.subTree.component?.exposed as { close: () => void } | undefined
    vm?.close()
    await flush()

    expect(panel()).toBeNull()
  })
})

describe('VMenu (dismissal -- document listeners via the mocked platform/dom seam)', () => {
  it('a pointerdown OUTSIDE the root (on the document) closes the open panel', async () => {
    mountApp()
    await flush()
    trigger()!.click()
    await flush()
    expect(panel()).not.toBeNull()

    pointerDownOutside()
    await flush()
    expect(panel()).toBeNull()
  })

  it('a pointerdown INSIDE the panel does not close it (the root.contains guard)', async () => {
    mountApp()
    await flush()
    trigger()!.click()
    await flush()

    pointerDownInside()
    await flush()
    expect(panel()).not.toBeNull()
  })

  it('Escape on the document closes the open panel', async () => {
    mountApp()
    await flush()
    trigger()!.click()
    await flush()

    pressEscape()
    await flush()
    expect(panel()).toBeNull()
  })

  it("pins today's a11y gaps for the move report: items have NO role=menuitem and arrow keys do not navigate", async () => {
    // FE-144 findings, pinned as-is: the panel is role=menu but the children
    // are plain buttons (no role=menuitem), and no keyboard navigation or
    // focus handoff exists -- Escape/outside-click dismissal is the whole
    // story. A proper menu pattern would need component edits, which this
    // test-only ticket forbids. See the FE-144 report.
    mountApp()
    await flush()
    trigger()!.click()
    await flush()

    expect(item()?.getAttribute('role')).toBeNull()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    await flush()
    expect(panel()).not.toBeNull()
    expect(document.activeElement).not.toBe(item())
  })
})

describe('VMenu (document-listener lifecycle -- attach/detach calls only)', () => {
  it('at rest nothing is attached, and stray document events while closed are inert', async () => {
    mountApp()
    await flush()

    expect(attaches('pointerdown')).toBe(0)
    expect(attaches('keydown')).toBe(0)

    pointerDownOutside()
    pressEscape()
    await flush()
    expect(panel()).toBeNull()
  })

  it('open attaches pointerdown+keydown ONCE each; the trigger close detaches both', async () => {
    mountApp()
    await flush()

    trigger()!.click()
    await flush()
    expect(attaches('pointerdown')).toBe(1)
    expect(attaches('keydown')).toBe(1)
    expect(detaches('pointerdown')).toBe(0)

    trigger()!.click()
    await flush()
    expect(detaches('pointerdown')).toBe(1)
    expect(detaches('keydown')).toBe(1)
  })

  it('open→close→open re-attaches (2 attaches / 1 detach per type)', async () => {
    mountApp()
    await flush()

    trigger()!.click()
    await flush()
    trigger()!.click()
    await flush()
    trigger()!.click()
    await flush()

    expect(attaches('pointerdown')).toBe(2)
    expect(attaches('keydown')).toBe(2)
    expect(detaches('pointerdown')).toBe(1)
    expect(detaches('keydown')).toBe(1)
  })

  it('unmounting while OPEN detaches both (no listener leaks into the next screen)', async () => {
    mountApp()
    await flush()
    trigger()!.click()
    await flush()
    onDoc.mockClear()
    offDoc.mockClear()

    app?.unmount()
    await flush()

    expect(detaches('pointerdown')).toBe(1)
    expect(detaches('keydown')).toBe(1)
  })
})

describe('VMenuItem (standalone markup + events)', () => {
  it('renders a round action button: type=button, the aria-label, NO visible text', async () => {
    mountItem({ ariaLabel: 'Редактировать', icon: DummyIcon })
    await flush()

    const btn = item()
    expect(btn?.getAttribute('type')).toBe('button')
    expect(btn?.getAttribute('aria-label')).toBe('Редактировать')
    expect(btn?.classList.contains('v-menu-item')).toBe(true)
    expect(btn?.classList.contains('v-menu-item--danger')).toBe(false)
    expect(btn?.textContent).toBe('') // the label is aria-only, the glyph is textless
  })

  it('danger=true adds the --danger modifier (the destructive fill)', async () => {
    mountItem({ ariaLabel: 'Удалить', icon: DummyIcon, danger: true })
    await flush()

    expect(item()?.classList.contains('v-menu-item--danger')).toBe(true)
  })

  it('the icon prop renders the glyph component with the DEFAULT size 20', async () => {
    mountItem({ ariaLabel: 'Редактировать', icon: DummyIcon })
    await flush()

    expect(item()?.querySelector('.dummy-icon')?.getAttribute('data-size')).toBe('20')
  })

  it('iconSize overrides the size handed to the glyph', async () => {
    mountItem({ ariaLabel: 'Редактировать', icon: DummyIcon, iconSize: 28 })
    await flush()

    expect(item()?.querySelector('.dummy-icon')?.getAttribute('data-size')).toBe('28')
  })

  it('without an icon the DEFAULT slot renders instead (the svg-path fallback)', async () => {
    mountItem({ ariaLabel: 'Фильтр' }, () => h('span', { class: 'slot-glyph' }))
    await flush()

    expect(item()?.querySelector('.slot-glyph')).not.toBeNull()
    expect(item()?.querySelector('.dummy-icon')).toBeNull()
  })

  it('the icon and the slot are mutually exclusive: with icon set the slot does not render', async () => {
    mountItem({ ariaLabel: 'Редактировать', icon: DummyIcon }, () =>
      h('span', { class: 'slot-glyph' }),
    )
    await flush()

    expect(item()?.querySelector('.dummy-icon')).not.toBeNull()
    expect(item()?.querySelector('.slot-glyph')).toBeNull()
  })

  it('a click is a PLAIN native click: the parent wires the action, nothing is swallowed', async () => {
    const clicked = vi.fn()
    mountItem({ ariaLabel: 'Редактировать', icon: DummyIcon, onClick: clicked })
    await flush()

    item()!.click()

    expect(clicked).toHaveBeenCalledTimes(1)
    // No preventDefault inside the component: the browser keeps its defaults.
    // (Asserted via a bubbling click on the host, whose defaultPrevented is
    // observable only on the event object itself.)
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    item()!.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
    expect(clicked).toHaveBeenCalledTimes(2)
  })
})
