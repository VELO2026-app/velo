<!--
  VELO Frontend -- MoodSlider (FE-85 unified scale, tz-mood-scale.md)

  The ONE 1..10 scale shared by CheckinView (mood) and FeedbackView (rating).
  Five approved faces, two scores each: 1-2 Плохо / 3-4 Не очень / 5-6
  Нормально / 7-8 Хорошо / 9-10 Огонь. The numeric contract + labels live in
  utils/moodScale.ts, the key -> face binding in utils/ratingIcons.ts; this
  component owns only the INTERACTION. CheckinView sends the score as `mood`,
  FeedbackView as `rating` -- emotion keys never reach the server (tz §5).

  Three equal ways to answer (tz §2):
    - drag / tap the native range  -> the EXACT number (1/3/5/7/9 stay exact);
    - tap a card                   -> the pair's top score (2/4/6/8/10);
    - swipe the card strip         -> the nearest card centers, same top score.
  All three derive from ONE controlled `modelValue`, so they never disagree
  after a gesture (tz §2.2, §4).

  Cards are a real single-choice radiogroup (roving tabindex; arrows / Home /
  End move the selection). The range keeps its native slider semantics and
  carries the exact aria-valuetext «5 из 10 — Нормально» (tz §8).

  Touch: the stage owns the gesture (touch-action: none) -- a press-and-drag
  tracks the finger 1:1 on both axes, with no mid-gesture handoff to page
  scroll. The form keeps scrolling everywhere else. A release that never
  crossed the slop is a tap and selects the face it landed on. A finished
  horizontal drag swallows the synthetic click the browser still fires on the
  card under the pointer (tz §8).
-->
<template>
  <div class="mood-slider">
    <!-- Carousel: five faces as an OVERLAPPING deck (tz §3) -- the active card
         sits centered, on top, sharp and whole; nearest neighbors are ~20%
         smaller, blurred and dimmed with their inner edges hidden BEHIND the
         active card; far cards smaller yet, behind the neighbors, cropped by
         the stage edges. Cards are absolutely positioned (no flex layout);
         the geometry lives in cardStyle() + the CSS vars below. -->
    <div
      class="mood-slider__strip"
      :class="{ 'mood-slider__strip--dragging': dragging }"
      role="radiogroup"
      :aria-label="resolvedAriaLabel"
      @pointerdown="onPointerDown"
    >
      <button
        v-for="(emotion, i) in EMOTIONS"
        :key="emotion.key"
        :ref="(el) => setCardRef(el, i)"
        :data-index="i"
        draggable="false"
        type="button"
        class="mood-slider__card"
        :class="cardTierClass(i)"
        :style="cardStyle(i)"
        role="radio"
        :aria-checked="i === activeIndex"
        :tabindex="!disabled && i === activeIndex ? 0 : -1"
        :disabled="disabled"
        @click="onCardClick(i)"
        @keydown="onCardKeydown($event, i)"
      >
        <component :is="emotion.icon" :size="FACE_SIZE" class="mood-slider__face" />
        <span class="mood-slider__label">{{ emotion.label }}</span>
      </button>
    </div>

    <!-- Track + thumb. The native range sits on top (transparent) so drag /
         tap / keyboard all work and stay accessible (tz §2.1). -->
    <div class="mood-slider__track-wrap">
      <div class="mood-slider__track" />
      <div class="mood-slider__thumb" :style="{ left: `${thumbPercent}%` }" />
      <input
        class="mood-slider__input"
        type="range"
        :min="MOOD_SCALE_MIN"
        :max="MOOD_SCALE_MAX"
        :step="1"
        :value="modelValue"
        :disabled="disabled"
        :aria-label="resolvedAriaLabel"
        :aria-valuemin="MOOD_SCALE_MIN"
        :aria-valuemax="MOOD_SCALE_MAX"
        :aria-valuenow="clampedScore"
        :aria-valuetext="valueText"
        @input="onRangeInput"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { offWindowEvent, onWindowEvent } from '@/platform/dom'
import {
  MOOD_SCALE_MAX,
  MOOD_SCALE_MIN,
  MOOD_SCALE_KEYS,
  MOOD_SCALE_LABELS,
  clampMoodScore,
  moodIndexFromScore,
  moodScoreFromIndex,
  moodValueText,
} from '@/utils/moodScale'
import { MOOD_SCALE_ICON } from '@/utils/ratingIcons'

