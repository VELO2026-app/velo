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
        <!-- The track is the bar's own box: its percent height is taken of the
             room the label leaves, not of the whole column. -->
        <span class="v-bar-chart__track">
          <span
            class="v-bar-chart__bar"
            :style="{
              height: heightFor(bar.value),
              background: i % 2 === 0 ? 'var(--velo-text-primary)' : 'var(--velo-blue-300)',
            }"
          ></span>
        </span>
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
  /* The plot is the query container: the labels must fit the width the chart
     is given, not the screen's (FE-250). */
  container-type: inline-size;
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

/* The bar's percent height is of this box. Taken of the column, the tallest
   bars (the label shares the column) did not fit and shrank to one height. */
.v-bar-chart__track {
  flex: 1 1 0;
  min-height: 0;
  width: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.v-bar-chart__bar {
  width: 100%;
  max-width: 26px;
  border-radius: var(--velo-radius-bar-top);
}

.v-bar-chart__label {
  font-size: var(--velo-fs-14);
  color: var(--velo-primary);
  white-space: nowrap;
}

/* Seven date labels ("29.11") at 14px need 7 x 34 px plus 6 gaps of 8 px,
   286 px. A narrower plot (a 320 px screen leaves 238 px) gets 12px labels and
   a 4px gap, 227 px in all, so the last label stays inside the card (FE-250). */
@container (max-width: 285px) {
  .v-bar-chart__plot {
    gap: var(--space-1);
  }

  .v-bar-chart__label {
    font-size: var(--velo-fs-12);
  }
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
