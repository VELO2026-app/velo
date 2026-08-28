<!--
  VELO Frontend -- MoodSlider (Check-in / Feedback slider, Figma 541:6913)

  A reusable 1..10 score slider rendered as three "live" icons above a thin
  track with a round thumb. Used by CheckinView (mood faces) and FeedbackView
  (rating icons) -- the three icons + labels are passed in via `zones`, so the
  component itself is content-agnostic.

  Liveness (per the mock): the icon for the zone the thumb sits in grows and
  becomes fully opaque (size 40 -> 63, opacity 0.8 -> 1) while the other two
  shrink and dim. The transition is smooth (CSS), so dragging the slider
  animates the icons rather than snapping.

  Score -> zone mapping (3 equal-ish ranges over 1..10):
    1-3  -> zone 0   4-7 -> zone 1   8-10 -> zone 2
  Submitting uses the raw 1..10 value; the parent reads modelValue directly.
-->
<template>
  <div class="mood-slider">
    <div class="mood-slider__icons">
      <div
        v-for="(zone, i) in zones"
        :key="i"
        class="mood-slider__card"
        :class="{ 'mood-slider__card--active': activeZone === i }"
        @click="selectZone(i)"
      >
        <component
          :is="zone.icon"
          :size="63"
          class="mood-slider__icon"
          :style="zone.color ? { color: zone.color } : undefined"
        />
        <span class="mood-slider__label">{{ zone.label }}</span>
      </div>
    </div>

    <!-- Track + thumb. The native range input sits on top (transparent) so
         drag / tap / keyboard all work and stay accessible. -->
    <div class="mood-slider__track-wrap">
      <div class="mood-slider__track" />
      <div class="mood-slider__thumb" :style="{ left: `${thumbPercent}%` }" />
      <input
        class="mood-slider__input"
        type="range"
        :min="1"
        :max="10"
        :step="1"
        :value="modelValue"
        :aria-label="ariaLabel"
        @input="onInput"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Component } from 'vue'

interface Zone {
  icon: Component
  label: string
  /** Optional icon tint (CSS color / var). Applied as the icon's color so
   *  currentColor-based glyphs pick it up. Used by FeedbackView. */
  color?: string
}

const props = defineProps<{
  modelValue: number
  zones: Zone[]
  ariaLabel?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: number]
}>()

// Score (1..10) -> zone index (0/1/2). 1-3 low, 4-7 mid, 8-10 high.
const activeZone = computed<number>(() => {
  const v = props.modelValue
  if (v <= 3) return 0
  if (v <= 7) return 1
  return 2
})

// Thumb position as a percentage across the track (1 -> 0%, 10 -> 100%).
const thumbPercent = computed<number>(() => {
  const clamped = Math.min(10, Math.max(1, props.modelValue))
  return ((clamped - 1) / 9) * 100
})

function onInput(event: Event): void {
  const target = event.target as HTMLInputElement
  emit('update:modelValue', Number(target.value))
}

// Tapping an icon jumps the score to the centre of that zone (2 / 6 / 9),
// matching the discrete buttons the slider replaces.
const ZONE_CENTRE = [2, 6, 9]
function selectZone(i: number): void {
  emit('update:modelValue', ZONE_CENTRE[i] ?? 6)
}
</script>

<style scoped>
.mood-slider {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  width: 100%;
  /* Slider-local motion: slower + softer than the global --transition-base
     so the icons grow/fade gently as the thumb moves. Scoped to this
     component on purpose -- does not affect the rest of the UI. */
  --mood-slider-ease: cubic-bezier(0.25, 0.1, 0.25, 1);
  --mood-slider-icon-duration: 450ms;
  --mood-slider-thumb-duration: 350ms;
}

.mood-slider__icons {
  display: flex;
  align-items: center;
  justify-content: space-between;
  /* Leave room for the centre card to grow without clipping neighbours. */
  min-height: 132px;
}

.mood-slider__card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  flex: 1;
  padding: var(--space-3) var(--space-2);
  border-radius: var(--radius-md);
  background: var(--velo-bg-card-solid);
  opacity: 0.8;
  /* Inactive cards sit smaller, dimmer and slightly out of focus (owner
     pass: a light ~10%-strength blur); the active zone's card grows,
     brightens and sharpens. All on the same slow, soft curve -- the blur
     rides the card so it covers the icon and the label together. */
  transform: scale(0.8);
  filter: blur(2px);
  transform-origin: center;
  transition:
    transform var(--mood-slider-icon-duration) var(--mood-slider-ease),
    opacity var(--mood-slider-icon-duration) var(--mood-slider-ease),
    filter var(--mood-slider-icon-duration) var(--mood-slider-ease);
  cursor: pointer;
}

.mood-slider__card--active {
  opacity: 1;
  transform: scale(1.08);
  filter: blur(0);
}

.mood-slider__icon {
  display: block;
  /* The icon is rendered at its full size (63) and scaled down when its zone
     is inactive (40/63 = 0.635). Animating scale -- not the :size prop --
     lets the size change ride the same slow, soft curve as the fade. */
  transform: scale(0.635);
  transform-origin: center;
  transition: transform var(--mood-slider-icon-duration) var(--mood-slider-ease);
}

.mood-slider__card--active .mood-slider__icon {
  transform: scale(1);
}

.mood-slider__label {
  font-size: var(--text-xs);
  color: var(--velo-text-primary);
  text-align: center;
}

.mood-slider__track-wrap {
  position: relative;
  height: 22px;
  display: flex;
  align-items: center;
  /* [owner pass] The track is 20% shorter than the row and centred -- the
     input rides inside the wrap, so the thumb's % stays consistent with
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
</style>
