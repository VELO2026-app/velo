// =============================================================================
// @velo/ui -- VBottomSheet drag controller (FE-233, package 2)
// =============================================================================
//
// Owns the swipe of a bottom sheet panel. Two entry points share one state:
//
//  - the grab zone (handle + title): pointer events, mouse and touch alike;
//    the zone is touch-action:none, so the page never scrolls under it.
//  - the rest of the panel: touch events. The sheet takes the gesture only
//    when the finger moves DOWN and nothing under it can scroll up any more
//    (the panel and any scroller between it and the finger sit at the top).
//    A list scrolled to its top therefore hands the same swipe to the sheet;
//    pulling back up hands it to the list again.
//
// While the finger drags, the panel follows 1:1 downward and with rubber-band
// resistance upward. On release: past a quarter of the panel (capped) or
// flicked down -> `onRelease(true)` should close; otherwise the panel springs
// back from where it was, with the finger's own velocity.
//
// Touch handling follows the idea of the drawer in Vercel's UI SDK
// (https://github.com/vercel-labs/ui, Apache-2.0): an independent
// re-implementation for Vue 3, not a copy.
// =============================================================================

import { onUnmounted, type Ref } from 'vue'
import { prefersReducedMotion } from './platform/dom'
import { createVelocityTracker, rubberBand, springTo } from './sheetGesture'

const CLOSE_DISTANCE_MAX_PX = 160
const CLOSE_VELOCITY_PX_PER_MS = 0.5
/** Pull-up resistance asymptote: the panel never leaves its place by more than this. */
const RUBBER_LIMIT_PX = 72
/** Vertical travel before a touch gesture is classified, px. */
const TOUCH_SLOP_PX = 4
/** Controls that keep their own drag; a swipe starting on one is never the sheet's. */
const OWN_GESTURE = 'input[type="range"], [role="slider"], [data-sheet-no-drag]'
const GRAB_ZONE = '.v-sheet__handle, .v-sheet__title'

/** Options of `useSheetDrag`. */
export interface SheetDragOptions {
  /** The sheet panel element. */
  panel: Ref<HTMLElement | null>
  /**
   * A release went past the close threshold.
   *
   * @returns True when the sheet is closing (the panel then slides out); false
   * when the close was refused, and the panel springs back.
   */
  onRelease: () => boolean
}

type Source = 'grab' | 'touch'

/** Handlers for the template and nothing else; all state stays inside. */
export interface SheetDrag {
  onGrabDown: (e: PointerEvent) => void
  onGrabMove: (e: PointerEvent) => void
  onGrabEnd: (e: PointerEvent) => void
  onGrabCancel: (e: PointerEvent) => void
  onTouchStart: (e: TouchEvent) => void
  onTouchMove: (e: TouchEvent) => void
  onTouchEnd: (e: TouchEvent) => void
  onTouchCancel: (e: TouchEvent) => void
}

/** True when no element from `from` up to `panel` is scrolled away from its top. */
function atScrollTop(from: EventTarget | null, panel: HTMLElement): boolean {
  let el = from instanceof Element ? from : null
  while (el) {
    if (el.scrollTop > 0) return false
    if (el === panel) return true
    el = el.parentElement
  }
  return panel.scrollTop <= 0
}

/**
 * Wire the swipe of a bottom sheet panel.
 *
 * @param options - See `SheetDragOptions`.
 * @returns Event handlers for the template.
 */