/**
 * Controlled contract (tz §4): the parent owns `modelValue`; this component
 * only emits `update:modelValue` and never mutates it. An untouched form's
 * default is the DEFAULT_SCORE (5) the parent seeds its ref with.
 */
const props = withDefaults(
  defineProps<{
    modelValue: number
    /** Accessible name -- per screen: Check-in and Feedback word the question. */
    ariaLabel?: string
    /** While the form submits, the whole scale is inert and emits nothing (tz §8). */
    disabled?: boolean
  }>(),
  { ariaLabel: 'Оценка состояния от 1 до 10', disabled: false },
)

const emit = defineEmits<{
  'update:modelValue': [value: number]
}>()

// -- geometry: the OVERLAPPING deck (tz §3) --------------------------------------
// Cards are absolutely positioned at the stage center; each one is shifted by
// K x CARD_WIDTH depending on its distance from the active card. The neighbors'
// INNER edges must land BEHIND the active card (overlap!), the far cards sit
// behind the neighbors and crop against the stage edges.
const CARD_WIDTH = 96
/** Nearest neighbors: 0.75 x card width. Their scaled half-width
 *  (48 * 0.8 = 38.4) puts the inner edge at 72 - 38.4 = 33.6 < 48 -- hidden
 *  behind the active card by ~14px of overlap. */
const NEAR_SHIFT = 0.75 * CARD_WIDTH // 72px
/** Far cards: 1.3 x card width, BEHIND the neighbors (their inner edge at
 *  125 - 31 = 94 < 110 = the neighbor's outer edge). */
const FAR_SHIFT = 1.3 * CARD_WIDTH // ~125px
/** Tier scales: active / nearest / far. */
const TIER_SCALE = [1, 0.8, 0.65] as const
/** Layer order: active -> neighbors -> far cards. */
const TIER_Z = [10, 9, 8] as const
/** Per-tier slide from the stage centerline. */
/** Rendered face size -- scales with its CARD now, no inner face scaling. */
const FACE_SIZE = 64
/** Pointer travel (px) before the gesture commits to an axis (tz §2.2). */
const DRAG_SLOP = 8
/** One swipe "step" = the spacing between adjacent card centers. */
const SNAP_STEP = NEAR_SHIFT

const EMOTIONS = MOOD_SCALE_KEYS.map((key) => ({
  key,
  label: MOOD_SCALE_LABELS[key],
  icon: MOOD_SCALE_ICON[key],
}))

// -- state derived from the single source of truth -------------------------------

const clampedScore = computed(() => clampMoodScore(props.modelValue))
const activeIndex = computed(() => moodIndexFromScore(clampedScore.value))
const valueText = computed(() => moodValueText(clampedScore.value))
const resolvedAriaLabel = computed(() => props.ariaLabel ?? 'Оценка состояния от 1 до 10')
// Thumb position across the track: score 1 -> 0%, score 10 -> 100%.
const thumbPercent = computed(
  () => ((clampedScore.value - MOOD_SCALE_MIN) / (MOOD_SCALE_MAX - MOOD_SCALE_MIN)) * 100,
)

// -- the range: exact values --------------------------------------------------------

function onRangeInput(event: Event): void {
  // Disabled scales are inert on purpose (tz §8): some embedded webviews still
  // deliver synthetic input events to a :disabled control, so guard in JS too.
  if (props.disabled) return
  // The raw number IS the payload: a drag that stops on 5 sends 5 (tz §2.1).
  emit('update:modelValue', Number((event.target as HTMLInputElement).value))
}

// -- cards: tap ----------------------------------------------------------------------

/** Select `index` the way a tap/swipe does: the pair's TOP score (tz §1). */
function selectIndex(index: number): void {
  const target = Math.min(EMOTIONS.length - 1, Math.max(0, index))
  const score = moodScoreFromIndex(target)
  // Re-tapping the active card emits nothing once the stored score is already
  // that card's click value (tz §2.3). A 5 sitting on «Нормально» still snaps
  // to 6 -- only an already-exact match is a no-op.
  if (target === activeIndex.value && clampedScore.value === score) return
  emit('update:modelValue', score)
}

