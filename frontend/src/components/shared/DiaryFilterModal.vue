<!--
  VELO Frontend -- DiaryFilterModal (Diary redesign, Batch 2a; screen 42)

  Category filter for the unified diary feed, opened from the "..." menu.
  Chips map 1:1 onto DiaryFeedCategory (backend `category` query values):
    Все       -> no categories (empty array)
    Дневник   -> entries
    Сонник    -> dreams
    Feedbacks -> feedbacks
    Check-ins -> checkins
    Практики  -> practices

  "Все" is mutually exclusive with the others: tapping it clears the
  selection; tapping any category clears "Все" and toggles that category
  (multi-select). An empty selection IS "Все".

  Date-range filtering (screen 43) is a separate piece (Batch 2b) and is not
  part of this modal yet.

  Works on a local DRAFT; nothing is applied until "Применить" (-> emits
  `apply` with the category array). "Сбросить" clears to "Все".

  Usage:
    <DiaryFilterModal
      :open="showFilter"
      :categories="feedFilters.categories ?? []"
      @apply="onApplyFilter"
      @close="showFilter = false"
    />
-->

<template>
  <VModal :open="open" @close="$emit('close')">
    <div class="diary-filter">
      <div class="diary-filter__header">
        <span class="diary-filter__header-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="none">
            <path
              d="M3 4h14l-5.5 7v4l-3 1.5v-5.5L3 4z"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linejoin="round"
            />
          </svg>
        </span>
        <h2 class="diary-filter__heading">Фильтр</h2>
      </div>

      <!-- Date range (screen 43): collapsible header + month grid -->
      <section class="diary-filter__group">
        <button
          type="button"
          class="diary-filter__date-toggle"
          @click="dateExpanded = !dateExpanded"
        >
          <span class="diary-filter__date-summary">{{ dateSummary }}</span>
          <IconArrowRight
            :size="18"
            class="diary-filter__date-caret"
            :class="{ 'diary-filter__date-caret--open': dateExpanded }"
          />
        </button>

        <div v-if="dateExpanded" class="diary-filter__calendar">
          <!-- Month nav -->
          <div class="diary-filter__cal-head">
            <button
              type="button"
              class="diary-filter__cal-nav"
              aria-label="Предыдущий месяц"
              @click="prevMonth"
            >
              <IconArrowRight :size="18" class="diary-filter__cal-nav-prev" />
            </button>
            <span class="diary-filter__cal-title">{{ monthTitle }}</span>
            <button
              type="button"
              class="diary-filter__cal-nav"
              aria-label="Следующий месяц"
              @click="nextMonth"
            >
              <IconArrowRight :size="18" />
            </button>
          </div>

          <!-- Weekday header -->
          <div class="diary-filter__cal-grid">
            <span v-for="wd in WEEKDAY_LABELS" :key="wd" class="diary-filter__cal-weekday">{{
              wd
            }}</span>
          </div>

          <!-- Day cells -->
          <div class="diary-filter__cal-grid">
            <template v-for="(cell, i) in monthCells" :key="i">
              <span v-if="cell.key === null" class="diary-filter__cal-cell" />
              <button
                v-else
                type="button"
                class="diary-filter__cal-day"
                :class="{
                  'diary-filter__cal-day--in': isInRange(cell.key),
                  'diary-filter__cal-day--edge': isRangeStart(cell.key) || isRangeEnd(cell.key),
                }"
                @click="onDayTap(cell.key)"
              >
                {{ cell.num }}
              </button>
            </template>
          </div>

          <button
            v-if="draftFrom"
            type="button"
            class="diary-filter__date-clear"
            @click="clearDates"
          >
            Сбросить даты
          </button>
        </div>
      </section>

      <!-- Categories (screen 42) -->
      <section class="diary-filter__group">
        <div class="diary-filter__chips">
          <!-- "Все" -- active when nothing else is selected. -->
          <VChip size="md" clickable :active="draft.length === 0" @click="selectAll"> Все </VChip>
          <VChip
            v-for="opt in CATEGORY_CHIPS"
            :key="opt.value"
            size="md"
            clickable
            :active="draft.includes(opt.value)"
            @click="toggle(opt.value)"
          >
            {{ opt.label }}
          </VChip>
        </div>
      </section>

      <div class="diary-filter__actions">
        <VButton variant="secondary" block @click="onReset">Сбросить</VButton>
        <VButton variant="primary" block @click="onApply">Применить</VButton>
      </div>
    </div>
  </VModal>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import {
  dayKeyOf,
  daysInMonth,
  firstOfMonth,
  firstWeekdayMonFirst,
  shiftMonthDate,
} from '@/utils/calendarMath'
import { VModal, VButton, VChip } from '@/components/ui'
import { IconArrowRight } from '@/components/icons'
import type { DiaryFeedCategory } from '@/api/types'

const props = defineProps<{
  open: boolean
  categories: DiaryFeedCategory[]
  dateFrom?: string
  dateTo?: string
  timezone?: string
}>()

