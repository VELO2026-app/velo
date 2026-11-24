<!--
  VELO Frontend -- TrendBars (FE-268)

  The trend of a rate over a period: one bar per point, its height the rate
  on a fixed 0..100 % scale, the rate written over the bar and the date under
  it, so nothing is only in the picture. The kit's VBarChart is not used: its
  bars shrink to one height inside the column (a flex item taller than the
  column), so every bar of a trend looks the same.
-->

<template>
  <figure class="trend" :data-velo-stub="bars.length === 0 || undefined">
    <div v-if="bars.length > 0" class="trend__plot" role="list">
      <div v-for="bar in bars" :key="bar.label" class="trend__col" role="listitem">
        <span class="trend__value" data-testid="trend-value">{{ Math.round(bar.value) }}%</span>
        <span class="trend__track" aria-hidden="true">
          <span class="trend__bar" :style="{ height: `${heightOf(bar.value)}%` }" />
        </span>
        <span class="trend__label" data-testid="trend-label">{{ bar.label }}</span>
      </div>
    </div>
    <p v-else class="trend__empty">{{ emptyText }}</p>
  </figure>
</template>

<script setup lang="ts">
defineProps<{
  /** The points: a date label and the rate, percent. */
  bars: { label: string; value: number }[]
  /** What to say when there are no points. */
  emptyText: string
}>()

/** A rate as the height of its bar; a real, small rate never vanishes. */
function heightOf(value: number): number {
  return value <= 0 ? 0 : Math.min(100, Math.max(2, Math.round(value)))
}
</script>

<style scoped>
.trend {
  margin: 0;
}

.trend__plot {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-2);
}

.trend__col {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}

.trend__value {
  font-size: var(--velo-fs-12);
  color: var(--velo-text-primary);
}

.trend__track {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  width: 100%;
  height: 120px;
}

.trend__bar {
  display: block;
  width: 100%;
  max-width: 26px;
  border-radius: var(--velo-radius-bar-top);
  background: var(--velo-primary);
}

.trend__label {
  font-size: var(--velo-fs-12);
  color: var(--velo-text-primary);
  white-space: nowrap;
}

.trend__empty {
  margin: 0;
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
}
</style>
