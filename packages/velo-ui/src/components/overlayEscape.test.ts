// =============================================================================
// @velo/ui -- stacked overlays: one Escape closes only the top one (FE-215)
// =============================================================================
//
// Every overlay used to listen for Escape on the document by itself, so with
// a dialog open over a sheet one press closed both. The kit's Escape stack
// (src/escapeStack.ts) hands the key to the overlay that opened last. Real
// document dispatch and real overlays: what is asserted is each overlay's
// own close emit (`cancel` for VConfirmDialog), in the order they arrive.
// =============================================================================

import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, ref, type App, type Component, type VNode } from 'vue'
import VModal from './VModal/VModal.vue'
import VBottomSheet from './VBottomSheet/VBottomSheet.vue'
import VConfirmDialog from './VConfirmDialog/VConfirmDialog.vue'

type Kind = 'sheet' | 'modal' | 'confirm'

const COMPONENTS: Record<Kind, Component> = {
  sheet: VBottomSheet,
  modal: VModal,
  confirm: VConfirmDialog,
}

let app: App | null = null
let closed: string[] = []

/** Overlay `name` of `kind`; its close emit records the name and closes it. */
function overlay(kind: Kind, name: string, isOpen: { value: boolean }, slot?: () => VNode): VNode {
  const onClose = (): void => {
    closed.push(name)
    isOpen.value = false
  }
  const props =
    kind === 'confirm'
      ? { open: isOpen.value, message: name, onCancel: onClose }
      : { open: isOpen.value, onClose }
  return h(COMPONENTS[kind], props, slot ? { default: slot } : undefined)
}

function mount(render: () => VNode): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render })
  app.mount(host)
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await nextTick()
}

/** A keydown bubbling from body to the document, like a real key press. */
async function pressEscape(): Promise<void> {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await flush()
}

afterEach(() => {
  app?.unmount()
  app = null
  closed = []
  document.body.innerHTML = ''
})

describe('stacked overlays close one per Escape, top first (FE-215)', () => {
  const chains: Kind[][] = [
    ['sheet', 'modal'],
    ['modal', 'sheet'],
    ['modal', 'modal'],
    ['sheet', 'confirm'],
    ['sheet', 'modal', 'confirm'],
  ]
  it.each(chains.map((kinds) => [kinds.join(' -> '), kinds] as const))('%s', async (_, kinds) => {
    // Each overlay is rendered inside the previous one and opened from it.
    const opens = kinds.map(() => ref(false))
    const names = kinds.map((kind, i) => `${i}:${kind}`)
    const nested = (i: number): VNode =>
      overlay(
        kinds[i]!,
        names[i]!,
        opens[i]!,
        i + 1 < kinds.length ? () => nested(i + 1) : undefined,
      )
    mount(() => nested(0))
    for (const isOpen of opens) {
      isOpen.value = true
      await flush()
    }

    for (let pressed = 1; pressed <= kinds.length; pressed++) {
      await pressEscape()
      expect(closed).toEqual(names.slice(-pressed).reverse())
    }

    await pressEscape()
    expect(closed).toHaveLength(kinds.length)
  })

  it('an overlay mounted earlier but opened later is the one on top', async () => {
    const first = ref(false)
    const second = ref(true)
    mount(() =>
      h('div', [
        overlay('modal', 'mounted-first', first),
        overlay('sheet', 'opened-first', second),
      ]),
    )
    await flush()
    first.value = true
    await flush()

    await pressEscape()
    expect(closed).toEqual(['mounted-first'])

    await pressEscape()
    expect(closed).toEqual(['mounted-first', 'opened-first'])
  })
})
