<!--
  VELO Frontend -- TicketFilters (FE-262, slice 2)

  The filters of the ticket list as three pills in the list header: category,
  rating and period. A pill that has a filter set is filled; pressing a pill
  opens its choices right under the row (the list column scrolls, so the
  choices are not a floating panel). Category and period take one choice,
  "all" resets; rating takes any of the stars and "no rating". The state is
  not kept here: the screen puts every change into the URL.
-->

<template>
  <div class="ticket-filters" data-testid="ticket-filters" @keydown.esc="open = null">
    <div class="ticket-filters__pills">
      <RequestChip
        v-for="pill in pills"
        :key="pill.key"
        clickable
        :active="pill.active"
        aria-haspopup="true"
        :aria-expanded="open === pill.key"
        :data-testid="`filter-${pill.key}`"
        @click="toggle(pill.key)"
      >
        {{ pill.label }} ▾
      </RequestChip>
    </div>

    <div
      v-if="open"
      class="ticket-filters__choices"
      role="group"
      :aria-label="pillLabel(open)"
      data-testid="filter-choices"
    >
      <RequestChip clickable :active="!isSet(open)" @click="reset(open)">
        {{ t('common.all') }}
      </RequestChip>
      <RequestChip
        v-for="choice in choicesOf(open)"
        :key="choice.value"
        clickable
        :active="isChosen(open, choice.value)"
        @click="choose(open, choice.value)"
      >
        {{ choice.label }}
      </RequestChip>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, ref } from 'vue'
import RequestChip from '@/components/console/requests/RequestChip.vue'
import {
  TICKET_PERIODS,
  TICKET_RATINGS,
  type TicketFilter,
  type TicketPeriod,
} from '@/components/console/requests/ticketFilters'
import type { SupportRatingFilter } from '@/api/support'
import { SUPPORT_CATEGORY_GROUPS, supportCategoryGroupLabel } from '@/utils/supportTopics'

type PillKey = 'category' | 'rating' | 'period'

const props = defineProps<{
  /** The filters now in the URL. */
  modelValue: TicketFilter
}>()

const emit = defineEmits<{
  'update:modelValue': [filter: TicketFilter]
}>()

/** The pill whose choices are open. */
const open = ref<PillKey | null>(null)

function ratingLabel(value: SupportRatingFilter): string {
  return value === 'none' ? t('adminScreens.adminSupport.rating.none') : `${value} ★`
}

function periodLabel(key: TicketPeriod): string {
  if (key === 'today') return t('console.support.filters.today')
  if (key === 'week') return t('console.support.filters.week')
  return t('console.support.filters.month')
}

const pills = computed(() => {
  const f = props.modelValue
  return [
    {
      key: 'category' as const,
      active: f.group !== null,
      label: f.group ? supportCategoryGroupLabel(f.group) : t('console.support.filters.category'),
    },
    {
      key: 'rating' as const,
      active: f.ratings.length > 0,
      label: f.ratings.length
        ? f.ratings.map(ratingLabel).join(', ')
        : t('console.support.filters.rating'),
    },
    {
      key: 'period' as const,
      active: f.period !== null,
      label: f.period ? periodLabel(f.period) : t('console.support.filters.period'),
    },
  ]
})

function pillLabel(key: PillKey): string {
  return pills.value.find((p) => p.key === key)?.label ?? ''
}

function choicesOf(key: PillKey): { value: string; label: string }[] {
  if (key === 'category')
    return SUPPORT_CATEGORY_GROUPS.map((g) => ({
      value: g.key,
      label: supportCategoryGroupLabel(g.key),
    }))
  if (key === 'rating') return TICKET_RATINGS.map((r) => ({ value: r, label: ratingLabel(r) }))
  return TICKET_PERIODS.map((p) => ({ value: p.key, label: periodLabel(p.key) }))
}

function isSet(key: PillKey): boolean {
  return pills.value.find((p) => p.key === key)?.active ?? false
}

function isChosen(key: PillKey, value: string): boolean {
  const f = props.modelValue
  if (key === 'category') return f.group === value
  if (key === 'rating') return f.ratings.includes(value as SupportRatingFilter)
  return f.period === value
}

function toggle(key: PillKey): void {
  open.value = open.value === key ? null : key
}

function reset(key: PillKey): void {
  const f = props.modelValue
  if (key === 'category') emit('update:modelValue', { ...f, group: null })
  else if (key === 'rating') emit('update:modelValue', { ...f, ratings: [] })
  else emit('update:modelValue', { ...f, period: null })
  open.value = null
}

/** Pick a choice: category and period take one and close; rating toggles and stays open. */
function choose(key: PillKey, value: string): void {
  const f = props.modelValue
  if (key === 'category') {
    emit('update:modelValue', { ...f, group: value as TicketFilter['group'] })
    open.value = null
  } else if (key === 'rating') {
    const picked = value as SupportRatingFilter
    const ratings = f.ratings.includes(picked)
      ? f.ratings.filter((r) => r !== picked)
      : [...f.ratings, picked]
    emit('update:modelValue', { ...f, ratings })
  } else {
    emit('update:modelValue', { ...f, period: value as TicketPeriod })
    open.value = null
  }
}
</script>

<style scoped>
.ticket-filters {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.ticket-filters__pills,
.ticket-filters__choices {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.ticket-filters__choices {
  padding: var(--space-2);
  border-radius: var(--velo-radius-10);
  background: var(--velo-bg-subtle);
}
</style>
