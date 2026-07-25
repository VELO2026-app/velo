<!--
  VELO Frontend -- CalendarView (Calendar iteration, frames 1 & 3)

  The Calendar screen:
    - Title "Календарь"
    - WeekStrip: week selector with day dot-markers (frame 1)
    - "Выбрать практики" control:
        collapsed -> pill + funnel icon (opens CalendarFilterModal)
        expanded  -> active-filter chips (tap a chip to remove) + collapse
      (Variant 1: the modal is the single source of filter editing; the
       inline chips only DISPLAY the current selection and allow removal.)
    - Day sections grouped by date ("Сегодня" / "Завтра" / "28 февраля")
    - CalendarPracticeCard per practice
    - loading / error / empty states

  Data comes from useCalendarStore (separate from the Dashboard feed).
  The whole visible week is loaded in one request; the selected-day list
  and dot-markers are derived client-side.
-->

<template>
  <div class="calendar">
    <!-- Title + week strip float as an island above the fog (G-1); the practice
         list scrolls under it so the date nav is always in place.
         `defer` lets the teleport find the layout's island even on first mount
         (target is rendered by the parent) — avoids the "Invalid Teleport target
         on mount: null" crash that blanked the heading + broke the screen. -->
    <Teleport defer to=".mobile-layout__island" :disabled="!floating">
      <div class="calendar__island" :class="{ 'calendar__island--floating': floating }">
        <h1 class="calendar__heading">Календарь</h1>

        <!-- Week selector -->
        <WeekStrip
          :days="store.days"
          :selected-date="store.selectedDate"
          :days-with-practices="store.daysWithPractices"
          :local-date-key="store.localDateKey"
          :can-go-prev="store.canGoPrev"
          @select-day="store.selectDay"
          @prev-week="store.prevWeek"
          @next-week="store.nextWeek"
        />
      </div>
    </Teleport>

    <!-- "Выбрать практики" control -->
    <div class="calendar__selector">
      <!-- Collapsed: pill + funnel -->
      <button v-if="!expanded" type="button" class="calendar__select-pill" @click="expanded = true">
        <span class="calendar__select-label">Выбрать практики</span>
        <span class="calendar__funnel" @click.stop="showFilter = true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path
              d="M3 5h18l-7 8v6l-4 2v-8L3 5z"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linejoin="round"
            />
          </svg>
        </span>
      </button>

      <!-- Expanded: active-filter chips + collapse -->
      <VCard v-else class="calendar__expanded" padding="sm">
        <div class="calendar__chips">
          <button type="button" class="calendar__chip calendar__chip--all" @click="openFilter">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path
                d="M3 5h18l-7 8v6l-4 2v-8L3 5z"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linejoin="round"
              />
            </svg>
            Фильтр
          </button>

          <button
            v-for="chip in activeChips"
            :key="chip.key"
            type="button"
            class="calendar__chip calendar__chip--on"
            @click="removeChip(chip)"
          >
            <IconCheck :size="12" />
            {{ chip.label }}
          </button>

          <span v-if="activeChips.length === 0" class="calendar__chips-empty">
            Фильтры не выбраны
          </span>
        </div>

        <button
          type="button"
          class="calendar__collapse"
          aria-label="Свернуть"
          @click="expanded = false"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path
              d="M6 15l6-6 6 6"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </VCard>
    </div>

    <!-- Loading (initial) -->
    <div v-if="store.loading && dayPractices.length === 0" class="calendar__loader">
      <VLoader />
    </div>

    <!-- Error -->
    <VEmptyState
      v-else-if="store.error"
      icon="warning"
      title="Не удалось загрузить"
      :description="store.error"
    >
      <VButton size="sm" @click="store.loadWeek()">Повторить</VButton>
    </VEmptyState>

    <!-- Empty: no practices on the selected day -->
    <VEmptyState
      v-else-if="dayPractices.length === 0"
      title="Нет практик"
      description="На этот день практик нет. Выберите другой день или измените фильтры."
    >
      <template #icon><IconClock :size="48" /></template>
    </VEmptyState>

    <!-- Selected-day practices -->
    <div v-else class="calendar__list">
      <h3 class="calendar__date-header">{{ dayLabel }}</h3>
      <CalendarPracticeCard
        v-for="p in dayPractices"
        :key="p.id"
        :practice="p"
        @click="goToDetail"
      />
    </div>

    <!-- Filter modal -->
    <CalendarFilterModal
      :open="showFilter"
      :filters="store.filters"
      @apply="store.applyFilters"
      @close="showFilter = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useCalendarStore } from '@/stores/calendar'
