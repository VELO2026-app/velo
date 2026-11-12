<!--
  @velo/ui -- VBarChart (Admin DS, 2026-06-14, operator SVG "Check-in rate";
  migrated FE-118 P3)

  Simple weekly bar chart card: one bar per item, heights scaled to the max value,
  alternating primary / blue-grey fills, labels underneath. Used on the admin
  check-in detail screen.

  Stub-friendly (build-full-design): pass an empty `bars` array to show an empty
  state until the backend provides the series.

  Usage:
    <VBarChart :bars="[{ label: 'Mon', value: 58 }, ...]" />
-->

<template>
  <div class="v-bar-chart" :data-velo-stub="!bars.length || undefined">
    <div v-if="bars.length" class="v-bar-chart__plot">
      <div v-for="(bar, i) in bars" :key="bar.label" class="v-bar-chart__col">
        <span
          class="v-bar-chart__bar"
          :style="{
            height: heightFor(bar.value),
            background: i % 2 === 0 ? 'var(--velo-text-primary)' : 'var(--velo-blue-300)',
          }"
        ></span>
        <span class="v-bar-chart__label">{{ bar.label }}</span>
      </div>
    </div>
    <p v-else class="v-bar-chart__empty">{{ emptyText ?? t('ui.noData') }}</p>
  </div>
</template>

<script setup lang="ts">
import { t } from '../../i18n'
import { computed } from 'vue'

// The i18n seam (FE-118, tz-ui-package.md §4 P3): the empty-text fallback
// resolves at render time (?? t()). The key was aligned from common.noData
// to ui.noData with the move -- same phrase, now the kit registry owns it.

const props = withDefaults(
  defineProps<{
    bars?: { label: string; value: number }[]
    emptyText?: string
  }>(),
  { bars: () => [] },
)

const max = computed((): number => Math.max(1, ...props.bars.map((b) => b.value)))
function heightFor(value: number): string {
  return `${Math.max(4, Math.round((value / max.value) * 100))}%`
}
</script>

<style scoped>
.v-bar-chart {
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-4);
  height: 164px;
}

.v-bar-chart__plot {
  height: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-2);
}

.v-bar-chart__col {
  flex: 1;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
}

.v-bar-chart__bar {
  width: 100%;
  max-width: 26px;
  margin-top: auto;
  border-radius: var(--velo-radius-bar-top);
}

.v-bar-chart__label {
  font-size: var(--velo-fs-14);
  color: var(--velo-primary);
}

.v-bar-chart__empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  text-align: center;
  color: var(--velo-text-muted);
  font-size: var(--velo-fs-16);
}
</style>