const emit = defineEmits<{
  apply: [
    payload: {
      categories: DiaryFeedCategory[]
      date_from?: string
      date_to?: string
    },
  ]
  close: []
}>()

// Chip option list (label + value). Labels match the design (screen 42);
// "Все" is rendered separately above (it is the empty selection).
const CATEGORY_CHIPS: { value: DiaryFeedCategory; label: string }[] = [
  { value: 'entries', label: 'Дневник' },
  { value: 'dreams', label: 'Сонник' },
  { value: 'feedbacks', label: 'Feedbacks' },
  { value: 'checkins', label: 'Check-ins' },
  { value: 'practices', label: 'Практики' },
]

// Local draft -- the working copy until "Применить".
const draft = ref<DiaryFeedCategory[]>([])

// -- Date range draft (screen 43) --------------------------------------------
//
// Two-tap range: first tap sets `from`, second sets `to` (swapped if the user
// taps an earlier day second); a third tap starts a new range. Dates are kept
// as YYYY-MM-DD day keys; emitted as ISO day-bounds on apply.

const dateExpanded = ref(false)
const draftFrom = ref<string | null>(null) // YYYY-MM-DD
const draftTo = ref<string | null>(null) // YYYY-MM-DD

// The month currently shown in the grid (1st of month, local).
const viewMonth = ref<Date>(firstOfMonth(new Date()))

/** 1-е число месяца, в котором лежит `d`. */
function startOfMonth(d: Date): Date {
  return firstOfMonth(d)
}

/** Extract the YYYY-MM-DD date part from a YYYY-MM-DD or full ISO string. */
function extractDatePart(s: string): string {
  // Keep only the date part; the grid works in whole days.
  return s.slice(0, 10)
}

/**
 * UTC instant (ms) of local midnight for a YYYY-MM-DD day key in IANA `tz`.
 * W-1: the calendar produces local day keys, so the range bounds must be the
 * day's start/end IN THE USER'S TIMEZONE, not UTC midnight (a `...Z` suffix on
 * a local key shifts the boundary by the tz offset and clips events near
 * midnight for non-UTC users). Computed by formatting a probe instant in `tz`
 * and applying the resulting offset; DST-correct.
 */
function startOfDayUtcMs(dayKey: string, tz: string): number {
  const [y = 0, m = 1, d = 1] = dayKey.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0, 0)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .formatToParts(new Date(guess))
    .filter((p) => p.type !== 'literal')
    .reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value
      return acc
    }, {})
  let h = Number(parts.hour)
  if (h === 24) h = 0
  const tzClock = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    h,
    Number(parts.minute),
    Number(parts.second),
  )
  return guess - (tzClock - guess)
}

/** YYYY-MM-DD of the day after `dayKey`. */
function nextDayKey(dayKey: string): string {
  const [y = 0, m = 1, d = 1] = dayKey.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  t.setUTCDate(t.getUTCDate() + 1)
  return t.toISOString().slice(0, 10)
}

const MONTH_LABELS = [
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
const WEEKDAY_LABELS = ['ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ', 'ВС']

const monthTitle = computed(
  () => `${MONTH_LABELS[viewMonth.value.getMonth()]} ${viewMonth.value.getFullYear()}`,
)

// Calendar cells: Monday-first 6x7 grid; null = padding day (other month).
interface Cell {
  key: string | null
  num: number | null
}

const monthCells = computed<Cell[]>(() => {
  const year = viewMonth.value.getFullYear()
  const month = viewMonth.value.getMonth() + 1 // 1..12
  const lead = firstWeekdayMonFirst(year, month)
  const dim = daysInMonth(year, month)

  const cells: Cell[] = []
  for (let i = 0; i < lead; i++) cells.push({ key: null, num: null })
  for (let day = 1; day <= dim; day++) {
    cells.push({ key: dayKeyOf(year, month, day), num: day })
  }
  // Pad the tail to a full week so the grid keeps 7 columns.
  while (cells.length % 7 !== 0) cells.push({ key: null, num: null })
  return cells
})

function prevMonth(): void {
  viewMonth.value = shiftMonthDate(viewMonth.value, -1)
}
function nextMonth(): void {
  viewMonth.value = shiftMonthDate(viewMonth.value, 1)
}

function onDayTap(key: string): void {
  // No range yet, or a complete range exists -> start a fresh range.
  if (!draftFrom.value || draftTo.value) {
    draftFrom.value = key
    draftTo.value = null
    return
  }
  // Second tap: complete the range, ordering the two ends.
  if (key < draftFrom.value) {
    draftTo.value = draftFrom.value
    draftFrom.value = key
  } else {
    draftTo.value = key
  }
}

function isRangeStart(key: string | null): boolean {
  return key !== null && key === draftFrom.value
}
function isRangeEnd(key: string | null): boolean {
  return key !== null && key === draftTo.value
}
function isInRange(key: string | null): boolean {
  if (key === null || !draftFrom.value) return false
  const end = draftTo.value ?? draftFrom.value
  return key >= draftFrom.value && key <= end
}

const dateSummary = computed(() => {
  if (!draftFrom.value) return 'Выбрать дату'
  if (!draftTo.value) return draftFrom.value
  return `${draftFrom.value} — ${draftTo.value}`
})

function clearDates(): void {
  draftFrom.value = null
  draftTo.value = null
}

/** Sync the draft from incoming props whenever the modal opens. */
watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return
    draft.value = [...props.categories]
    draftFrom.value = props.dateFrom ? extractDatePart(props.dateFrom) : null
    draftTo.value = props.dateTo ? extractDatePart(props.dateTo) : null
    // Open the grid on the selected from-date's month, else current month.
    viewMonth.value = startOfMonth(draftFrom.value ? new Date(draftFrom.value) : new Date())
    dateExpanded.value = false
  },
  { immediate: true },
)

