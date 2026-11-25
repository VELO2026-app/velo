<!--
  VELO Frontend -- PeriodBar (FE-268)

  The period control of the dashboard and the analytics: a week / month
  switch, the stepper over the periods before it, and the range it names
  ("Nov 2026"). Switching the granularity goes back to the current period;
  the stepper never goes into the future (the API has no data there).
-->

<template>
  <div class="period-bar" data-testid="period-bar">
    <VSegment
      compact
      :model-value="period"
      :options="options"
      :aria-label="t('console.period.label')"
      @update:model-value="select"
    />
    <div class="period-bar__stepper">
      <button
        type="button"
        class="period-bar__step period-bar__step--prev"
        :aria-label="t('console.period.prev')"
        @click="emit('change', { period, offset: offset - 1 })"
      >
        <IconArrowRight :size="20" />
      </button>
      <span class="period-bar__range" data-testid="period-range">{{ range }}</span>
      <button
        type="button"
        class="period-bar__step"
        :aria-label="t('console.period.next')"
        :disabled="offset >= 0"
        @click="emit('change', { period, offset: offset + 1 })"
      >
        <IconArrowRight :size="20" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed } from 'vue'
import { VSegment } from '@/components/ui'
import type { SegmentOption } from '@/components/ui'
import { IconArrowRight } from '@/components/icons'
import type { AdminPeriodWindow } from '@/composables/queries/admin'
import { formatPeriodRange } from '@/utils/periodRange'

const props = defineProps<{
  /** The granularity on screen. */
  period: AdminPeriodWindow['period']
  /** Periods back from the current one: 0 now, -1 the one before. */
  offset: number
}>()

const emit = defineEmits<{
  change: [window: AdminPeriodWindow]
}>()

const options = computed<SegmentOption[]>(() => [
  { value: 'week', label: t('common.periodWeek') },
  { value: 'month', label: t('common.periodMonth') },
])

const range = computed(() => formatPeriodRange(props.period, props.offset))

// VSegment hands a plain string; anything but the two periods is ignored.
function select(value: string): void {
  if (value !== 'week' && value !== 'month') return
  if (value === props.period) return
  emit('change', { period: value, offset: 0 })
}
</script>

<style scoped>
.period-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3) var(--space-5);
}

.period-bar__stepper {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.period-bar__step {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--velo-size-40);
  height: var(--velo-size-40);
  padding: 0;
  border: 1px solid var(--velo-border-light);
  border-radius: var(--radius-full);
  background: var(--velo-bg-card-solid);
  color: var(--velo-text-primary);
  cursor: pointer;
}

.period-bar__step:disabled {
  opacity: 0.45;
  cursor: default;
}

/* One arrow glyph, mirrored for "previous". */
.period-bar__step--prev {
  transform: scaleX(-1);
}

.period-bar__range {
  min-width: 9rem;
  text-align: center;
  font-size: var(--velo-fs-16);
  color: var(--velo-text-primary);
}
</style>