import { VLoader, VEmptyState, VButton, VCard } from '@/components/ui'
import WeekStrip from '@/components/shared/WeekStrip.vue'
import { useFloatingHeader } from '@/components/layout/useFloatingHeader'
import CalendarPracticeCard from '@/components/shared/CalendarPracticeCard.vue'
import CalendarFilterModal from '@/components/shared/CalendarFilterModal.vue'
import { IconCheck, IconClock } from '@/components/icons'
import { formatDateShort } from '@/utils/format'
import { useViewerTimezone } from '@/composables/useViewerTimezone'
import {
  DIFFICULTY_LABEL,
  DURATION_BUCKET_LABEL,
  TIME_OF_DAY_LABEL,
} from '@/utils/displayHelpers'
// T2 stage 2 (2026-07-15): direction chip label goes through directionLabel()
// (hardcoded first, catalog second, raw value last resort), NOT the strict
// DIRECTION_LABEL[Record<PracticeDirection,string>] -- a catalog-only
// direction (CalendarFilterModal now offers one) is not a member of that
// closed union and would render as undefined. Warmed by CalendarFilterModal's
// own onMounted catalog fetch (this view's direct child, mounted alongside).
import { directionLabel } from '@/utils/methodTaxonomy'
import type { PracticeResponse } from '@/api/types'
import type { CalendarFacetFilters } from '@/stores/calendar'

const router = useRouter()
const store = useCalendarStore()
const viewerTz = useViewerTimezone()

// Title + week strip float as an island (G-1): the date nav stays in place while
// the practice list scrolls under it.
const floating = useFloatingHeader()

const expanded = ref(false)
const showFilter = ref(false)

function openFilter(): void {
  showFilter.value = true
}

// Practices on the selected day (already sorted by the store).
const dayPractices = computed<PracticeResponse[]>(() => store.selectedDayPractices)

// Section header for the selected day ("Сегодня" / "Завтра" / "28 января"),
// derived from the VIEWER's profile timezone (SW2) -- matching the store's
// own viewer-tz bucketing (store.ts selectedDayPractices) and the cards'
// rendered time, never the first practice's own timezone. dayLabel is only
// read from the template's content branch (v-else, gated on
// dayPractices.length > 0), so a first practice is always present here.
const dayLabel = computed<string>(() => {
  const first = dayPractices.value[0]!
  return formatDateShort(first.scheduled_at, viewerTz.value)
})

// -- Active filter chips (display + removal) --
type ChipKind =
  | 'direction'
  | 'difficulty'
  | 'practice_type'
  | 'duration_bucket'
  | 'time_of_day'
  | 'style'
interface ActiveChip {
  key: string
  kind: ChipKind
  value: string
  label: string
}

const TYPE_LABEL: Record<string, string> = {
  live: 'Live',
  series: 'Серии',
  one_on_one: 'Личные',
  replay: 'Записи',
}

const activeChips = computed<ActiveChip[]>(() => {
  const f = store.filters
  const chips: ActiveChip[] = []

  for (const v of f.direction ?? []) {
    chips.push({ key: `dir:${v}`, kind: 'direction', value: v, label: directionLabel(v) })
  }
  for (const v of f.difficulty ?? []) {
    chips.push({ key: `dif:${v}`, kind: 'difficulty', value: v, label: DIFFICULTY_LABEL[v] })
  }
  for (const v of f.practice_type ?? []) {
    chips.push({ key: `typ:${v}`, kind: 'practice_type', value: v, label: TYPE_LABEL[v] ?? v })
  }
  if (f.duration_bucket) {
    chips.push({
      key: `dur:${f.duration_bucket}`,
      kind: 'duration_bucket',
      value: f.duration_bucket,
      label: DURATION_BUCKET_LABEL[f.duration_bucket],
    })
  }
  if (f.time_of_day) {
    chips.push({
      key: `tod:${f.time_of_day}`,
      kind: 'time_of_day',
      value: f.time_of_day,
      label: TIME_OF_DAY_LABEL[f.time_of_day],
    })
  }
  // Style chips are intentionally NOT shown in the active-filter row: the
  // direction chip already represents the selection, and listing every style
  // (often 3-5, in transliterated names) is visual clutter. Styles stay
  // editable inside the filter modal. Removing the direction clears them.

  return chips
})

