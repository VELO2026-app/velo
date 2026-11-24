// =============================================================================
// @velo/ui -- VBottomSheet whole-sheet swipe, spring return, dismissible
// (FE-233, package 2)
// =============================================================================
//
// happy-dom has no layout, scrolling or real touch: scrollTop / offsetHeight
// are stubbed and touch events are hand-built. What is pinned is the gesture
// OWNERSHIP rule (who gets a swipe) and the dismissal routing. Feel (spring,
// rubber band, iOS/Android) is a device check: see the PR checklist.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
import VBottomSheet from './VBottomSheet.vue'

vi.mock('../../useBodyScrollLock', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../useBodyScrollLock')>()),
  lockBodyScroll: vi.fn(),
  unlockBodyScroll: vi.fn(),
}))

let app: App | null = null
let host: HTMLElement | null = null
const closed = vi.fn()
const attempted = vi.fn()
let open = ref(true)

function mountSheet(props: Record<string, unknown> = {}, body = () => h('p', 'body')): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  open = ref(true)
  app = createApp({
    render: () =>
      h(
        VBottomSheet,
        {
          open: open.value,
          title: 'Title',
          ...props,
          onClose: () => {
            closed()
            open.value = false
          },
          onDismissAttempt: () => attempted(),
        },
        { default: body },
      ),
  })
  app.mount(host)
}

// A sheet closed in happy-dom parks mid-leave: queries skip that corpse.
const LIVE = '.v-sheet__overlay:not(.v-sheet-leave-active)'
const panel = (): HTMLElement => document.body.querySelector(`${LIVE} .v-sheet__panel`)!
const handle = (): HTMLElement => document.body.querySelector(`${LIVE} .v-sheet__handle`)!
const title = (): HTMLElement => document.body.querySelector(`${LIVE} .v-sheet__title`)!
const overlay = (): HTMLElement => document.body.querySelector(LIVE)!

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await nextTick()
}

/** A touch event at (x, y) with a fixed timestamp; returns it for `defaultPrevented`. */
function touch(type: string, el: Element, y: number, t: number, x = 0, fingers = 1): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  const point = { clientX: x, clientY: y }
  Object.defineProperty(ev, 'timeStamp', { value: t })
  const down = type === 'touchend' || type === 'touchcancel' ? [] : Array(fingers).fill(point)
  Object.assign(ev, { touches: down })
  el.dispatchEvent(ev)
  return ev
}

function pointer(type: string, el: Element, y: number, t: number): void {
  const ev = new Event(type, { bubbles: true })
  Object.defineProperty(ev, 'timeStamp', { value: t })
  Object.assign(ev, { clientY: y, pointerId: 1, pointerType: 'touch', button: 0 })
  el.dispatchEvent(ev)
}

let frames: Array<(now: number) => void>

beforeEach(() => {
  closed.mockReset()
  attempted.mockReset()
  frames = []
  vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => frames.push(cb))
  vi.stubGlobal('cancelAnimationFrame', () => {
    frames = []
  })
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  document.body.querySelectorAll('.v-sheet__overlay').forEach((n) => n.remove())
  app = null
  host = null
  vi.unstubAllGlobals()
})