/** A horizontal swipe sets this; the click it produces is swallowed once. */
let suppressClick = false

function onCardClick(index: number): void {
  if (props.disabled) return
  if (suppressClick) {
    suppressClick = false
    return
  }
  selectIndex(index)
}
// Radiogroup with roving tabindex: exactly ONE card is in the tab order, so
// Tab reaches the group once and the arrows walk the choices (tz §8).
const cardRefs = ref<(HTMLElement | null)[]>([])
function setCardRef(el: unknown, index: number): void {
  cardRefs.value[index] = (el as HTMLElement | null) ?? null
}

function onCardKeydown(event: KeyboardEvent, index: number): void {
  if (props.disabled) return
  const last = EMOTIONS.length - 1
  let target: number | null = null
  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowUp':
      target = Math.min(last, index + 1)
      break
    case 'ArrowLeft':
    case 'ArrowDown':
      target = Math.max(0, index - 1)
      break
    case 'Home':
      target = 0
      break
    case 'End':
      target = last
      break
    default:
      return // Space / Enter: the button's own click -> onCardClick
  }
  event.preventDefault()
  selectIndex(target)
  cardRefs.value[target]?.focus()
}

// -- horizontal swipe + tap (tz §2.2 / §2.3) -----------------------------------
//
// setPointerCapture is deliberately NOT used: a captured browser retargets
// the release to the strip, so the click that follows a tap lands on the
// STRIP instead of the card -- taps on the faces stop selecting anything.
// Instead:
//   * the gesture streams through WINDOW listeners attached on pointerdown,
//     so a mouse drag never escapes the component mid-gesture (touch has
//     implicit capture on the down-target and bubbles anyway);
//   * a release that never locked horizontally is a TAP and is resolved HERE,
//     against the card the pointer went down on -- no reliance on the
//     browser's click (keyboard Space/Enter still uses the card's own click).

/**
 * The FRACTIONAL deck position: which card is centered right now, including
 * the in-between states while a finger drags. Cards interpolate to their tier
 * geometry from this (see cardStyle/cardTierClass), so the deck visibly PAGES
 * -- neighbors glide toward the center while the centered one slides away.
 * Mirrors `activeIndex` whenever no gesture is running.
 */
const dragPos = ref<number>(activeIndex.value)
watch(activeIndex, (v) => {
  if (!gestureActive) dragPos.value = v
})
/** True for the WHOLE pointer gesture: card transitions stay off while the
 *  finger drags, so the deck tracks it 1:1 with zero easing lag. */
const dragging = ref(false)
let gestureActive = false
let gesturePointerId = -1
let gestureStartX = 0
let gestureStartY = 0
let gestureStartTime = 0
let gestureDragged = false
/** The card the pointer went down on: a non-locked release selects it. */
let gestureDownIndex: number | null = null

/**
 * Deck placement from the FRACTIONAL distance to the centered card,
 * piecewise through the tier map (0 = center, 1 = neighbors at NEAR_SHIFT,
 * 2 = far cards at FAR_SHIFT). Tier speeds differ -- neighbors travel
 * NEAR_SHIFT per page, far cards (FAR_SHIFT - NEAR_SHIFT) -- so paging reads
 * as cards leafing through, not one glued strip being dragged.
 */
function cardStyle(index: number): Record<string, string | number> {
  const dist = index - dragPos.value
  const a = Math.abs(dist)
  const slide = a <= 1 ? a * NEAR_SHIFT : NEAR_SHIFT + (a - 1) * (FAR_SHIFT - NEAR_SHIFT)
  const scale =
    a <= 1
      ? TIER_SCALE[0] + (TIER_SCALE[1] - TIER_SCALE[0]) * a
      : TIER_SCALE[1] + (TIER_SCALE[2] - TIER_SCALE[1]) * (a - 1)
  return {
    transform: `translate(-50%, -50%) translateX(${(dist < 0 ? -1 : 1) * slide}px) scale(${scale})`,
    zIndex: TIER_Z[0] + Math.min(2, Math.round(a)),
  }
}

