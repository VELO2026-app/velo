<!--
  VELO Frontend -- VWheel Component (Phase-3 master DS)

  iOS-style scroll-snap wheel column: a vertical list where the CENTERED item is
  the selection; neighbours dim by distance (1 -> .5, 2 -> .2). Used by the date
  (month/year) and time (hours/minutes) picker sheets. The DS had no wheel.

  - Snap settles on an item; the centered value is emitted (debounced).
  - Tapping an item scrolls it to the centre.
  - Top/bottom spacers let the first/last item reach the centre.

  Usage:
    <VWheel v-model="hour" :options="hourOptions" />
-->

<template>
  <div ref="scrollEl" class="v-wheel" :style="{ '--ih': itemHeight + 'px' }" @scroll="onScroll">
    <div class="v-wheel__pad" aria-hidden="true" />
    <button
      v-for="(opt, i) in options"
      :key="opt.value"
      type="button"
      class="v-wheel__item"
      :style="{ opacity: opacityFor(i) }"
      @click="scrollToIndex(i, true)"
    >
      {{ opt.label }}
    </button>
    <div class="v-wheel__pad" aria-hidden="true" />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, nextTick } from 'vue'

export interface WheelOption {
  value: string
  label: string
}

const props = withDefaults(
  defineProps<{
    modelValue: string
    options: WheelOption[]
    itemHeight?: number
  }>(),
  { itemHeight: 38 },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const scrollEl = ref<HTMLElement | null>(null)
const centerIndex = ref(0)
let settleTimer: ReturnType<typeof setTimeout> | null = null

function indexOfValue(v: string): number {
  const i = props.options.findIndex((o) => o.value === v)
  return i >= 0 ? i : 0
}

/** Opacity by distance from the centred row (matches the operator SVG). */
function opacityFor(i: number): number {
  const d = Math.abs(i - centerIndex.value)
  if (d === 0) return 1
  if (d === 1) return 0.5
  return 0.2
}

function scrollToIndex(i: number, smooth = false): void {
  const el = scrollEl.value
  if (!el) return
  centerIndex.value = Math.max(0, Math.min(props.options.length - 1, i))
  el.scrollTo({ top: centerIndex.value * props.itemHeight, behavior: smooth ? 'smooth' : 'auto' })
}

function onScroll(): void {
  const el = scrollEl.value
  if (!el) return
  const idx = Math.round(el.scrollTop / props.itemHeight)
  centerIndex.value = Math.max(0, Math.min(props.options.length - 1, idx))
  // Debounce: emit the centred value once the snap settles.
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = setTimeout(() => {
    const v = props.options[centerIndex.value]?.value
    if (v !== undefined && v !== props.modelValue) emit('update:modelValue', v)
  }, 140)
}

// External value change -> recentre (skips if already centred, avoids loops).
watch(
  () => props.modelValue,
  (v) => {
    const i = indexOfValue(v)
    if (i !== centerIndex.value) scrollToIndex(i)
  },
)

// Options swapped (e.g. month list) -> recentre on the current value.
watch(
  () => props.options,
  () => nextTick(() => scrollToIndex(indexOfValue(props.modelValue))),
)

onMounted(() => {
  void nextTick(() => scrollToIndex(indexOfValue(props.modelValue)))
})
</script>

<style scoped>
.v-wheel {
  height: calc(var(--ih) * 5);
  overflow-y: scroll;
  scroll-snap-type: y mandatory;
  scrollbar-width: none;
  -ms-overflow-style: none;
  /* Own the vertical gesture so the touch lands on THIS column on first contact
     (fixes the minutes wheel ignoring the first swipe) and never chains to the
     sheet/page scroll. Operator 2026-06-17 — verify on device. */
  touch-action: pan-y;
  overscroll-behavior: contain;
  /* Soft top/bottom fade so the wheel reads as a cylinder. */
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0,
    #000 38%,
    #000 62%,
    transparent 100%
  );
  mask-image: linear-gradient(to bottom, transparent 0, #000 38%, #000 62%, transparent 100%);
}

.v-wheel::-webkit-scrollbar {
  display: none;
}

.v-wheel__pad {
  height: calc(var(--ih) * 2);
}

.v-wheel__item {
  height: var(--ih);
  display: flex;
  align-items: center;
  justify-content: center;
  scroll-snap-align: center;
  font-family: var(--font-body);
  font-size: 25px;
  letter-spacing: 0.02em;
  color: var(--velo-text-primary);
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  transition: opacity var(--transition-fast);
}
</style>
