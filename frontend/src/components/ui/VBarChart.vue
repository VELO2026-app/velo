<!--
  VELO Frontend -- VBarChart (Admin DS, 2026-06-14, operator SVG "Check-in rate")

  Simple weekly bar chart card: one bar per item, heights scaled to the max value,
  alternating primary / blue-grey fills, labels underneath. Used on the admin
  check-in detail screen.

  Stub-friendly (build-full-design): pass an empty `bars` array to show an empty
  state until the backend provides the series.

  Usage:
    <VBarChart :bars="[{ label: 'ПН', value: 58 }, ...]" />
-->

<template>
  <div class="v-bar-chart">
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
    <p v-else class="v-bar-chart__empty">{{ emptyText ?? t('ui.emptyChart') }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

// tz-i18n 1.3: empty-text fallback resolves at render time (?? t()).
const { t } = useI18n({ useScope: 'global' })

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
  border-radius: 6px 6px 0 0;
}

.v-bar-chart__label {
  font-size: var(--text-xs);
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
  font-size: var(--text-sm);
}
</style>
