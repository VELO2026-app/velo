<!--
  VELO Frontend -- WeekStrip (Calendar iteration, frame 1; slider pass, 2026-08-27)

  Horizontal week selector for the Calendar screen:
    - 5 visible day pills (weekday label + day number + dot marker) and a
      STATIONARY month chip as the 6th column -- day pills scroll UNDER it
      (the month(s) of the visible span: "Авг" or "Авг-Сен")
    - Selected day filled with the primary color
    - [owner pass] No prev/next arrows anymore -- the drag IS the navigation
    - [slider pass] THE STRIP IS A DRAG CAROUSEL: pointer down on the days
      and the week follows the finger/cursor; release past the threshold
      commits the shift, release short of it springs back. Day taps still
      select; a tap that was part of a drag is swallowed.

  Dumb component: the parent (CalendarView via useCalendarStore) owns the
  week data and selection. This just renders and emits.

  Slider mechanics (day ribbon):
    - Pointer Events (iOS 13+), touch-action: pan-y -- the horizontal axis
      belongs to the drag, vertical scrolls pass through to the page.
    - The strip renders a DAY RIBBON (props.days[0] -14 .. +27), not just the
      7 visible days: dragging slides days through the viewport ONE BY ONE --
      new day pills appear at the leading edge, trailing ones leave. Release
      snaps to the NEAREST WHOLE DAY (round), commits via `shift-days` with
      the day delta, the store re-anchors `days`, and the ribbon resets to
      translate 0 -- same content, no jump painted.
    - Back limit is DAY-GRANULAR (maxBackDays): at today the strip
      rubber-bands (0.35x) and never commits backwards. Forward is bounded
      only by the ribbon's rendered headroom (~3 weeks per gesture).
    - Markers (dots) exist only for the loaded week; ribbon days beyond it
      show no dot until the snap lands and the store loads that week.

  Usage:
    <WeekStrip
      :days="store.days"
      :selected-date="store.selectedDate"
      :days-with-practices="store.daysWithPractices"
      :local-date-key="store.localDateKey"
      :max-back-days="store.maxBackDays"
      @select-day="store.selectDay"
      @shift-days="store.shiftDays"
    />
-->

