<!--
  VELO Frontend -- DatePickerSheet (Phase-3 master DS)

  Bottom-sheet date picker for the practice form (operator SVG 2026-06-11,
  "Дата практики"). Two modes in one sheet (Q2=А):
    - calendar: Mon-first month grid; selected day = filled primary circle;
      adjacent-month days dimmed; ‹ › month nav; tap the «Месяц Год» header →
    - wheel: month + year VWheel columns; pick → back to the grid.

  v-model is an ISO date string 'YYYY-MM-DD' (what the form stores). `min`
  (optional 'YYYY-MM-DD') disables earlier days; `max` (optional, same format)
  disables later ones -- FE-70 passes max=today because an external activity
  cannot have happened in the future. Emits update:modelValue + close on save.
-->

<template>
  <VBottomSheet
    :open="open"
    :title="title"
    save-label="Сохранить"
    @save="save"
    @close="$emit('close')"
  >
    <!-- Calendar mode -->
    <div v-if="mode === 'calendar'" class="dps">
      <div class="dps__head">
        <button type="button" class="dps__month" @click="mode = 'wheel'">
          {{ MONTHS[viewMonth] }} {{ viewYear }}
          <svg class="dps__chev dps__chev--sm" viewBox="0 0 9 14"><path d="M2 2L7 7L2 12" /></svg>
        </button>
        <div class="dps__nav">
          <button
            type="button"
            class="dps__navbtn"
            aria-label="Предыдущий месяц"
            @click="shiftMonth(-1)"
          >
            <svg class="dps__chev" viewBox="0 0 14 22"><path d="M11 2L3 11L11 20" /></svg>
          </button>
          <button
            type="button"
            class="dps__navbtn"
            aria-label="Следующий месяц"
            :disabled="nextMonthDisabled"
            @click="shiftMonth(1)"
          >
            <svg class="dps__chev" viewBox="0 0 14 22"><path d="M3 2L11 11L3 20" /></svg>
          </button>
        </div>
      </div>

      <div class="dps__grid">
        <span v-for="wd in WEEKDAYS" :key="wd" class="dps__wd">{{ wd }}</span>
        <button
          v-for="(cell, i) in cells"
          :key="i"
          type="button"
          class="dps__day"
          :class="{
            'dps__day--dim': !cell.current,
            'dps__day--sel': cell.selected,
            'dps__day--disabled': cell.disabled,
          }"
          :disabled="!cell.current || cell.disabled"
          @click="selectDay(cell.day)"
        >
          {{ cell.day }}
        </button>
      </div>
    </div>

    <!-- Month/year wheel mode -->
    <div v-else class="dps__wheels">
      <button type="button" class="dps__month dps__month--open" @click="mode = 'calendar'">
        {{ MONTHS[viewMonth] }} {{ viewYear }}
        <svg class="dps__chev dps__chev--sm" viewBox="0 0 14 9"><path d="M2 2L7 7L12 2" /></svg>
      </button>
      <div class="dps__wheelrow">
        <VWheel
          :model-value="String(viewMonth)"
          :options="monthOptions"
          @update:model-value="viewMonth = Number($event)"
        />
        <VWheel
          :model-value="String(viewYear)"
          :options="yearOptions"
          @update:model-value="viewYear = Number($event)"
        />
      </div>
    </div>
  </VBottomSheet>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { daysInMonth, firstWeekdayMonFirst, shiftMonthParts } from '@/utils/calendarMath'
import { VBottomSheet, VWheel } from '@/components/ui'

const props = withDefaults(
  defineProps<{
    open: boolean
    modelValue?: string
    /** Optional ISO 'YYYY-MM-DD' lower bound; earlier days are disabled. */
    min?: string
    /** Optional ISO 'YYYY-MM-DD' upper bound; later days are disabled.
     *  FE-70: the external-activity form passes max=today (nothing that has
     *  not happened yet can be recorded). */
    max?: string
    /** Sheet title (default «Дата практики»; reused as «Дата заявки» in admin). */
    title?: string
  }>(),
  { modelValue: '', min: '', max: '', title: 'Дата практики' },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  close: []
}>()

const MONTHS = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
]
const WEEKDAYS = ['ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ', 'ВС']

const mode = ref<'calendar' | 'wheel'>('calendar')

// Viewed month + the selected day (defaults to today / modelValue on open).
const viewYear = ref(0)
const viewMonth = ref(0)
const selDay = ref<number | null>(null)

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function initFromModel(): void {
  const base = props.modelValue || props.min
  const d = base ? new Date(`${base}T12:00:00`) : new Date()
  viewYear.value = d.getFullYear()
  viewMonth.value = d.getMonth()
  selDay.value = props.modelValue ? d.getDate() : null
  mode.value = 'calendar'
}

// Re-init each time the sheet opens.
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) initFromModel()
  },
  { immediate: true },
)

