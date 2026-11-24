// =============================================================================
// @velo/ui -- VBottomSheet drag controller (FE-233, package 2)
// =============================================================================
//
// Owns the swipe of a bottom sheet panel. Two entry points share one state:
//
//  - the grab zone (handle + title): pointer events, mouse and touch alike;
//    the zone is touch-action:none, so the page never scrolls under it.
//  - the rest of the panel: touch events. WHO owns the gesture is decided
//    once, at touchstart: the sheet may claim it only if nothing under the
//    finger is scrolled away from its top. (iOS cannot cancel a touchmove
//    once native scrolling has begun, so the owner can never change mid-way
//    to the sheet.) A claimable gesture is claimed by the first downward move
//    and handed to the content for good by a move up past the start.
//
// While the finger drags, the panel follows 1:1 downward and with rubber-band
// resistance upward. On release: past a quarter of the panel (capped) or
// flicked down -> `onRelease` is asked to close; otherwise (or when it
// refuses) the panel springs back from where it was, with the finger's own
// velocity. A touch that does not claim the gesture never interrupts a
// running spring.
//
// Touch handling follows the idea of the drawer in Vercel's UI SDK
// (https://github.com/vercel-labs/ui, Apache-2.0): an independent
// re-implementation for Vue 3, not a copy.
// =============================================================================

import { onUnmounted, watch, type Ref } from 'vue'
import { hasOwnTouchGesture, prefersReducedMotion } from './platform/dom'
import { createVelocityTracker, rubberBand, springTo } from './sheetGesture'

const CLOSE_DISTANCE_MAX_PX = 160
const CLOSE_VELOCITY_PX_PER_MS = 0.5
/** Pull-up resistance asymptote: the panel never leaves its place by more than this. */
const RUBBER_LIMIT_PX = 72
/** Vertical travel before a touch gesture is classified, px. */
const TOUCH_SLOP_PX = 4
const GRAB_ZONE = '.v-sheet__handle, .v-sheet__title'
/** A native range input runs its own drag. */
const RANGE_INPUT = 'input[type="range"]'

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

/** Who holds the current gesture. */
type Holder =
  /** No finger down. */
  | 'none'
  /** The grab zone's pointer: the sheet holds it from the first contact. */
  | 'grab-pointer'
  /** A touch on the body that the sheet may still claim. */
  | 'touch-claimable'
  /** A touch on the body that the sheet has claimed: the panel follows it. */
  | 'touch-sheet'
  /** A touch on the body that belongs to the content until it lifts. */
  | 'touch-content'

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

/** True when `from` or an ancestor below `panel` runs its own drag. */
function runsOwnDrag(from: Element, panel: HTMLElement): boolean {
  if (from.closest(RANGE_INPUT)) return true
  for (let el: Element | null = from; el && el !== panel; el = el.parentElement) {
    if (hasOwnTouchGesture(el)) return true
  }
  return false
}

/**
 * Wire the swipe of a bottom sheet panel.
 *
 * @param options - See `SheetDragOptions`.
 * @returns Event handlers for the template.
 */
