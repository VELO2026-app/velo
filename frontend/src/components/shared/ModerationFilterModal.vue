<!--
  VELO Frontend -- ModerationFilterModal (Admin DS, 2026-06-14, operator SVG «2 Filter»)

  Filter sheet for the «Модерация» (admin reports) list. VModal (the DS filter-sheet
  base, same as DiaryFilterModal) + funnel header + «Выбрать дату» (opens the reused
  DatePickerSheet «Дата заявки») + three chip groups: Категория / Приоритет / Статус.

  WIRING (honest skeleton, build-full-design-now). Only «Статус» maps to the backend:
  Открытая → pending, Закрытая → resolved (GET /admin/reports `status`). Категория
  (Тикеты/Жалобы/Платежи), Приоритет (P0–P3) and the date have NO backend filter yet —
  the chips are fully selectable but inert until Zod extends the reports endpoint
  (recorded in master-ds-zod-roadmap). The draft applies on close (the design has no
  «Применить» button — closing the sheet IS applying).
-->

<template>
  <VModal :open="open" @close="applyAndClose">
    <div class="mfilter">
      <div class="mfilter__header">
        <span class="mfilter__header-icon"><IconFilter :size="20" /></span>
        <h2 class="mfilter__heading">Фильтр</h2>
      </div>

      <!-- Date (opens the reused DatePickerSheet) -->
      <button type="button" class="mfilter__date" @click="showDate = true">
        <span class="mfilter__date-text">{{ dateLabel }}</span>
        <svg class="mfilter__date-chev" viewBox="0 0 9 14" fill="none">
          <path d="M2 2L7 7L2 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
      </button>

      <!-- Категория -->
      <section class="mfilter__group">
        <h3 class="mfilter__label">Категория</h3>
        <div class="mfilter__chips">
          <VChip size="md" clickable :active="draftCats.length === 0" @click="draftCats = []">
            Все
          </VChip>
          <VChip
            v-for="c in CATEGORIES"
            :key="c.value"
            size="md"
            clickable
            :active="draftCats.includes(c.value)"
            @click="toggle(draftCats, c.value)"
          >
            {{ c.label }}
          </VChip>
        </div>
      </section>

      <!-- Приоритет -->
      <section class="mfilter__group">
        <h3 class="mfilter__label">Приоритет</h3>
        <div class="mfilter__chips">
          <VChip
            v-for="p in PRIORITIES"
            :key="p"
            size="md"
            clickable
            :active="draftPrio.includes(p)"
            @click="toggle(draftPrio, p)"
          >
            {{ p }}
          </VChip>
        </div>
      </section>

      <!-- Статус заявки -->
      <section class="mfilter__group">
        <h3 class="mfilter__label">Статус заявки</h3>
        <div class="mfilter__chips">
          <VChip
            v-for="s in STATUSES"
            :key="s.value"
            size="md"
            clickable
            :active="draftStatus.includes(s.value)"
            @click="toggle(draftStatus, s.value)"
          >
            {{ s.label }}
          </VChip>
        </div>
      </section>

      <!-- Reset: clears all drafts, stays open (closing the sheet applies). -->
      <VButton variant="ghost" block :disabled="!hasActiveFilters" @click="resetFilters">
        Сбросить
      </VButton>
    </div>
  </VModal>

  <!-- Date picker (reused master DS sheet, retitled «Дата заявки») -->
  <DatePickerSheet
    :open="showDate"
    :model-value="draftDate"
    title="Дата заявки"
    @update:model-value="draftDate = $event"
    @close="showDate = false"
  />
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { VModal, VChip, VButton } from '@/components/ui'
import { IconFilter } from '@/components/icons'
import DatePickerSheet from '@/components/shared/DatePickerSheet.vue'
import { formatRelative } from '@/utils/adminHelpers'
import type { ModerationFilter } from './moderationFilter'

const props = defineProps<{
  open: boolean
  value: ModerationFilter
}>()

const emit = defineEmits<{
  apply: [value: ModerationFilter]
  close: []
}>()

const CATEGORIES = [
  { value: 'tickets', label: 'Тикеты' },
  { value: 'complaints', label: 'Жалобы' },
  { value: 'payments', label: 'Платежи' },
]
const PRIORITIES = ['P0', 'P1', 'P2', 'P3']
const STATUSES = [
  { value: 'open', label: 'Открытая' },
  { value: 'closed', label: 'Закрытая' },
]

const draftCats = ref<string[]>([])
const draftPrio = ref<string[]>([])
const draftStatus = ref<string[]>([])
const draftDate = ref('')

const showDate = ref(false)

// Re-seed the draft from the applied value each time the sheet opens.
watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return
    draftCats.value = [...props.value.categories]
    draftPrio.value = [...props.value.priorities]
    draftStatus.value = [...props.value.statuses]
    draftDate.value = props.value.date
  },
  { immediate: true },
)

const dateLabel = computed<string>(() =>
  draftDate.value ? formatRelative(`${draftDate.value}T12:00:00`) : 'Выбрать дату',
)

function toggle(list: string[], v: string): void {
  const i = list.indexOf(v)
  if (i === -1) list.push(v)
  else list.splice(i, 1)
}

const hasActiveFilters = computed<boolean>(
  () =>
    draftCats.value.length > 0 ||
    draftPrio.value.length > 0 ||
    draftStatus.value.length > 0 ||
    draftDate.value !== '',
)

// «Сбросить»: clear every filter to its default and STAY open. Closing the sheet
// then applies the cleared draft (the design has no «Применить» — close = apply).
function resetFilters(): void {
  draftCats.value = []
  draftPrio.value = []
  draftStatus.value = []
  draftDate.value = ''
}

// Design has no «Применить» — closing the sheet applies the current draft.
function applyAndClose(): void {
  emit('apply', {
    categories: [...draftCats.value],
    priorities: [...draftPrio.value],
    statuses: [...draftStatus.value],
    date: draftDate.value,
  })
  emit('close')
}
</script>

<style scoped>
.mfilter {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.mfilter__header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.mfilter__header-icon {
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

.mfilter__heading {
  font-family: var(--font-body);
  font-size: var(--text-xl);
  font-weight: 400;
  color: var(--velo-text-primary);
  margin: 0;
}

/* «Выбрать дату» pill */
.mfilter__date {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: var(--space-2) var(--space-4);
  min-height: 37px;
  border: none;
  background: var(--velo-primary);
  border-radius: var(--radius-full);
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-white);
  letter-spacing: 0.02em;
  cursor: pointer;
}

.mfilter__date-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mfilter__date-chev {
  width: 9px;
  height: 14px;
  flex-shrink: 0;
}

.mfilter__group {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.mfilter__label {
  font-family: var(--font-body);
  font-size: var(--text-base);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0;
}

.mfilter__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
</style>
