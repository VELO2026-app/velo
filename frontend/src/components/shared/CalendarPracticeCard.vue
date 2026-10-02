<!--
  VELO Frontend -- CalendarPracticeCard (DS, 2026-05)

  Thin wrapper around the shared PracticeListCard. Adds calendar-list-specific
  metadata (time + duration) and a paid/free badge derived from the practice.

  Layout / spacing live in PracticeListCard.vue (DS).

  Usage:
    <CalendarPracticeCard :practice="p" @click="goToDetail" />
-->

<template>
  <PracticeListCard
    :practice="practice"
    :when="time"
    :duration="duration"
    @click="$emit('click', practice.id)"
  >
    <template #badge>
      <VBadge :variant="badge.variant">
        <IconCheck v-if="badge.paid" :size="12" />
        {{ badge.label }}
      </VBadge>
    </template>
    <!-- No school-audience marker here: school practices are listed like any
         other practice (owner 2026-10-02 retired the FE-24 «Для школы» badge);
         the master zone keeps its audience_unavailable warning instead. -->
  </PracticeListCard>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { formatShortDate, formatTime, formatDuration, formatMoney } from '@/utils/format'
import { IconCheck } from '@/components/icons'
import { VBadge } from '@/components/ui'
import PracticeListCard from '@/components/shared/PracticeListCard.vue'
import { useViewerTimezone } from '@/composables/useViewerTimezone'
import type { PracticeResponse } from '@/api/types'

const props = withDefaults(
  defineProps<{
    practice: PracticeResponse
    /** Показать дату+время вместо только времени. Календарь группирует по дню,
     *  поэтому там дата не нужна (default). На странице мастера практики идут
     *  в разные дни — там показываем дату (showDate). */
    showDate?: boolean
  }>(),
  { showDate: false },
)

defineEmits<{
  click: [id: string]
}>()

// F5: render the time in the viewer's own profile timezone (the profile decides).
const viewerTz = useViewerTimezone()

// Под иконкой (when): короткая дата (showDate, страница мастера — практики идут
// в разные дни) либо только время (календарь — уже сгруппирован по дню).
const time = computed(() =>
  props.showDate
    ? formatShortDate(props.practice.scheduled_at, viewerTz.value)
    : formatTime(props.practice.scheduled_at, viewerTz.value),
)

// Мета-ячейка длительности. На странице мастера (showDate) под иконкой стоит
// ДАТА, поэтому время суток складываем сюда: «09:00 · 1 ч 15 мин» — иначе
// практики одного дня в разное время были бы неразличимы. В календаре время
// уже под иконкой, поэтому остаётся только длительность.
const duration = computed(() => {
  const dur = formatDuration(props.practice.duration_minutes)
  if (!props.showDate) return dur
  return `${formatTime(props.practice.scheduled_at, viewerTz.value)} · ${dur}`
})

// Badge: paid (VBadge success/teal) > free / price (VBadge blue). Rendered via
// the DS VBadge component — no hand-rolled badge styling (DS source of truth).
interface Badge {
  label: string
  variant: 'success' | 'blue'
  paid: boolean
}

const badge = computed<Badge>(() => {
  if (props.practice.is_paid) {
    return { label: 'Оплачено', variant: 'success', paid: true }
  }
  if (props.practice.is_free) {
    return { label: 'Бесплатно', variant: 'blue', paid: false }
  }
  return {
    label: formatMoney(props.practice.price_cents, props.practice.currency),
    variant: 'blue',
    paid: false,
  }
})
</script>
