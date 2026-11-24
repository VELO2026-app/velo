<!--
  VELO Frontend -- FigureTile (FE-268)

  One figure of the dashboard: a small caption, the number, and its change
  against the period before.
-->

<template>
  <div class="figure-tile" data-testid="figure-tile">
    <span class="figure-tile__label">{{ label }}</span>
    <span class="figure-tile__value">{{ value }}</span>
    <DeltaLine :value="delta" :unit="unit" />
  </div>
</template>

<script setup lang="ts">
import DeltaLine from '@/components/console/overview/DeltaLine.vue'

withDefaults(
  defineProps<{
    /** Caption over the number. */
    label: string
    /** The number, already formatted. */
    value: string
    /** Its change against the period before (null -- nothing to compare with). */
    delta: number | null | undefined
    /** `pct` -- percent change; `points` -- spread in percentage points. */
    unit?: 'pct' | 'points'
  }>(),
  { unit: 'pct' },
)
</script>

<style scoped>
.figure-tile {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  box-sizing: border-box;
  padding: var(--space-4) var(--space-5);
  border-radius: var(--velo-radius-22);
  background: var(--velo-bg-card-solid);
  box-shadow: var(--velo-shadow-glass);
}

.figure-tile__label {
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
}

.figure-tile__value {
  font-size: var(--velo-fs-28);
  color: var(--velo-text-primary);
  -webkit-text-stroke: var(--velo-text-stroke-strong);
  overflow-wrap: anywhere;
}
</style>