/** Tier look (sharp / blurred / palest) from the fractional distance. */
function cardTierClass(index: number): string {
  const t = Math.min(2, Math.round(Math.abs(index - dragPos.value)))
  return t === 0 ? 'mood-slider__card--active' : t === 1 ? 'mood-slider__card--near' : 'mood-slider__card--far'
}

function onPointerDown(event: PointerEvent): void {
  if (props.disabled || gestureActive) return
  gestureActive = true
  dragging.value = true
  gesturePointerId = event.pointerId
  gestureStartX = event.clientX
  gestureStartY = event.clientY
  gestureStartTime = event.timeStamp
  gestureDragged = false
  const card = (event.target as HTMLElement | null)?.closest<HTMLElement>('.mood-slider__card')
  gestureDownIndex = card ? Number(card.dataset.index) : null
  // Window listeners: a mouse drag that leaves the strip keeps streaming, and
  // passive move keeps the gesture cheap (we never preventDefault it).
  onWindowEvent('pointermove', onWindowPointerMove, { passive: true })
  onWindowEvent('pointerup', onWindowPointerUp)
  onWindowEvent('pointercancel', onWindowPointerCancel)
}

function onWindowPointerMove(event: PointerEvent): void {
  if (!gestureActive || event.pointerId !== gesturePointerId) return
  const dx = event.clientX - gestureStartX
  const dy = event.clientY - gestureStartY
  if (!gestureDragged) {
    if (Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return
    gestureDragged = true // the stage owns both axes (touch-action: none)
  }
  // A swipe pages AT MOST one card: the deck position is clamped to the
  // adjacent page, so even a violent flick never flings the deck to the end.
  const raw = activeIndex.value - dx / SNAP_STEP
  const lo = Math.max(0, activeIndex.value - 1)
  const hi = Math.min(EMOTIONS.length - 1, activeIndex.value + 1)
  dragPos.value = Math.min(hi, Math.max(lo, raw))
}

function onWindowPointerUp(event: PointerEvent): void {
  if (!gestureActive || event.pointerId !== gesturePointerId) return
  const elapsed = event.timeStamp - gestureStartTime
  const dx = event.clientX - gestureStartX
  const moved = gestureDragged
  const flick = moved && elapsed < 260 && Math.abs(dx) >= DRAG_SLOP
  // Capture BEFORE stopGesture(): it resets the down-card bookkeeping.
  const downIndex = gestureDownIndex
  stopGesture()

  if (!moved) {
    // TAP: select the card the pointer went down on. It becomes the active one
    // with its exact click value, so the browser's own release-click (if it
    // arrives at all) is an idempotent no-op.
    if (downIndex === null) return
    selectIndex(downIndex)
    cardRefs.value[downIndex]?.focus()
    return
  }

  // PAGING: settle on the nearest card to the fractional position; a quick
  // flick forces a single flip in the swipe's direction even from a short
  // drag, but never more than one page per gesture.
  let target = Math.round(dragPos.value)
  if (flick && target === activeIndex.value) {
    target = activeIndex.value - Math.sign(dx)
  }
  target = Math.min(EMOTIONS.length - 1, Math.max(0, target))
  if (target === activeIndex.value) {
    dragPos.value = activeIndex.value // not enough travel: spring back
    return
  }
  suppressClick = Math.abs(dx) >= DRAG_SLOP
  dragPos.value = target
  selectIndex(target)
}

function onWindowPointerCancel(event: PointerEvent): void {
  if (!gestureActive || event.pointerId !== gesturePointerId) return
  stopGesture()
  dragPos.value = activeIndex.value // spring back: the scroll won, nothing selected
}

function stopGesture(): void {
  offWindowEvent('pointermove', onWindowPointerMove)
  offWindowEvent('pointerup', onWindowPointerUp)
  offWindowEvent('pointercancel', onWindowPointerCancel)
  dragging.value = false
  gestureActive = false
  gestureDownIndex = null
}
</script>

<style scoped>
.mood-slider {
  display: flex;
  flex-direction: column;
  gap: var(--space-3); /* the track hugs the deck -- it belongs to it */
  width: 100%;
  /* Slider-local motion: slower + softer than the global --transition-base
     so the cards glide as the thumb moves. Scoped here on purpose. */
  --mood-slider-ease: cubic-bezier(0.25, 0.1, 0.25, 1);
  --mood-slider-card-duration: 450ms;
  --mood-slider-thumb-duration: 350ms;
}

/* -- carousel stage: an OVERLAPPING deck (tz §3) -- */
.mood-slider__strip {
  position: relative; /* the deck's positioning context */
  width: 100%;
  height: 142px; /* CARD_HEIGHT + breathing room */
  overflow: hidden; /* far cards crop against the stage edges -- by design */
  /* THE STAGE OWNS THE GESTURE: touch-action none means the browser never
     yanks a horizontal drag mid-motion (that takeover -- pointercancel after
     a few drifted pixels -- was the "press -> freeze -> works only on lift"
     jank). The page still scrolls from everywhere else; the deck is a small
     island, and it honors both axes 1:1 while the finger is down. */
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
  -webkit-tap-highlight-color: transparent;
  cursor: grab;
}

.mood-slider__strip--dragging .mood-slider__card {
  /* While a finger drags, every card follows it 1:1 -- no easing. */
  transition: none;
}

.mood-slider__card {
  /* THE DECK: cards are absolutely centered on the stage and shifted/scaled
     per tier from cardStyle() -- no flex positioning, cards overlap on
     purpose. The transform itself is inline (it carries the per-tier shift,
     scale and the live drag); CSS below owns only the look per tier. */
  position: absolute;
  left: 50%;
  top: 50%;
  width: 96px; /* = CARD_WIDTH */
  height: 118px; /* = CARD_HEIGHT */
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-1);
  border: none;
  border-radius: var(--radius-md);
  background: var(--velo-bg-card-solid);
  transition:
    transform var(--mood-slider-card-duration) var(--mood-slider-ease),
    opacity var(--mood-slider-card-duration) var(--mood-slider-ease),
    filter var(--mood-slider-card-duration) var(--mood-slider-ease);
  cursor: pointer;
  will-change: transform;
}

