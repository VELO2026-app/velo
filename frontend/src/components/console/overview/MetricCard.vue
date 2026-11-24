<!--
  VELO Frontend -- MetricCard (FE-268)

  One engagement metric of the analytics: its name, the rate and the change
  against the period before. The card is a toggle: the pressed one is the
  metric whose breakdown is open under the row.
-->

<template>
  <button
    type="button"
    class="metric-card"
    :class="{ 'metric-card--selected': selected }"
    :aria-pressed="selected"
    :data-testid="`metric-${id}`"
    @click="emit('select')"
  >
    <span class="metric-card__label">{{ label }}</span>
    <span class="metric-card__rate" data-testid="metric-rate">{{ rateText }}</span>
    <DeltaLine :value="delta" unit="points" />
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import DeltaLine from '@/components/console/overview/DeltaLine.vue'

const props = defineProps<{
  /** Metric key (test id). */
  id: string
  /** Metric name. */
  label: string
  /** The rate, percent; null -- not known (loading, or the read failed). */
  rate: number | null
  /** Change against the period before, percentage points. */
  delta: number | null | undefined
  /** Its breakdown is open. */
  selected: boolean
}>()

const emit = defineEmits<{
  select: []
}>()

const rateText = computed(() => (props.rate === null ? '—' : `${Math.round(props.rate)}%`))
</script>

<style scoped>
.metric-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-1);
  min-width: 0;
  box-sizing: border-box;
  padding: var(--space-4) var(--space-5);
  border: 2px solid transparent;
  border-radius: var(--velo-radius-22);
  background: var(--velo-bg-card-solid);
  box-shadow: var(--velo-shadow-glass);
  color: var(--velo-text-primary);
  font: inherit;
  text-align: start;
  cursor: pointer;
}

.metric-card--selected {
  border-color: var(--velo-primary);
}

.metric-card__label {
  font-size: var(--velo-fs-16);
  -webkit-text-stroke: var(--velo-text-stroke-strong);
}

.metric-card__rate {
  font-size: var(--velo-fs-32);
  -webkit-text-stroke: var(--velo-text-stroke-strong);
}
</style>