function selectAll(): void {
  // "Все" == empty selection.
  draft.value = []
}

function toggle(value: DiaryFeedCategory): void {
  const idx = draft.value.indexOf(value)
  if (idx === -1) draft.value = [...draft.value, value]
  else draft.value = draft.value.filter((c) => c !== value)
}

function onApply(): void {
  // Day keys -> inclusive bounds in the USER'S timezone (W-1). The end of the
  // range is the start of the day AFTER `to`, minus 1ms -- DST-safe and avoids
  // clipping events near local midnight for non-UTC users.
  const tz = props.timezone ?? 'UTC'
  const from = draftFrom.value
    ? new Date(startOfDayUtcMs(draftFrom.value, tz)).toISOString()
    : undefined
  // Single-day range (only `from` tapped) covers that whole day.
  const toKey = draftTo.value ?? draftFrom.value
  const to = toKey ? new Date(startOfDayUtcMs(nextDayKey(toKey), tz) - 1).toISOString() : undefined
  emit('apply', {
    categories: [...draft.value],
    date_from: from,
    date_to: to,
  })
  emit('close')
}

function onReset(): void {
  draft.value = []
  clearDates()
  // Reset is one click: with the draft cleared, onApply emits empty filters
  // (feed shows everything) and closes the modal.
  onApply()
}
</script>

<style scoped>
.diary-filter {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.diary-filter__header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.diary-filter__header-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--velo-size-40);
  height: var(--velo-size-40);
  flex-shrink: 0;
  border-radius: var(--radius-full);
  background: var(--velo-primary);
  color: var(--velo-white);
}

.diary-filter__header-icon svg {
  width: 18px;
  height: 18px;
}

.diary-filter__heading {
  font-family: var(--font-body);
  font-size: var(--text-lg);
  font-weight: 400;
  color: var(--velo-text-primary);
  margin: 0;
}

.diary-filter__group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.diary-filter__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

/* (filter chips now provided by <VChip size="md" clickable>) */

/* -- Date range (screen 43) -- */
.diary-filter__date-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: var(--space-3) var(--space-4);
  border: none;
  background: var(--velo-primary);
  border-radius: var(--radius-full);
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-white);
  cursor: pointer;
}

.diary-filter__date-summary {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.diary-filter__date-caret {
  flex-shrink: 0;
  transform: rotate(90deg);
  transition: transform var(--transition-fast);
}

.diary-filter__date-caret--open {
  transform: rotate(-90deg);
}

.diary-filter__calendar {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2) 0;
}

.diary-filter__cal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.diary-filter__cal-nav {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  color: var(--velo-text-secondary);
  cursor: pointer;
  border-radius: var(--radius-full);
}

.diary-filter__cal-nav:hover {
  background: var(--velo-glass-blue-15);
}

/* The barrel only ships a right arrow -- mirror it for "previous". */
.diary-filter__cal-nav-prev {
  transform: scaleX(-1);
}

.diary-filter__cal-title {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-primary);
}

.diary-filter__cal-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: var(--space-1);
}

.diary-filter__cal-weekday {
  text-align: center;
  font-family: var(--font-body);
  font-size: var(--text-10);
  color: var(--velo-text-secondary);
  padding-bottom: var(--space-1);
}

.diary-filter__cal-cell {
  aspect-ratio: 1;
}

.diary-filter__cal-day {
  aspect-ratio: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  background: transparent;
  border-radius: var(--radius-full);
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-text-primary);
  cursor: pointer;
  transition: background var(--transition-fast);
}

.diary-filter__cal-day:hover {
  border-color: var(--velo-primary);
}

/* In-range (inclusive of edges): soft fill. */
.diary-filter__cal-day--in {
  background: var(--velo-glass-blue-15);
}

/* Range ends: solid primary. */
.diary-filter__cal-day--edge {
  background: var(--velo-primary);
  color: var(--velo-white);
}

.diary-filter__date-clear {
  align-self: flex-start;
  border: none;
  background: transparent;
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  cursor: pointer;
  padding: 0;
}

.diary-filter__date-clear:hover {
  opacity: 0.8;
}

.diary-filter__actions {
  display: flex;
  gap: var(--space-3);
  margin-top: var(--space-2);
}
</style>
