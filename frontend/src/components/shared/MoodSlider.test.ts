// =============================================================================
// VELO Frontend -- MoodSlider Component Tests (FE-85, tz-mood-scale.md §2/§8)
// =============================================================================
//
// The slider is the ONE write path both Check-in and Feedback answer through,
// and every input must land on the same controlled `modelValue`:
//
//   - the native range   -> the EXACT score (a drag keeps 1/3/5/7/9, tz §2.1);
//   - a card tap         -> the pair's TOP score 2/4/6/8/10 (tz §2.3), and
//                           re-tapping the active card is a NO-OP once the
//                           stored score already equals that click value;
//   - a horizontal swipe -> the nearest card, same top score (tz §2.2), with
//                           the browser's synthetic click swallowed so the
//                           swipe's emit stays the only one (tz §8);
//   - a vertical intent  -> NOTHING: pan-y hands the gesture to the page and
//                           pointercancel must abort cleanly.
//
// Mount convention: this repo's component tests use createApp + a wrapper
// (no @vue/test-utils); the model value round-trips through a real ref so the
// DOM state (aria-checked / aria-valuetext) is asserted against the same
// source of truth the screens submit from.
//
// happy-dom proves CONTRACT (emits, aria, disabled) -- never layout: the
// centering of the active card, the blur/scale transitions and the 320px
// cropping are browser-checked work (tz §3/§9), flagged in the handoff.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import { nextTick, ref, createApp, defineComponent, h, type App } from 'vue'
import MoodSlider from '@/components/shared/MoodSlider.vue'
import { MOOD_SCALE_LABELS, moodScoreFromIndex } from '@/utils/moodScale'

let app: App | null = null
let host: HTMLElement | null = null

/** Controlled mount: emits write back into `score`, like v-model on a view. */
function mountSlider(initial = 5, disabled = false): { host: HTMLElement; changes: number[] } {
  const score = ref(initial)
  const changes: number[] = []
  host = document.createElement('div')
  document.body.appendChild(host)
  const Wrapper = defineComponent({
    setup() {
      return () =>
        h(MoodSlider, {
          modelValue: score.value,
          'onUpdate:modelValue': (v: number) => {
            changes.push(v)
            score.value = v
          },
          ariaLabel: 'Оценка состояния от 1 до 10',
          disabled,
        })
    },
  })
  app = createApp(Wrapper)
  app.mount(host)
  return { host, changes }
}

function q<E extends HTMLElement = HTMLElement>(selector: string): E | null {
  return host?.querySelector<E>(selector) ?? null
}

function cards(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('.mood-slider__card') ?? [])
}

function activeCardIndex(): number {
  const i = cards().findIndex((c) => c.getAttribute('aria-checked') === 'true')
  if (i === -1) throw new Error('no card is aria-checked')
  return i
}

function range(): HTMLInputElement {
  const el = q<HTMLInputElement>('.mood-slider__input')
  if (!el) throw new Error('the native range did not render')
  return el
}

function strip(): HTMLElement {
  const el = q('.mood-slider__strip')
  if (!el) throw new Error('the strip did not render')
  return el
}

/** Fire a pointer event with coordinates (happy-dom has no PointerEvent). */
function point(type: string, el: Element, x: number, y: number, id = 1): void {
  const ev = new Event(type, { bubbles: true })
  Object.assign(ev, { clientX: x, clientY: y, pointerId: id })
  el.dispatchEvent(ev)
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('MoodSlider -- the five-emotion strip', () => {
  it('renders exactly five cards, in scale order, with the approved labels', () => {
    mountSlider()

    expect(cards().map((c) => c.querySelector('.mood-slider__label')?.textContent)).toEqual([
      'Плохо',
      'Не очень',
      'Нормально',
      'Хорошо',
      'Огонь',
    ])
    expect(Object.values(MOOD_SCALE_LABELS)).toHaveLength(5)
  })

  it('opens «Нормально»-active for the default 5 -- both screens seed 5 (tz §2.4)', () => {
    mountSlider(5)

    expect(activeCardIndex()).toBe(2)
    expect(range().getAttribute('aria-valuetext')).toBe('5 из 10 — Нормально')
  })

  it('every score 1..10 maps to its strict pair (the four borders must flip the card)', () => {
    const expected = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]
    expected.forEach((want, i) => {
      mountSlider(i + 1)
      expect(activeCardIndex()).toBe(want)
      app?.unmount()
      host?.remove()
      app = null
      host = null
    })
  })

  it('the range keeps its exact aria contract: min 1, max 10, valuenow = score', () => {
    mountSlider(7)

    const r = range()
    expect(r.min).toBe('1')
    expect(r.max).toBe('10')
    expect(r.getAttribute('aria-valuenow')).toBe('7')
    expect(r.getAttribute('aria-valuetext')).toBe('7 из 10 — Хорошо')
  })
})

