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
         other practice (owner 2026-10-02 retired the FE-24 "For school"
         badge); the master zone keeps its audience_unavailable warning
         instead. -->
  </PracticeListCard>
</template>

<script setup lang="ts">
import { t } from '@/locales'
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
    /** Show date+time instead of time only. The calendar groups by day, so
     *  the date is not needed there (default). On the master's page
     *  practices span different days — show the date there (showDate). */
    showDate?: boolean
  }>(),
  { showDate: false },
)

defineEmits<{
  click: [id: string]
}>()

// F5: render the time in the viewer's own profile timezone (the profile decides).
const viewerTz = useViewerTimezone()

// Under the icon (the `when` slot): a short date (showDate, the master's
// page — practices span different days) or time only (the calendar —
// already grouped by day).
const time = computed(() =>
  props.showDate
    ? formatShortDate(props.practice.scheduled_at, viewerTz.value)
    : formatTime(props.practice.scheduled_at, viewerTz.value),
)

// The duration meta cell. On the master's page (showDate) the DATE sits
// under the icon, so the time of day is folded in here:
// `09:00 · <duration>` — otherwise same-day practices at different times
// would be indistinguishable. In the calendar the time is already under
// the icon, so only the duration remains.
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
    return { label: t('calendarCard.paid'), variant: 'success', paid: true }
  }
  if (props.practice.is_free) {
    return { label: t('common.free'), variant: 'blue', paid: false }
  }
  return {
    label: formatMoney(props.practice.price_cents, props.practice.currency),
    variant: 'blue',
    paid: false,
  }
})
</script>