export function useSheetDrag(options: SheetDragOptions): SheetDrag {
  const tracker = createVelocityTracker()
  /** The panel's displayed offset, px (after the rubber band). */
  let shownOffset = 0
  /** The same offset before the rubber band: where a new drag continues from. */
  let rawOffset = 0
  let cancelSpring: (() => void) | null = null

  let holder: Holder = 'none'
  let grabPointerId: number | null = null
  let touchStartX = 0
  let touchStartY = 0
  let touchTarget: EventTarget | null = null
  /** Finger Y where the current drag began; the panel follows the travel from here. */
  let dragFromY = 0
  let dragFromOffset = 0
  let lastFingerY = 0
  /** The finger has moved since the drag began (a bare tap never closes). */
  let moved = false

  function moveTo(px: number, transition = 'none'): void {
    const el = options.panel.value
    if (!el) return
    el.style.transition = transition
    el.style.transform = px === 0 ? '' : `translate3d(0, ${px}px, 0)`
  }

  function show(raw: number): void {
    rawOffset = raw
    shownOffset = raw >= 0 ? raw : -rubberBand(-raw, RUBBER_LIMIT_PX)
    moveTo(shownOffset)
  }

  function stopSpring(): void {
    cancelSpring?.()
    cancelSpring = null
  }

  function resetPosition(): void {
    stopSpring()
    shownOffset = 0
    rawOffset = 0
  }

  function beginDrag(y: number, t: number): void {
    stopSpring()
    dragFromOffset = rawOffset
    dragFromY = lastFingerY = y
    moved = false
    tracker.reset()
    tracker.push(y, t)
  }

  function dragTo(y: number, t: number): void {
    lastFingerY = y
    moved = true
    tracker.push(y, t)
    show(dragFromOffset + (y - dragFromY))
  }

  function springBack(velocityPxPerMs: number): void {
    if (shownOffset === 0 || prefersReducedMotion()) {
      shownOffset = rawOffset = 0
      moveTo(0, '')
      return
    }
    cancelSpring = springTo(
      shownOffset,
      velocityPxPerMs * 1000,
      (value) => {
        shownOffset = rawOffset = value
        moveTo(value)
      },
      () => {
        cancelSpring = null
        moveTo(0, '')
      },
    )
  }

  function slideOut(): void {
    const el = options.panel.value
    if (!el) return
    el.style.transition = 'transform var(--velo-dur-sheet-exit) var(--velo-ease-in)'
    el.style.transform = 'translate3d(0, 100%, 0)'
  }

  /** The finger lifted at time `t`: close the sheet or spring back. */
  function release(t: number): void {
    // The lift is a sample too: a finger held still before lifting reads as slow.
    tracker.push(lastFingerY, t)
    const velocity = tracker.velocity()
    const height = options.panel.value?.offsetHeight ?? 0
    const closeAt = Math.min(CLOSE_DISTANCE_MAX_PX, height * 0.25)
    const pastThreshold = shownOffset > closeAt || velocity > CLOSE_VELOCITY_PX_PER_MS
    if (moved && shownOffset > 0 && pastThreshold && options.onRelease()) {
      slideOut()
      resetPosition()
      return
    }
    springBack(velocity)
  }

  function endGesture(): void {
    holder = 'none'
    grabPointerId = null
    touchTarget = null
  }

  // -- grab zone (pointer) ---------------------------------------------------

  function onGrabDown(e: PointerEvent): void {
    if (holder !== 'none' || (e.pointerType === 'mouse' && e.button !== 0)) return
    holder = 'grab-pointer'
    grabPointerId = e.pointerId
    beginDrag(e.clientY, e.timeStamp)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  function onGrabMove(e: PointerEvent): void {
    if (holder !== 'grab-pointer' || e.pointerId !== grabPointerId) return
    dragTo(e.clientY, e.timeStamp)
  }

  function onGrabEnd(e: PointerEvent): void {
    if (holder !== 'grab-pointer' || e.pointerId !== grabPointerId) return
    endGesture()
    release(e.timeStamp)
  }

  function onGrabCancel(e: PointerEvent): void {
    if (holder !== 'grab-pointer' || e.pointerId !== grabPointerId) return
    endGesture()
    springBack(0)
  }

  // -- panel body (touch) ----------------------------------------------------

  function onTouchStart(e: TouchEvent): void {
    const touch = e.touches[0]
    const panel = options.panel.value
    const el = e.target instanceof Element ? e.target : null
    if (holder !== 'none' || e.touches.length !== 1 || !touch || !panel || !el) return
    // The grab zone has its own pointer path; a control with its own drag keeps it.
    if (el.closest(GRAB_ZONE) || runsOwnDrag(el, panel)) return
    touchTarget = e.target
    touchStartX = touch.clientX
    touchStartY = lastFingerY = touch.clientY
    // Decided here, once: content scrolled away from its top keeps the gesture.
    holder = atScrollTop(touchTarget, panel) ? 'touch-claimable' : 'touch-content'
  }

  function onTouchMove(e: TouchEvent): void {
    const touch = e.touches[0]
    const panel = options.panel.value
    if (!touch || !panel) return
    if (holder === 'touch-claimable') {
      const dx = touch.clientX - touchStartX
      const dy = touch.clientY - touchStartY
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > TOUCH_SLOP_PX) {
        holder = 'touch-content'
      } else if (dy < -TOUCH_SLOP_PX) {
        holder = 'touch-content'
      } else if (dy > TOUCH_SLOP_PX) {
        holder = 'touch-sheet'
        beginDrag(touch.clientY, e.timeStamp)
      }
    }
    if (holder !== 'touch-sheet') return
    const raw = dragFromOffset + (touch.clientY - dragFromY)
    if (raw < 0 && panel.scrollHeight > panel.clientHeight) {
      // Pulled back up past the start with a scrollable panel: the content takes it.
      holder = 'touch-content'
      show(0)
      return
    }
    if (e.cancelable) e.preventDefault()
    dragTo(touch.clientY, e.timeStamp)
  }

  function onTouchEnd(e: TouchEvent): void {
    const heldBySheet = holder === 'touch-sheet'
    if (holder === 'none' || holder === 'grab-pointer') return
    endGesture()
    if (heldBySheet) release(e.timeStamp)
  }

  function onTouchCancel(): void {
    const heldBySheet = holder === 'touch-sheet'
    if (holder === 'none' || holder === 'grab-pointer') return
    endGesture()
    if (heldBySheet) springBack(0)
  }

  // A new panel element (the sheet reopened) starts at rest.
  watch(options.panel, resetPosition)
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