describe('VBottomSheet (swipe from anywhere on the sheet)', () => {
  it('a downward swipe on the body, content at its top, drags the sheet and closes on release', async () => {
    mountSheet()
    await flush()
    const body = panel().querySelector('p')!

    touch('touchstart', body, 100, 0)
    touch('touchmove', body, 110, 16)
    const move = touch('touchmove', body, 180, 32)
    expect(move.defaultPrevented).toBe(true)
    expect(panel().style.transform).toMatch(/^translate3d\(0, [\d.]+px, 0\)$/)

    touch('touchend', body, 180, 48)
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('a swipe over content scrolled away from the top belongs to the content', async () => {
    mountSheet()
    await flush()
    const body = panel().querySelector('p')!
    panel().scrollTop = 120

    touch('touchstart', body, 100, 0)
    touch('touchmove', body, 110, 16)
    const move = touch('touchmove', body, 180, 32)
    touch('touchend', body, 180, 48)

    expect(move.defaultPrevented).toBe(false)
    expect(panel().style.transform).toBe('')
    expect(closed).not.toHaveBeenCalled()
  })

  it('a nested scroller that is scrolled keeps the swipe even when the panel is at its top', async () => {
    mountSheet({}, () => h('ul', { class: 'inner' }, [h('li', 'row')]))
    await flush()
    const row = panel().querySelector('li')!
    panel().querySelector<HTMLElement>('.inner')!.scrollTop = 40

    touch('touchstart', row, 100, 0)
    touch('touchmove', row, 110, 16)
    const move = touch('touchmove', row, 180, 32)

    expect(move.defaultPrevented).toBe(false)
    expect(closed).not.toHaveBeenCalled()
  })

  it('a mostly sideways swipe is not the sheet’s', async () => {
    mountSheet()
    await flush()
    const body = panel().querySelector('p')!

    touch('touchstart', body, 100, 0, 0)
    const move = touch('touchmove', body, 112, 16, 60)
    touch('touchend', body, 112, 32, 60)

    expect(move.defaultPrevented).toBe(false)
    expect(closed).not.toHaveBeenCalled()
  })

  it('an own-gesture control (range slider) keeps its drag', async () => {
    mountSheet({}, () => h('input', { type: 'range' }))
    await flush()
    const slider = panel().querySelector('input')!

    touch('touchstart', slider, 100, 0)
    const move = touch('touchmove', slider, 200, 16)
    touch('touchend', slider, 200, 32)

    expect(move.defaultPrevented).toBe(false)
    expect(closed).not.toHaveBeenCalled()
  })

  it('pulling up with nothing to scroll resists: the panel moves less than the finger', async () => {
    mountSheet()
    await flush()
    const handleEl = handle()
    pointer('pointerdown', handleEl, 300, 0)
    pointer('pointermove', handleEl, 100, 16)

    const moved = Number(/-?[\d.]+(?=px)/.exec(panel().style.transform)?.[0])
    expect(moved).toBeLessThan(0)
    expect(Math.abs(moved)).toBeLessThan(200)
  })
})

describe('VBottomSheet (spring return)', () => {
  it('a short slow swipe springs back to rest instead of snapping or closing', async () => {
    mountSheet()
    await flush()
    Object.defineProperty(panel(), 'offsetHeight', { value: 600 })
    pointer('pointerdown', handle(), 100, 0)
    pointer('pointermove', handle(), 150, 400)
    pointer('pointerup', handle(), 150, 800)

    expect(closed).not.toHaveBeenCalled()
    expect(frames.length).toBeGreaterThan(0)

    let now = 0
    while (frames.length > 0 && now < 5000) {
      now += 16
      frames.shift()!(now)
    }
    expect(panel().style.transform).toBe('')
  })
})

describe('VBottomSheet (who owns the gesture)', () => {
  it('is decided at touchstart: content that scrolls to its top mid-gesture does not hand it over', async () => {
    mountSheet()
    await flush()
    const body = panel().querySelector('p')!
    panel().scrollTop = 50

    touch('touchstart', body, 100, 0)
    panel().scrollTop = 0
    touch('touchmove', body, 110, 16)
    const move = touch('touchmove', body, 180, 32)

    expect(move.defaultPrevented).toBe(false)
    expect(panel().style.transform).toBe('')
  })

  it('a finger that first goes up leaves the gesture to the content for good', async () => {
    mountSheet()
    await flush()
    const body = panel().querySelector('p')!

    touch('touchstart', body, 200, 0)
    touch('touchmove', body, 180, 16)
    const down = touch('touchmove', body, 260, 32)
    touch('touchend', body, 260, 48)

    expect(down.defaultPrevented).toBe(false)
    expect(closed).not.toHaveBeenCalled()
  })

  it('pulled back up past the start, a scrollable panel gives the swipe to its content', async () => {
    mountSheet()
    await flush()
    const body = panel().querySelector('p')!
    Object.defineProperty(panel(), 'scrollHeight', { value: 900, configurable: true })
    Object.defineProperty(panel(), 'clientHeight', { value: 500, configurable: true })

    touch('touchstart', body, 100, 0)
    touch('touchmove', body, 110, 16)
    touch('touchmove', body, 150, 32)
    const back = touch('touchmove', body, 90, 48)
    const again = touch('touchmove', body, 160, 64)

    expect(back.defaultPrevented).toBe(false)
    expect(panel().style.transform).toBe('')
    expect(again.defaultPrevented).toBe(false)
  })

  it('a second finger never starts a sheet drag', async () => {
    mountSheet()
    await flush()
    const body = panel().querySelector('p')!

    touch('touchstart', body, 100, 0, 0, 2)
    const move = touch('touchmove', body, 200, 16)

    expect(move.defaultPrevented).toBe(false)
    expect(panel().style.transform).toBe('')
  })

  it('a touch on the grab zone is left to its own pointer path', async () => {
    mountSheet()
    await flush()

    touch('touchstart', title(), 100, 0)
    touch('touchmove', title(), 110, 16)
    const move = touch('touchmove', title(), 200, 32)

    expect(move.defaultPrevented).toBe(false)
  })

  it('touchcancel springs the panel back without closing', async () => {
    mountSheet()
    await flush()
    const body = panel().querySelector('p')!
    Object.defineProperty(panel(), 'offsetHeight', { value: 600, configurable: true })

    touch('touchstart', body, 100, 0)
    touch('touchmove', body, 110, 16)
    touch('touchmove', body, 150, 32)
    touch('touchcancel', body, 150, 48)

    expect(closed).not.toHaveBeenCalled()
    expect(frames.length).toBeGreaterThan(0)
  })
})

describe('VBottomSheet (position after a gesture)', () => {
  it('a sheet closed by swipe reopens at rest: a 1 px handle move does not close it', async () => {
    mountSheet()
    await flush()
    const body = panel().querySelector('p')!
    touch('touchstart', body, 100, 0)
    touch('touchmove', body, 110, 16)
    touch('touchmove', body, 300, 32)
    touch('touchend', body, 300, 48)
    expect(closed).toHaveBeenCalledTimes(1)
    await flush()

    open.value = true
    await flush()
    expect(panel().style.transform).toBe('')
    Object.defineProperty(panel(), 'offsetHeight', { value: 600, configurable: true })
    pointer('pointerdown', handle(), 500, 1000)
    pointer('pointermove', handle(), 501, 1016)
    pointer('pointerup', handle(), 501, 1032)

    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('a tap on the body during the spring does not stop it', async () => {
    mountSheet()
    await flush()
    const body = panel().querySelector('p')!
    Object.defineProperty(panel(), 'offsetHeight', { value: 2000, configurable: true })
    touch('touchstart', body, 100, 0)
    touch('touchmove', body, 110, 16)
    touch('touchmove', body, 140, 200)
    touch('touchend', body, 140, 400)
    frames.shift()!(1000)

    touch('touchstart', body, 300, 1100)
    touch('touchend', body, 300, 1150)
    expect(frames.length).toBe(1)

    let now = 1200
    while (frames.length > 0 && now < 6000) {
      now += 16
      frames.shift()!(now)
    }
    expect(panel().style.transform).toBe('')
  })

  it('a finger held still before lifting reads as slow: no fling-close', async () => {
    mountSheet()
    await flush()
    Object.defineProperty(panel(), 'offsetHeight', { value: 600, configurable: true })

    pointer('pointerdown', handle(), 100, 0)
    pointer('pointermove', handle(), 140, 20)
    pointer('pointerup', handle(), 140, 1020)

    expect(closed).not.toHaveBeenCalled()
  })

  it('reduced motion returns the panel at once, with no spring', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    mountSheet()
    await flush()
    Object.defineProperty(panel(), 'offsetHeight', { value: 600, configurable: true })

    pointer('pointerdown', handle(), 100, 0)
    pointer('pointermove', handle(), 150, 400)
    pointer('pointerup', handle(), 150, 800)

    expect(panel().style.transform).toBe('')
    expect(frames.length).toBe(0)
  })

  it('unmounting during the spring cancels it', async () => {
    mountSheet()
    await flush()
    Object.defineProperty(panel(), 'offsetHeight', { value: 600, configurable: true })
    pointer('pointerdown', handle(), 100, 0)
    pointer('pointermove', handle(), 150, 400)
    pointer('pointerup', handle(), 150, 800)
    expect(frames.length).toBeGreaterThan(0)

    app?.unmount()
    app = null

    expect(frames.length).toBe(0)
  })
})

describe('VBottomSheet (dismissible=false)', () => {
  const triggers: Array<[string, () => void]> = [
    [
      'a scrim tap',
      () => {
        const scrim = overlay()
        scrim.dispatchEvent(new Event('pointerdown', { bubbles: true }))
        scrim.dispatchEvent(new Event('pointerup', { bubbles: true }))
        scrim.dispatchEvent(new Event('click', { bubbles: true }))
      },
    ],
    ['Escape', () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))],
    [
      'the cancel button',
      () => document.body.querySelector<HTMLElement>('.v-sheet__cancel')!.click(),
    ],
  ]

  it.each(triggers)('%s asks instead of closing', async (_name, trigger) => {
    mountSheet({ dismissible: false, cancelLabel: 'Cancel', saveLabel: 'Save' })
    await flush()
    trigger()
    await flush()

    expect(attempted).toHaveBeenCalledTimes(1)
    expect(closed).not.toHaveBeenCalled()
  })

  it('a swipe past the threshold asks, and the panel springs back instead of leaving', async () => {
    mountSheet({ dismissible: false })
    await flush()
    pointer('pointerdown', handle(), 100, 0)
    pointer('pointermove', handle(), 260, 16)
    pointer('pointerup', handle(), 260, 32)

    expect(attempted).toHaveBeenCalledTimes(1)
    expect(closed).not.toHaveBeenCalled()
    expect(panel().style.transform).not.toContain('100%')
  })

  it('stays silent about attempts while dismissible (the default)', async () => {
    mountSheet()
    await flush()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(closed).toHaveBeenCalledTimes(1)
    expect(attempted).not.toHaveBeenCalled()
  })
})