/** Remove a single active filter and reload the week. */
function removeChip(chip: ActiveChip): void {
  const f = store.filters
  const next: CalendarFacetFilters = {
    direction: f.direction ? [...f.direction] : undefined,
    difficulty: f.difficulty ? [...f.difficulty] : undefined,
    practice_type: f.practice_type ? [...f.practice_type] : undefined,
    style: f.style ? [...f.style] : undefined,
    duration_bucket: f.duration_bucket,
    time_of_day: f.time_of_day,
  }

  switch (chip.kind) {
    case 'direction':
      next.direction = (next.direction ?? []).filter((v) => v !== chip.value)
      if (next.direction.length === 0) {
        next.direction = undefined
        // Styles belong to a direction; with no direction left they would be
        // orphaned (a style filter without its direction). Clear them too.
        next.style = undefined
      }
      break
    case 'difficulty':
      next.difficulty = (next.difficulty ?? []).filter((v) => v !== chip.value)
      if (next.difficulty.length === 0) next.difficulty = undefined
      break
    case 'practice_type':
      next.practice_type = (next.practice_type ?? []).filter((v) => v !== chip.value)
      if (next.practice_type.length === 0) next.practice_type = undefined
      break
    case 'duration_bucket':
      next.duration_bucket = undefined
      break
    case 'time_of_day':
      next.time_of_day = undefined
      break
    case 'style':
      // F-8: удалить ровно ОДИН стиль (multi-select).
      next.style = (next.style ?? []).filter((v) => v !== chip.value)
      if (next.style.length === 0) next.style = undefined
      break
  }

  store.applyFilters(next)
}

function goToDetail(id: string): void {
  router.push({ name: 'practice-detail', params: { id } })
}

onMounted(() => {
  store.init()
})
</script>

<style scoped>
.calendar {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.calendar__heading {
  font-family: var(--font-body);
  /* Figma 2266:2307 — заголовок 18 (text-base), не text-lg. */
  font-size: var(--text-base);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0;
}

/* Title + week strip wrapper. */
.calendar__island {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* Floating island variant (G-1): teleported into MobileLayout's island layer.
   Rail-aligned with the +20px top offset; the date-nav cluster (title + week
   strip) catches taps as a unit while the practice list scrolls under it. */
.calendar__island--floating {
  gap: var(--space-3);
  padding: calc(var(--space-3) + 20px) var(--velo-rail-pad-x) var(--space-3);
  pointer-events: auto;
}

/* -- Selector -- */
.calendar__selector {
  display: flex;
}

.calendar__select-pill {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  height: var(--velo-size-50);
  padding: 0 var(--space-5);
  background: var(--velo-primary);
  border: 1px solid var(--velo-glass-border);
  border-radius: var(--radius-full);
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.calendar__select-pill:hover {
  opacity: 0.92;
}

.calendar__select-label {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-white);
}

.calendar__funnel {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--velo-white);
}

.calendar__expanded {
  flex: 1;
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}

.calendar__chips {
  flex: 1;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.calendar__chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius-full);
  font-family: var(--font-body);
  font-size: var(--text-xs);
  cursor: pointer;
  transition: opacity var(--transition-fast);
  white-space: nowrap;
}

.calendar__chip:hover {
  opacity: 0.85;
}

.calendar__chip--on {
  background: var(--velo-primary);
  color: var(--velo-white);
}

.calendar__chip--all {
  background: var(--velo-glass-blue-15);
  color: var(--velo-text-secondary);
}

.calendar__chips-empty {
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  align-self: center;
}

.calendar__collapse {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--velo-text-secondary);
  cursor: pointer;
}

/* -- Day list -- */
.calendar__date-header {
  font-family: var(--font-body);
  font-size: var(--text-base);
  font-weight: 400;
  color: var(--velo-text-primary);
  margin: var(--space-2) 0 var(--space-1);
}

.calendar__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.calendar__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-8) 0;
}
</style>