describe('MoodSlider -- a card tap picks the pair TOP score', () => {
  it.each([
    [0, 2],
    [1, 4],
    [2, 6],
    [3, 8],
    [4, 10],
  ])('tapping card %i selects %i', (index, want) => {
    const { changes } = mountSlider(5)

    cards()[index]!.click()

    expect(changes).toEqual([want])
    expect(want).toBe(moodScoreFromIndex(index))
  })

  it('re-tapping the active card is a NO-OP when the score already matches', () => {
    const { changes } = mountSlider(6) // 6 IS neutral's click value

    cards()[2]!.click()

    expect(changes).toEqual([])
  })

  it('re-tapping the active card while on an ODD score still snaps to the click value', () => {
    // 5 sits inside «Нормально» but is not what the card promises; tapping it
    // must land on the pair's top score 6, not swallow the tap.
    const { changes } = mountSlider(5)

    cards()[2]!.click()

    expect(changes).toEqual([6])
  })

  it('the range input carries the RAW score -- an odd drag value stays odd (tz §2.1)', () => {
    const { changes } = mountSlider(5)

    const r = range()
    r.value = '3'
    r.dispatchEvent(new Event('input'))

    expect(changes).toEqual([3])
  })

  it('the radiogroup has ONE tab stop (roving tabindex) -- not six', () => {
    mountSlider(5)

    const tabbable = cards().filter((c) => c.getAttribute('tabindex') === '0')
    expect(tabbable).toHaveLength(1)
    expect(tabbable[0]!.textContent).toContain('Нормально')
  })

  it('ArrowRight walks the radiogroup and selects the NEXT card value', () => {
    const { changes } = mountSlider(5)

    const active = cards()[2]!
    active.focus()
    active.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))

    expect(changes).toEqual([8])
    expect(document.activeElement).toBe(cards()[3])
  })

  it('Home / End jump to the scale ends', () => {
    const { changes } = mountSlider(5)

    const active = cards()[2]!
    active.focus()
    active.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }))
    expect(changes).toEqual([10])

    active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }))
    expect(changes).toEqual([10, 2])
  })
})

describe('MoodSlider -- the horizontal swipe (tz §2.2)', () => {
  it('a horizontal drag snaps to the NEAREST card and emits its score ONCE', async () => {
    const { changes } = mountSlider(5)

    point('pointerdown', strip(), 200, 300)
    point('pointermove', strip(), 150, 300) // dx -50: commits horizontal
    point('pointermove', strip(), 100, 300) // dx -100 -> one full card left
    point('pointerup', strip(), 100, 300)
    await nextTick() // let the emit round-trip repaint the row

    // dragging left = toward the next (higher) emotion: 5/neutral -> 7/good
    expect(changes).toEqual([8])
    expect(activeCardIndex()).toBe(3)
  })

  it('the swipe swallows the synthetic click, so the release emits exactly ONCE', () => {
    const { changes } = mountSlider(5)

    point('pointerdown', strip(), 200, 300)
    point('pointermove', strip(), 100, 300)
    point('pointerup', strip(), 100, 300)
    // The browser still fires a click on whatever card sits under the finger:
    cards()[3]!.click()

    expect(changes).toEqual([8]) // the swipe's own emit -- nothing from the click
  })

  it('a TAP on a face selects it on release -- the pointer path needs no click event', async () => {
    // THE REGRESSION THIS PINS: pointer capture used to retarget the release
    // (and its click) to the strip, so tapping a face selected NOTHING. Now the
    // tap resolves on pointerup against the card the pointer went down on.
    const { changes } = mountSlider(5)

    const face = cards()[0]!
    point('pointerdown', face, 30, 60)
    point('pointerup', face, 32, 61) // inside the slop: a tap, not a drag
    await nextTick() // let the emit round-trip repaint the deck

    expect(changes).toEqual([2])
    expect(activeCardIndex()).toBe(0)
  })

  it('a drag STARTING on a face emits ONCE -- the release-click adds nothing', () => {
    const { changes } = mountSlider(5)

    point('pointerdown', cards()[2]!, 200, 60)
    point('pointermove', cards()[2]!, 100, 60) // horizontal lock, dx -100
    point('pointerup', cards()[2]!, 100, 60)
    cards()[2]!.click() // the browser's release-click lands back on this card

    expect(changes).toEqual([8]) // the drag's own emit -- the click is swallowed
  })

  it('a mostly VERTICAL drift inside the stage stays ours: no selection, no handoff', () => {
    // touch-action: none -- the browser never yanks the gesture mid-drag (the
    // old freeze). A near-vertical release over the same card is a no-op: the
    // card is already active with its exact click value.
    const { changes } = mountSlider(5)

    point('pointerdown', strip(), 200, 300)
    point('pointermove', strip(), 201, 320) // dy >> dx, inside DRAG_SLOP*2
    point('pointerup', strip(), 201, 320)

    expect(changes).toEqual([])
    expect(activeCardIndex()).toBe(2)
  })

  it('a jiggle inside the slop is a tap, not a drag -- it never suppresses the click', () => {
    const { changes } = mountSlider(5)

    point('pointerdown', strip(), 200, 300)
    point('pointermove', strip(), 203, 301) // inside DRAG_SLOP
    point('pointerup', strip(), 203, 301)
    cards()[4]!.click() // a real tap on «Огонь»

    expect(changes).toEqual([10])
  })
})

describe('MoodSlider -- while the form submits everything is inert (tz §8)', () => {
  it('cards are disabled, the range is disabled, and nothing emits', () => {
    const { changes } = mountSlider(5, true)

    cards()[2]!.click()
    const r = range()
    r.value = '9'
    r.dispatchEvent(new Event('input'))
    point('pointerdown', strip(), 200, 300)
    point('pointermove', strip(), 100, 300)
    point('pointerup', strip(), 100, 300)

    expect(changes).toEqual([])
    expect(cards().every((c) => (c as HTMLButtonElement).disabled)).toBe(true)
    expect(r.disabled).toBe(true)
  })
})
