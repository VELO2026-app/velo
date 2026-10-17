<!--
  VELO Frontend -- VDayPicker Component (master notifications schedule)

  Day-of-week selector: a row of seven circular toggles (ПН…ВС). A selected day
  is a filled primary circle; an unselected one is an outline. Multi-select,
  Mon-first.

  Introduced for the master «График уведомлений» block (operator SVG
  «6 Notifications 3»). Reusable: any future "which days" setting should use this.

  Usage:
    <VDayPicker v-model="days" />   // days: string[] of 'mon'..'sun'
-->
<template>
  <div class="v-day-picker" role="group" :aria-label="ariaLabel || t('ui.weekdays')">
    <button
      v-for="d in DAYS"
      :key="d"
      type="button"
      class="v-day-picker__day"
      :class="{ 'v-day-picker__day--on': isOn(d) }"
      :aria-pressed="isOn(d)"
      :aria-label="t(`ui.dayFull.${d}`)"
      @click="toggle(d)"
    >
      {{ t(`ui.dayShort.${d}`) }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'

// tz-i18n 1.3: the day NAMES live in the ui.dayShort/dayFull catalogs (the
// codes stay canonical Mon→Sun); the row order/shape is unchanged.
const { t } = useI18n({ useScope: 'global' })

const props = withDefaults(
  defineProps<{
    /** Selected day codes, e.g. ['mon','wed','fri']. */
    modelValue?: string[]
    ariaLabel?: string
  }>(),
  {
    modelValue: () => [],
    ariaLabel: '',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string[]]
}>()

// Mon-first, matching the calendar / onboarding week convention.
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

function isOn(value: string): boolean {
  return props.modelValue.includes(value)
}

function toggle(value: string): void {
  const next = isOn(value)
    ? props.modelValue.filter((v) => v !== value)
    : [...props.modelValue, value]
  // Emit in canonical Mon→Sun order regardless of click sequence.
  emit(
    'update:modelValue',
    DAYS.filter((v) => next.includes(v)),
  )
}
</script>

<style scoped>
.v-day-picker {
  /* Fluid 7-column grid (same overflow-proof pattern as DatePickerSheet
     .dps__grid / WeekStrip): columns flex, the circle is centered in each, so
     the row can never overflow a narrow container (the master create seal-row)
     the way the old fixed `width:42px; flex-shrink:0` did. */
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: var(--space-2);
  justify-items: center;
}

.v-day-picker__day {
  /* Auto-size to the column, square via aspect-ratio, capped at the prior 42px
     so it never balloons on a wide container. No fixed size, no new token. */
  width: 100%;
  max-width: 42px;
  aspect-ratio: 1;
  padding: 0;
  border-radius: var(--radius-full);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-body);
  font-size: var(--text-xs);
  letter-spacing: 0.02em;
  color: var(--velo-text-primary);
  background: transparent;
  border: 1.5px solid var(--velo-border);
  cursor: pointer;
  transition:
    background-color var(--transition-base),
    border-color var(--transition-base),
    color var(--transition-base);
}

.v-day-picker__day--on {
  background: var(--velo-primary);
  border-color: var(--velo-primary);
  color: var(--velo-white);
}
</style>