export function useSheetDrag(options: SheetDragOptions): SheetDrag {
  const tracker = createVelocityTracker()
  let offset = 0
  let cancelSpring: (() => void) | null = null
  // Gesture state: `source` is null between gestures.
  let source: Source | null = null
  let pointerId: number | null = null
  let startOffset = 0
  let baseY = 0
  let lastY = 0
  let startX = 0
  let startY = 0
  // Touch only: `owner` once the sheet (not the content) holds the gesture,
  // `dead` once the gesture is known to be somebody else's.
  let owner = false
  let dead = false
  let target: EventTarget | null = null

  function setMotion(transform: string, transition: string): void {
    const el = options.panel.value
    if (!el) return
    el.style.transition = transition
    el.style.transform = transform
  }

  function show(raw: number): void {
    offset = raw >= 0 ? raw : -rubberBand(-raw, RUBBER_LIMIT_PX)
    setMotion(offset === 0 ? '' : `translate3d(0, ${offset}px, 0)`, 'none')
  }

  function stopSpring(): void {
    cancelSpring?.()
    cancelSpring = null
  }

  function begin(y: number, t: number): void {
    stopSpring()
    startOffset = offset
    baseY = lastY = y
    tracker.reset()
    tracker.push(y, t)
  }

  function move(y: number, t: number): void {
    lastY = y
    tracker.push(y, t)
    // Undo the rubber band so the raw finger travel stays linear.
    show(startOffset + (y - baseY))
  }

  function settle(velocityPxPerMs: number): void {
    if (offset === 0) {
      setMotion('', '')
      return
    }
    if (prefersReducedMotion()) {
      offset = 0
      setMotion('', '')
      return
    }
    cancelSpring = springTo(
      offset,
      velocityPxPerMs * 1000,
      (value) => {
        offset = value
        setMotion(value === 0 ? '' : `translate3d(0, ${value}px, 0)`, 'none')
      },
      () => {
        cancelSpring = null
        setMotion('', '')
      },
    )
  }

  function release(): void {
    const velocity = tracker.velocity()
    const height = options.panel.value?.offsetHeight ?? 0
    const closeAt = Math.min(CLOSE_DISTANCE_MAX_PX, height * 0.25)
    if (offset > 0 && (offset > closeAt || velocity > CLOSE_VELOCITY_PX_PER_MS)) {
      if (options.onRelease()) {
        setMotion(
          'translate3d(0, 100%, 0)',
          'transform var(--velo-dur-sheet-exit) var(--velo-ease-in)',
        )
        return
      }
    }
    settle(velocity)
  }

  function finish(): void {
    source = null
    pointerId = null
    owner = false
    dead = false
    target = null
  }

  // -- grab zone (pointer) ---------------------------------------------------

  function onGrabDown(e: PointerEvent): void {
    if (source !== null || (e.pointerType === 'mouse' && e.button !== 0)) return
    source = 'grab'
    pointerId = e.pointerId
    begin(e.clientY, e.timeStamp)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  function onGrabMove(e: PointerEvent): void {
    if (source !== 'grab' || e.pointerId !== pointerId) return
    move(e.clientY, e.timeStamp)
  }

  function onGrabEnd(e: PointerEvent): void {
    if (source !== 'grab' || e.pointerId !== pointerId) return
    finish()
    release()
  }

  function onGrabCancel(e: PointerEvent): void {
    if (source !== 'grab' || e.pointerId !== pointerId) return
    finish()
    settle(0)
  }

  // -- panel body (touch) ----------------------------------------------------

  function onTouchStart(e: TouchEvent): void {
    const touch = e.touches[0]
    const el = e.target instanceof Element ? e.target : null
    if (source !== null || e.touches.length !== 1 || !touch) return
    // The grab zone has its own pointer path; controls with their own drag keep it.
    if (el?.closest(GRAB_ZONE) || el?.closest(OWN_GESTURE)) return
    source = 'touch'
    target = e.target
    startX = touch.clientX
    startY = touch.clientY
    begin(touch.clientY, e.timeStamp)
  }

  function onTouchMove(e: TouchEvent): void {
    const touch = e.touches[0]
    const panel = options.panel.value
    if (source !== 'touch' || dead || !touch || !panel) return
    if (!owner) {
      const dy = touch.clientY - startY
      const dx = touch.clientX - startX
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > TOUCH_SLOP_PX) {
        dead = true
        return
      }
      // Finger still going up or not yet moved: the content's gesture.
      if (touch.clientY - lastY <= 0 || dy <= TOUCH_SLOP_PX) {
        lastY = touch.clientY
        return
      }
      if (!atScrollTop(target, panel)) {
        lastY = touch.clientY
        return
      }
      owner = true
      // The sheet starts here, not at the touch-down point: no jump.
      begin(touch.clientY, e.timeStamp)
    }
    const raw = startOffset + (touch.clientY - baseY)
    if (raw < 0 && panel.scrollHeight > panel.clientHeight) {
      // Pulled back up past the start with a scrollable panel: give the swipe back.
      owner = false
      offset = 0
      setMotion('', 'none')
      lastY = touch.clientY
      return
    }
    if (e.cancelable) e.preventDefault()
    move(touch.clientY, e.timeStamp)
  }

  function onTouchEnd(): void {
    if (source !== 'touch') return
    const wasOwner = owner
    finish()
    if (wasOwner) release()
  }

  function onTouchCancel(): void {
    if (source !== 'touch') return
    const wasOwner = owner
    finish()
    if (wasOwner) settle(0)
  }

  onUnmounted(stopSpring)

  return {
    onGrabDown,
    onGrabMove,
    onGrabEnd,
    onGrabCancel,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel,
  }
}