<template>
  <div class="week-strip">
    <div
      ref="viewportEl"
      class="week-strip__viewport"
      :class="{ 'week-strip__viewport--dragging': pointerDown }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
    >
      <div
        class="week-strip__days"
        :class="{ 'week-strip__days--anim': animating }"
        :style="{ transform: trackTransform }"
      >
        <button
          v-for="cell in cells"
          :key="cell.key"
          type="button"
          class="week-strip__day"
          :class="{ 'week-strip__day--active': cell.key === selectedDate }"
          @click="onDayClick(cell.key)"
        >
          <span class="week-strip__weekday">{{ cell.weekday }}</span>
          <span class="week-strip__num">{{ cell.num }}</span>
          <span
            class="week-strip__dot"
            :class="{ 'week-strip__dot--visible': cell.hasPractices }"
          />
        </button>
      </div>

      <!-- [owner pass] The STATIONARY month chip: the 6th column. Day pills
           scroll UNDER it (it is opaque and floats above the track); it never
           moves. The calendar icon sits at the WEEKDAY ROW's level (the chip
           and the day pills share the same top padding, so the rows line up);
           the month(s) of the five visible days are centred below it -- one
           line, or TWO stacked lines while the window straddles a month
           border. pointer-events none: taps/drags pass through to the ribbon
           below, so the whole strip stays one gesture surface. -->
      <div class="week-strip__month-chip" aria-hidden="true">
        <IconCalendar :size="14" />
        <div class="week-strip__month-chip-months">
          <span v-for="m in monthList" :key="m">{{ m }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { IconCalendar } from '@/components/icons'

const props = defineProps<{
  /** The 7 day-Dates of the current window (today-anchored). */
  days: Date[]
  /** Selected day key (YYYY-MM-DD, local). */
  selectedDate: string
  /** Set of local-day keys that have at least one practice. */
  daysWithPractices: Set<string>
  /** Local-day key formatter (shared with the store). */
  localDateKey: (d: Date) => string
  /** [ribbon] How many days back the window may move (0 = starts today). */
  maxBackDays: number
}>()

const emit = defineEmits<{
  'select-day': [dateKey: string]
  /** [ribbon] Day-granular commit from the drag (whole days, already clamped). */
  'shift-days': [delta: number]
}>()

// Short Russian weekday labels, Monday-first (Date.getDay: 0=Sun..6=Sat).
const WEEKDAY_LABELS = ['ВС', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ']

// [owner pass] Short Russian month abbreviations -- the STATIONARY 6th chip
// shows the month(s) of the five visible days ("Авг" / "Авг-Сен").
const MONTH_ABBR = [
  'Янв',
  'Фев',
  'Мар',
  'Апр',
  'Май',
  'Июн',
  'Июл',
  'Авг',
  'Сен',
  'Окт',
  'Ноя',
  'Дек',
]

interface Cell {
  key: string
  weekday: string
  num: number
  hasPractices: boolean
}

const cells = computed<Cell[]>(() => {
  const first = props.days[0]
  if (!first) return []
  const out: Cell[] = []
  for (let i = -beforeDays.value; i <= RIBBON_AFTER; i++) {
    const d = new Date(first)
    d.setDate(d.getDate() + i)
    const key = props.localDateKey(d)
    out.push({
      key,
      weekday: WEEKDAY_LABELS[d.getDay()]!,
      num: d.getDate(),
      hasPractices: props.daysWithPractices.has(key),
    })
  }
  return out
})

/**
 * [owner pass] Backward headroom actually rendered: the ribbon paints past
 * days ONLY while the window is past today (maxBackDays > 0). At the start
 * (window == today) there is NOTHING before day 0 -- dragging back meets a
 * rubber wall with no content sliding in from the left: you cannot scroll
 * past today, not even visually.
 */
const beforeDays = computed(() => Math.min(-RIBBON_BEFORE, props.maxBackDays))

/**
 * [owner pass] The track's transform. `offset` is the DRAG delta relative to
 * REST -- but rest is NOT translate 0: the ribbon renders `beforeDays` of
 * backward headroom before the window, so at rest the track must be shifted
 * right by exactly that many strides for day 0 to sit in column 0. The
 * baseline lives in CSS (container-query units), so the pill stride and the
 * baseline can never disagree with the layout.
 */
const trackTransform = computed(
  // screen(i) = i*stride + T; day 0 (array index `beforeDays`) must sit at
  // column 0 -> T_rest = -beforeDays*stride. The sign is load-bearing: with
  // +, every forward commit grows beforeDays and drifts the resting ribbon
  // a stride further right -- the "ribbon flies away under the month chip".
  () => `translateX(${offset.value - beforeDays.value * stridePx.value}px)`,
)

/**
 * [owner pass] The stationary month chip's month lines: the months of the
 * five VISIBLE day pills (columns 0..4). Derives from the live offset -- the
 * day the leftmost visible column shows is round(-offset / stride) -- so the
 * label follows the drag and flips exactly when the visible span crosses a
 * month border. Equal months collapse to ONE line; a straddling span stacks
 * TWO lines (Авг over Сен) -- never a dashed "Авг-Сен".
 */
const monthList = computed<string[]>(() => {
  const base = props.days[0]
  if (!base) return []
  const left = Math.round(-offset.value / stridePx.value)
  const a = new Date(base)
  a.setDate(a.getDate() + left)
  const b = new Date(a)
  b.setDate(a.getDate() + 4)
  const ma = MONTH_ABBR[a.getMonth()]!
  const mb = MONTH_ABBR[b.getMonth()]!
  return ma === mb ? [ma] : [ma, mb]
})

// -- [slider pass] Day-ribbon drag carousel -----------------------------------
//
// pointerDown: finger/cursor is down (transition off, ribbon tracks 1:1).
// animating:   a snap/commit phase owns the transform (transition on).
// busy:        a commit is running -- new gestures ignored.
// offset:      live translateX in px (negative = later days in view).
const ANIM_MS = 220
/** Horizontal dominance that locks the drag axis (below it, taps/scrolls win). */
const AXIS_LOCK_PX = 10
/** Resistance past a clamped edge -- the ribbon yields, but never commits. */
const RUBBER_BAND = 0.35
/** Ribbon rendered range, in days around props.days[0]. Back = drag headroom
 *  before today's limit; forward = ~3 weeks per gesture, re-anchored each commit. */
const RIBBON_BEFORE = -14
const RIBBON_AFTER = 27
/** Max whole-day forward shift the rendered headroom allows. Five day
 *  columns are visible (the 6th is the stationary month chip), so the last
 *  visible index 4+k must stay <= RIBBON_AFTER. */
const MAX_FWD_DAYS = RIBBON_AFTER - 4
/** Mirrors the CSS gap between day pills (5px). */
const DAY_GAP_PX = 5
/** Fallback stride when there is no layout (tests): a plausible day width. */
const DAY_STRIDE_FALLBACK = 50

const viewportEl = ref<HTMLElement | null>(null)
const offset = ref(0)
const pointerDown = ref(false)
const animating = ref(false)
let busy = false
let startX = 0
let startY = 0
// Drag axis once locked: null = undecided, 'x' = horizontal (ours). A
// vertical intent never locks -- it releases the pointer to the page scroll.
let axis: 'x' | null = null
let suppressClick = false
// Release velocity (px/ms) from the last two moves -- a flick commits even
// from a short travel; a slow drag must cross half a stride to commit.
let velocity = 0
let lastMoveT = 0
let lastMoveDx = 0

/** One day's stride: pill width + gap. Kept in a ref and refreshed by the
 *  ResizeObserver (below) -- the drag handlers and the month chip read it on
 *  EVERY pointermove, and a live querySelector/offsetWidth there is a
 *  forced-layout read after a style write = layout thrashing = the "ribbon
 *  lags while dragging" bug. */
const stridePx = ref(DAY_STRIDE_FALLBACK)

function measureStride(): void {
  const vp = viewportEl.value
  if (!vp || vp.clientWidth === 0) return
  // ONE source of truth: the day width is computed here and published as a
  // CSS var consumed by the pills, the month chip AND this component's own
  // stride/baseline math. No container-query units anywhere -- cqw inside
  // calc() silently misresolves on the target WebKit, and a CSS/JS geometry
  // disagreement is exactly the "snaps land between days" device bug.
  const w = (vp.clientWidth - 5 * DAY_GAP_PX) / 6
  vp.style.setProperty('--week-strip-day-w', `${w}px`)
  stridePx.value = w + DAY_GAP_PX
}

// Re-measured by the ResizeObserver below whenever the viewport's real
// width changes (island settling, orientation, keyboard). NEVER at gesture
// start: a mid-interaction re-measure swaps the pills' width under the
// finger and the visible day jumps -- the "it scrolls somewhere by itself"
// device bug.
let vpObserver: ResizeObserver | null = null

onMounted(() => {
  // Double-rAF: post-layout first paint; the observer keeps it true after.
  requestAnimationFrame(() => requestAnimationFrame(measureStride))
  vpObserver = new ResizeObserver(measureStride)
  if (viewportEl.value) vpObserver.observe(viewportEl.value)
})

onBeforeUnmount(() => {
  vpObserver?.disconnect()
  vpObserver = null
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function onPointerDown(e: PointerEvent): void {
  if (busy || e.button !== 0) return
  pointerDown.value = true
  animating.value = false
  offset.value = 0
  axis = null
  suppressClick = false
  velocity = 0
  lastMoveT = 0
  lastMoveDx = 0
  startX = e.clientX
  startY = e.clientY
  // Capture keeps up/cancel flowing to us even when the pointer leaves.
  viewportEl.value?.setPointerCapture?.(e.pointerId)
}

function onPointerMove(e: PointerEvent): void {
  if (!pointerDown.value) return
  const dx = e.clientX - startX
  const dy = e.clientY - startY

  if (axis === null) {
    if (Math.abs(dx) >= AXIS_LOCK_PX && Math.abs(dx) > Math.abs(dy)) {
      axis = 'x'
    } else if (Math.abs(dy) >= AXIS_LOCK_PX) {
      // Vertical intent: hand the gesture to the page (touch-action: pan-y
      // already did on touch; this covers mouse drags alike).
      releasePointer(e)
      return
    }
    // Not locked yet (a mere jitter): nothing to translate.
    if (axis !== 'x') return
  }

  // Day-granular clamps: back is limited by maxBackDays (today) AND by the
  // rendered backward headroom (beforeDays -- which is itself capped by
  // maxBackDays, so at today the wall is at ZERO: nothing renders before
  // day 0); forward by the forward headroom. Past an edge the ribbon
  // rubber-bands and never commits beyond the limit.
  const stride = stridePx.value
  const backPx = beforeDays.value * stride
  const fwdPx = MAX_FWD_DAYS * stride
  let gated = dx
  if (dx > backPx) gated = backPx + (dx - backPx) * RUBBER_BAND
  else if (dx < -fwdPx) gated = -fwdPx + (dx + fwdPx) * RUBBER_BAND
  offset.value = gated
  if (Math.abs(gated) >= AXIS_LOCK_PX) suppressClick = true

  // Track the release velocity (guarded against same-tick moves).
  const t = performance.now()
  if (t > lastMoveT) velocity = (dx - lastMoveDx) / (t - lastMoveT)
  lastMoveT = t
  lastMoveDx = dx
}

function onPointerUp(e: PointerEvent): void {
  if (!pointerDown.value) return
  releasePointer(e)

  if (axis !== 'x') {
    snapBack()
    return
  }
  // Snap to the nearest WHOLE DAY (dragging left = negative offset = later
  // days = positive delta), clamped to the day limits (backward: the
  // rendered headroom, which is already <= the today limit). A FLICK
  // (fast release) commits in its direction from a short travel too -- a
  // slow drag below half a stride springs back, so nothing ever "scrolls
  // somewhere by itself".
  const stride = stridePx.value
  let k = Math.round(-offset.value / stride)
  const flicked = Math.abs(velocity) >= 0.4 && Math.abs(offset.value) >= AXIS_LOCK_PX * 2
  if (k === 0 && flicked) k = velocity < 0 ? 1 : -1
  const clamped = Math.max(-beforeDays.value, Math.min(MAX_FWD_DAYS, k))
  if (clamped !== 0) void commitDays(clamped)
  else snapBack()
}

function onPointerCancel(e: PointerEvent): void {
  if (!pointerDown.value) return
  releasePointer(e)
  snapBack()
}

function releasePointer(e: PointerEvent): void {
  pointerDown.value = false
  viewportEl.value?.releasePointerCapture?.(e.pointerId)
}

/** Spring back to rest; the transition class lifts itself when done. */
function snapBack(): void {
  if (offset.value === 0) {
    animating.value = false
    return
  }
  animating.value = true
  offset.value = 0
  setTimeout(() => {
    if (!pointerDown.value) animating.value = false
  }, ANIM_MS)
}

/**
 * Day-granular commit for a DRAG release: animate to the snapped day stride,
 * then emit `shift-days` (the store re-anchors `days` by exactly that many
 * days -- synchronously), and reset the translate to 0 in the same paint:
 * the re-rendered ribbon shows the same visible days, so nothing jumps.
 */
async function commitDays(k: number): Promise<void> {
  busy = true
  const stride = stridePx.value
  animating.value = true
  offset.value = -k * stride
  await sleep(ANIM_MS)

  emit('shift-days', k)
  await nextTick()

  animating.value = false
  offset.value = 0
  busy = false
}

/** A day tap selects; a tap that was really a drag release is swallowed. */
function onDayClick(dateKey: string): void {
  if (suppressClick) return
  emit('select-day', dateKey)
}
</script>

<style scoped>
/* Single wrapper: the viewport owns the gesture surface; the old column
   flex + gap existed for the arrow row that is gone (owner pass). */
.week-strip {
  display: block;
}

/* [ribbon] The moving track is WIDER than the viewport: days flow through
   one by one and disappear UNDER the stationary month chip (the 6th
   column). The day width is a CSS var SET FROM JS (measureStride) -- pills,
   chip and the drag math all read the same number; the fallback only paints
   the first frame before the measurement lands. */
.week-strip__viewport {
  overflow: hidden;
  touch-action: pan-y;
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
  position: relative;
}

.week-strip__viewport--dragging {
  cursor: grabbing;
}

.week-strip__days {
  display: flex;
  /* Figma 2266:2307 — gap между day-pills = 5px, не --space-2 (8). */
  gap: var(--velo-card-gap-icon-title);
  width: max-content;
  /* The slider's moving part. The transition lives on the --anim modifier
     (snap/commit phases only) -- during a raw drag it is OFF so the ribbon
     tracks the finger 1:1. */
  will-change: transform;
}

.week-strip__days--anim {
  transition: transform 220ms ease;
}

.week-strip__day {
  /* 1/6 of the viewport (five day columns + the month chip's column),
     measured once per gesture by JS. No cqw: container-query units in
     flex-basis calc silently misresolve on the target WebKit. */
  flex: 0 0 var(--week-strip-day-w, 53px);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  /* Figma: 44x71 rounded-15 white pill (not a full-round circle). */
  padding: var(--space-3) 0;
  border: 1px solid var(--velo-glass-border);
  background: var(--velo-white);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.week-strip__day:hover {
  opacity: 0.85;
}

.week-strip__day--active {
  background: var(--velo-primary);
  border-color: var(--velo-primary);
}

.week-strip__weekday {
  font-family: var(--font-body);
  font-size: var(--text-10);
  color: var(--velo-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.week-strip__num {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  line-height: 1.2;
}

.week-strip__day--active .week-strip__weekday,
.week-strip__day--active .week-strip__num {
  color: var(--velo-white);
}

/* Dot marker: reserves space always; visible only when day has practices. */
.week-strip__dot {
  width: 4px;
  height: 4px;
  border-radius: var(--radius-full);
  background: transparent;
}

.week-strip__dot--visible {
  background: var(--velo-primary);
}

.week-strip__day--active .week-strip__dot--visible {
  background: var(--velo-white);
}

/* [owner pass] The STATIONARY month chip: the 6th column, pinned to the
   viewport's right edge. Opaque (day pills must vanish beneath it, not show
   through), pill-shaped to read as one of the six, floating a hair above
   the track (z + soft shadow). Pointer-transparent: the ribbon below stays
   the one gesture surface. */
.week-strip__month-chip {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  /* Same JS-measured day width the pills use -- one geometry, one source. */
  width: var(--week-strip-day-w, 53px);
  /* [owner pass] The icon sits at the WEEKDAY ROW's level: the chip shares
     the day pill's top padding, so row 1 lines up across all six columns.
     The month block fills the rest and centres itself there. */
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--space-3) 0;
  box-sizing: border-box;
  border: 1px solid var(--velo-glass-border);
  /* [owner pass] Left corners follow the day pills; the RIGHT corners are
     square -- the chip is flush with the strip's right edge, and a rounded
     corner there framed visible gaps against the screen edge. */
  border-radius: var(--radius-md);
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
  background: var(--velo-bg-card-solid);
  z-index: 1;
  pointer-events: none;
}

.week-strip__month-chip svg {
  color: var(--velo-text-secondary);
}

/* One month = one centred line; a month border = TWO stacked lines (Авг
   over Сен), one month per line -- the strip is too narrow for a dashed
   pair on a single row. */
.week-strip__month-chip-months {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  min-height: 0;
}

.week-strip__month-chip-months span {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  line-height: 1.1;
  white-space: nowrap;
}
</style>