.mood-slider__card:disabled {
  cursor: default;
}

/* Layer order comes from cardStyle() z-index: active(10) -> near(9) -> far(8).
   The active card is sharp, whole and covers part of BOTH neighbors; the
   neighbors blur and dim; the far cards are palest, behind everything. */
.mood-slider__card--active {
  opacity: 1;
  filter: none;
}

.mood-slider__card--near {
  opacity: 0.7;
  filter: blur(2px);
}

.mood-slider__card--far {
  opacity: 0.45;
  filter: blur(3px);
}

.mood-slider__face {
  display: block;
  /* A quiet press cue: the face dips a touch while the finger is down on its
     card (the card's tier transform stays untouched -- it lives inline). */
  transition: transform 150ms var(--mood-slider-ease);
}

.mood-slider__card:active .mood-slider__face {
  transform: scale(0.94);
}

.mood-slider__label {
  font-size: var(--text-xs);
  color: var(--velo-text-primary);
  text-align: center;
}

/* -- track + thumb (service colors are VELO tokens, tz §3) -- */
.mood-slider__track-wrap {
  position: relative;
  height: 22px;
  display: flex;
  align-items: center;
  /* [owner pass] The track rides inside the wrap, so the thumb's % matches
     what the user sees. */
  width: 80%;
  margin: 0 auto;
}

.mood-slider__track {
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--velo-primary);
  border-radius: var(--radius-full);
}

.mood-slider__thumb {
  position: absolute;
  top: 50%;
  width: 22px;
  height: 22px;
  background: var(--velo-primary);
  border-radius: var(--radius-full);
  transform: translate(-50%, -50%);
  transition: left var(--mood-slider-thumb-duration) var(--mood-slider-ease);
  pointer-events: none;
}

/* Transparent native range on top: handles drag / tap / keyboard. */
.mood-slider__input {
  position: absolute;
  left: 0;
  right: 0;
  width: 100%;
  height: 22px;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.mood-slider__input:disabled {
  cursor: default;
}

/* Reduced motion: no gliding or scaling -- re-tiering becomes instant and the
   active card stays visibly distinct (tz §3). */
@media (prefers-reduced-motion: reduce) {
  .mood-slider__card,
  .mood-slider__thumb {
    transition: none;
  }
}
</style>