const monthOptions = computed(() => {
  // No past months: when the viewed year is the `min` year, drop months before
  // the min month (operator 2026-06-17 — couldn't pick a past practice month).
  // `max` mirrors it at the upper edge (FE-70): drop months after the max
  // month when viewing the max year.
  let startMonth = 0
  if (props.min) {
    const parts = props.min.split('-')
    const minY = Number(parts[0])
    const minM = Number(parts[1])
    if (viewYear.value === minY) startMonth = minM - 1
  }
  let endMonth = 11
  if (props.max) {
    const parts = props.max.split('-')
    const maxY = Number(parts[0])
    const maxM = Number(parts[1])
    if (viewYear.value === maxY) endMonth = maxM - 1
  }
  return MONTHS.map((label, i) => ({ value: String(i), label })).filter(
    (_, i) => i >= startMonth && i <= endMonth,
  )
})

const yearOptions = computed(() => {
  const now = new Date().getFullYear()
  const start = Math.min(now, viewYear.value || now)
  // `max` caps the wheel's upper edge too (FE-70): a diary of what HAPPENED
  // cannot reach for a year beyond the bound. Without `max` the previous
  // now+5 horizon is byte-identical.
  const maxY = props.max ? Number(props.max.split('-')[0]) : null
  const end = maxY !== null ? Math.min(now + 5, maxY) : now + 5
  const years: { value: string; label: string }[] = []
  for (let y = start; y <= end; y++) years.push({ value: String(y), label: String(y) })
  return years
})

// The › month-nav stops at `max`: past the bound every cell would be disabled
// anyway -- an unreachable view the user can only leave the same way they came.
const nextMonthDisabled = computed(() => {
  if (!props.max) return false
  const parts = props.max.split('-')
  const maxY = Number(parts[0])
  const maxM = Number(parts[1])
  return viewYear.value > maxY || (viewYear.value === maxY && viewMonth.value >= maxM - 1)
})

interface Cell {
  day: number
  current: boolean
  selected: boolean
  disabled: boolean
}

const cells = computed((): Cell[] => {
  const leading = firstWeekdayMonFirst(viewYear.value, viewMonth.value + 1)
  const dim = daysInMonth(viewYear.value, viewMonth.value + 1)
  const prevDays = daysInMonth(
    viewMonth.value === 0 ? viewYear.value - 1 : viewYear.value,
    viewMonth.value === 0 ? 12 : viewMonth.value,
  )
  const total = Math.ceil((leading + dim) / 7) * 7
  const out: Cell[] = []
  for (let i = 0; i < total; i++) {
    const dayNum = i - leading + 1
    if (i < leading) {
      out.push({ day: prevDays - leading + 1 + i, current: false, selected: false, disabled: true })
    } else if (dayNum <= dim) {
      const ymd = `${viewYear.value}-${pad2(viewMonth.value + 1)}-${pad2(dayNum)}`
      out.push({
        day: dayNum,
        current: true,
        selected: selDay.value === dayNum,
        disabled: (!!props.min && ymd < props.min) || (!!props.max && ymd > props.max),
      })
    } else {
      out.push({ day: dayNum - dim, current: false, selected: false, disabled: true })
    }
  }
  return out
})

function shiftMonth(delta: number): void {
  const shifted = shiftMonthParts(viewYear.value, viewMonth.value + 1, delta)
  viewYear.value = shifted.year
  viewMonth.value = shifted.month - 1
  // Keep the selected day only if it still belongs to the new month view.
  if (selDay.value !== null && selDay.value > daysInMonth(viewYear.value, viewMonth.value + 1)) {
    selDay.value = null
  }
}

function selectDay(day: number): void {
  selDay.value = day
}

function save(): void {
  if (selDay.value === null) return
  emit('update:modelValue', `${viewYear.value}-${pad2(viewMonth.value + 1)}-${pad2(selDay.value)}`)
  emit('close')
}
</script>

<style scoped>
.dps {
  display: flex;
  flex-direction: column;
}

.dps__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-3);
}

.dps__month {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-family: var(--font-body);
  font-size: var(--text-lg);
  color: var(--velo-primary);
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
}

.dps__month--open {
  margin-bottom: var(--space-4);
}

.dps__nav {
  display: inline-flex;
  align-items: center;
  gap: var(--space-5);
}

.dps__navbtn {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  display: flex;
}

.dps__navbtn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.dps__chev {
  width: 14px;
  height: 22px;
  fill: none;
  stroke: var(--velo-primary);
  stroke-width: 3;
  stroke-linecap: round;
}

.dps__chev--sm {
  width: 9px;
  height: 14px;
  stroke-width: 2;
}

.dps__grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  row-gap: var(--velo-gap-6);
  justify-items: center;
}

.dps__wd {
  height: 30px;
  display: flex;
  align-items: center;
  font-size: var(--text-xs);
  color: var(--velo-primary);
  opacity: 0.7;
}

.dps__day {
  width: 37px;
  height: 37px;
  border-radius: var(--radius-full);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-primary);
  background: none;
  border: 1px solid var(--velo-primary);
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.dps__day--dim {
  border-color: transparent;
  opacity: 0.35;
  cursor: default;
}

.dps__day--disabled {
  border-color: transparent;
  opacity: 0.3;
  cursor: not-allowed;
}

.dps__day--sel {
  background: var(--velo-primary);
  color: var(--velo-white);
  border-color: var(--velo-primary);
}

/* Wheel mode */
.dps__wheels {
  display: flex;
  flex-direction: column;
}

.dps__wheelrow {
  display: flex;
  justify-content: center;
  gap: var(--space-8);
}
</style>
