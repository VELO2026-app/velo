<!--
  @velo/ui -- VRatingBar (Admin DS, 2026-06-14, operator SVG "Rating
  distribution"; migrated FE-140 batch B)

  A rating-distribution row: leading icon + label, a coloured progress track below,
  and the percentage. Used inside the admin feedback-detail distribution card
  (heading i18n:adminScreens.adminFeedbackRate.distributionratings), on rows
  such as fire (i18n:mood.fire), good (i18n:mood.good) and "have questions".

  Stub-friendly (build-full-design): omit `value` (null) to show an empty track +
  "—" until the backend provides the distribution. `suffix` adds an absolute count
  next to the percent (e.g. "(5)").

  Usage:
    <VRatingBar label="Fire!" :value="45"
      bar-color="var(--velo-peach-300)" icon-color="var(--velo-peach-500)">
      <template #icon><IconRatingFire :size="22" /></template>
    </VRatingBar>
-->

<template>
  <div class="v-rating-bar" :data-velo-stub="!hasValue || undefined">
    <div class="v-rating-bar__head">
      <span class="v-rating-bar__icon" :style="{ color: iconColor || barColor }"
        ><slot name="icon"
      /></span>
      <span class="v-rating-bar__label">{{ label }}</span>
    </div>
    <span class="v-rating-bar__track">
      <i class="v-rating-bar__fill" :style="{ width: fillWidth, background: barColor }"></i>
    </span>
    <span class="v-rating-bar__value">{{ valueDisplay }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    label: string
    /** Percent 0..100. Null/undefined = stub (empty track + "—"). */
    value?: number | null
    /** Track fill colour (CSS value / token). */
    barColor?: string
    /** Icon colour (CSS value / token). Defaults to barColor. */
    iconColor?: string
    /** Extra count next to the percent, e.g. "(5)". */
    suffix?: string
  }>(),
  { value: null, barColor: 'var(--velo-primary)', iconColor: '', suffix: '' },
)

const hasValue = computed(
  (): boolean => typeof props.value === 'number' && Number.isFinite(props.value),
)
const fillWidth = computed((): string =>
  hasValue.value ? `${Math.max(0, Math.min(100, props.value as number))}%` : '0%',
)
const valueDisplay = computed((): string =>
  hasValue.value
    ? `${Math.round(props.value as number)}%${props.suffix ? ` ${props.suffix}` : ''}`
    : '—',
)
</script>

<style scoped>
.v-rating-bar {
  display: flex;
  flex-direction: column;
  gap: var(--velo-gap-6);
}

.v-rating-bar__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.v-rating-bar__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
}

.v-rating-bar__label {
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.v-rating-bar__track {
  position: relative;
  height: 10px;
  border-radius: var(--velo-radius-badge);
  background: var(--velo-glass-blue-15);
  overflow: hidden;
}

.v-rating-bar__fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: var(--velo-radius-badge);
  transition: width var(--transition-base);
}

.v-rating-bar__value {
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
}
</style>
