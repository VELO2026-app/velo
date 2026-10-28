<!--
  VELO Frontend -- BirthDateSheet (FE-101 onboarding)

  Bottom-sheet WHEEL picker for a birth date, operator mockup 2026-10-19:
  three VWheel columns in the order Месяц / День / Год («октября / 14 / 2001»)
  and a single «Сохранить» button. Sibling of DatePickerSheet, which serves
  PRACTICE dates (calendar-first, a ±5-year horizon); a birth date needs a
  century-deep wheel instead, so the two share VBottomSheet + VWheel rather
  than one strained component.

  Month labels are GENITIVE («октября», not «октябрь»): generated through
  Intl formatToParts with a day present, the same trick the mockup's column
  shows. Other locales simply get ICU's own month spelling.

  Bounds: years run from the current year down 100 of them; within the
  current year, future months -- and within the current month, future days --
  are dropped from the wheels (a birth date cannot be in the future). The
  selected day clamps to the month's length when the month/year moves
  (Jan 31 -> Feb 28/29), so «Сохранить» can never compose an invalid date.

  v-model is an ISO 'YYYY-MM-DD' string ('' = nothing chosen). Emits
  update:modelValue + close on save; the scrim/Escape emit close only, so
  an accidental dismiss keeps the previous value.
-->

<template>
  <VBottomSheet :open="open" :save-label="t('ui.save')" @save="save" @close="$emit('close')">
    <div class="bds">
      <div class="bds__col bds__col--month">
        <span class="bds__label">{{ t('auth.onboarding.birth.month') }}</span>
        <VWheel
          :model-value="String(month)"
          :options="monthOptions"
          @update:model-value="month = Number($event)"
        />
      </div>
      <div class="bds__col bds__col--day">
        <span class="bds__label">{{ t('auth.onboarding.birth.day') }}</span>
        <VWheel
          :model-value="String(day)"
          :options="dayOptions"
          @update:model-value="day = Number($event)"
        />
      </div>
      <div class="bds__col bds__col--year">
        <span class="bds__label">{{ t('auth.onboarding.birth.year') }}</span>
        <VWheel
          :model-value="String(year)"
          :options="yearOptions"
          @update:model-value="year = Number($event)"
        />
      </div>
    </div>
  </VBottomSheet>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { getLocale, t } from '@/locales'
import { daysInMonth } from '@/utils/calendarMath'
import { VBottomSheet, VWheel } from '@/components/ui'

/** A VWheel column entry (declared locally: the ui barrel exports no types,
 *  and importing the .vue file directly is banned by no-restricted-imports). */
interface WheelEntry {
  value: string
  label: string
}

const props = withDefaults(
  defineProps<{
    open: boolean
    /** ISO 'YYYY-MM-DD'; '' or absent -> the wheels start at 1 января 2000. */
    modelValue?: string
  }>(),
  { modelValue: '' },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  close: []
}>()

// Default wheel position when nothing is chosen yet: the middle of the
// plausible range, not today (nobody using the app was born this year).
const DEFAULT_YEAR = 2000
const DEFAULT_MONTH = 0 // January
const DEFAULT_DAY = 1

const month = ref(DEFAULT_MONTH)
const day = ref(DEFAULT_DAY)
const year = ref(DEFAULT_YEAR)

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function initFromModel(): void {
  if (props.modelValue) {
    const parts = props.modelValue.split('-')
    year.value = Number(parts[0])
    month.value = Number(parts[1]) - 1
    day.value = Number(parts[2])
  } else {
    year.value = DEFAULT_YEAR
    month.value = DEFAULT_MONTH
    day.value = DEFAULT_DAY
  }
}

// Re-init each time the sheet opens (same idiom as DatePickerSheet).
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) initFromModel()
  },
  { immediate: true },
)

// Genitive month labels: ICU yields the genitive form in ru only when a DAY
// is part of the pattern, so the label is read from formatToParts rather
// than a standalone { month: 'long' } (which would give «Октябрь»). The
// probe date is UTC-anchored (no runtime-tz Date constructor) and the
// formatter is called WITHOUT `new`: the Intl constructors are
// legacy-callable, and the call form keeps working under the test suite's
// zero-arg Intl spy (whose mock is not a constructor).
const MONTH_LABELS = Array.from({ length: 12 }, (_, m) => {
  const parts = Intl.DateTimeFormat(getLocale(), {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).formatToParts(new Date(Date.UTC(2026, m, 1)))
  return parts.find((p) => p.type === 'month')?.value ?? ''
})

const today = new Date()
const currentYear = today.getFullYear()
const currentMonth = today.getMonth()
const currentDay = today.getDate()

// The wheel's horizon: 100 years back covers every living user's birth year
// while keeping the column scannable (mirrors the backend's 1900 floor --
// anything this edge lets through, that one would have rejected anyway).
const MIN_YEAR = currentYear - 100

const isCurrentYear = computed(() => year.value === currentYear)
const isCurrentMonth = computed(() => isCurrentYear.value && month.value === currentMonth)

const monthOptions = computed<WheelEntry[]>(() =>
  MONTH_LABELS.map((label, i) => ({ value: String(i), label })).filter(
    // No future months within the current year.
    (_, i) => !isCurrentYear.value || i <= currentMonth,
  ),
)

const dayOptions = computed<WheelEntry[]>(() => {
  const last = isCurrentMonth.value ? currentDay : daysInMonth(year.value, month.value + 1)
  const out: WheelEntry[] = []
  for (let d = 1; d <= last; d++) out.push({ value: String(d), label: String(d) })
  return out
})

const yearOptions = computed<WheelEntry[]>(() => {
  const out: WheelEntry[] = []
  for (let y = currentYear; y >= MIN_YEAR; y--) out.push({ value: String(y), label: String(y) })
  return out
})

// Jan 31 -> Feb: the day the wheels still hold may not exist in the new
// month. Clamp it so the composed date is always a real calendar date (this
// is also what Feb 29 of a leap -> non-leap year lands on).
watch([year, month], () => {
  const last = daysInMonth(year.value, month.value + 1)
  if (day.value > last) day.value = last
})

function save(): void {
  emit('update:modelValue', `${year.value}-${pad2(month.value + 1)}-${pad2(day.value)}`)
  emit('close')
}
</script>

<style scoped>
.bds {
  display: flex;
  justify-content: center;
  gap: var(--space-6);
  padding-bottom: var(--space-2);
}

.bds__col {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
}

.bds__col--month {
  min-width: 118px;
}

.bds__col--day {
  min-width: 58px;
}

.bds__col--year {
  min-width: 78px;
}

.bds__label {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
}
</style>
