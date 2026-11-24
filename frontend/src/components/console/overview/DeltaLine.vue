<!--
  VELO Frontend -- DeltaLine (FE-268)

  The change of a figure against the period before: "+12% vs previous
  period". Counts and money carry a percent change, rates a spread in
  percentage points. A figure with nothing to compare with (the period before
  had no base) reads a dash. The sign and the colour say better or worse; the
  text keeps the number readable without the colour.
-->

<template>
  <span class="delta" :class="`delta--${tone}`" data-testid="delta">
    <template v-if="value === null || value === undefined">
      <span aria-hidden="true">—</span>
      <span class="velo-sr-only">{{
        failed ? t('console.delta.failed') : t('console.delta.none')
      }}</span>
    </template>
    <template v-else>
      <span class="delta__value">{{ text }}</span>
      <span class="delta__vs">{{ t('console.delta.vsPrevious') }}</span>
    </template>
  </span>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed } from 'vue'

const props = defineProps<{
  /** The change; null / undefined -- nothing to compare with. */
  value: number | null | undefined
  /** `pct` -- a percent change (counts, money); `points` -- a spread in percentage points (rates). */
  unit: 'pct' | 'points'
  /** The comparison could not be read (no `value` then): the dash says so, not "nothing to compare with". */
  failed?: boolean
}>()

const tone = computed<'up' | 'down' | 'flat'>(() => {
  if (props.value === null || props.value === undefined || props.value === 0) return 'flat'
  return props.value > 0 ? 'up' : 'down'
})

const text = computed(() => {
  const value = props.value ?? 0
  const signed = `${value > 0 ? '+' : ''}${value}`
  return props.unit === 'pct' ? `${signed}%` : t('console.delta.points', { value: signed })
})
</script>

<style scoped>
.delta {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-1);
  font-size: var(--velo-fs-12);
  color: var(--velo-text-secondary);
}

.delta__value {
  font-size: var(--velo-fs-14);
}

.delta--up .delta__value {
  color: var(--velo-success-text);
}

.delta--down .delta__value {
  color: var(--velo-danger-text);
}
</style>
