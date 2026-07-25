<!--
  VELO Frontend -- BookingCard Component (screen 17, My reservations)

  Thin wrapper around the shared PracticeListCard. Renders a booking with
  its date in the meta-left slot and a status badge in the badge slot.

  The parent (MyBookingsView) decides which badge to show via the `badge` prop
  (live / today / tomorrow / done / cancelled / no_show). This card just renders.

  Layout / spacing live in PracticeListCard.vue (DS).

  Usage:
    <BookingCard :booking="b" :badge="badgeFor(b)" @click="openDetail(b)" />
-->

<template>
  <PracticeListCard
    :practice="booking.practice"
    :when="formattedDate"
    :duration="timeAndDuration"
    :clickable="clickable"
    @click="$emit('click')"
  >
    <template #badge>
      <VBadge v-if="badge" :variant="vbadgeVariant">
        <span v-if="badge.variant === 'live'" class="booking-card__live-dot" />
        <component :is="badgeIcon" v-else-if="badgeIcon" :size="12" />
        {{ badge.label }}
      </VBadge>
    </template>
  </PracticeListCard>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { formatShortDate, formatTime, formatDuration } from '@/utils/format'
import { IconCheck, IconClock, IconClose } from '@/components/icons'
import { VBadge } from '@/components/ui'
import PracticeListCard from '@/components/shared/PracticeListCard.vue'
import { useViewerTimezone } from '@/composables/useViewerTimezone'
import type { BookingWithPracticeResponse } from '@/api/types'

/** Badge descriptor passed by the parent (null = no badge). */
export interface BookingBadge {
  label: string
  variant: 'live' | 'today' | 'tomorrow' | 'done' | 'cancelled' | 'no_show' | 'calculating'
}

const props = withDefaults(
  defineProps<{
    booking: BookingWithPracticeResponse
    badge?: BookingBadge | null
    clickable?: boolean
  }>(),
  {
    badge: null,
    clickable: true,
  },
)

defineEmits<{
  click: []
}>()

const badgeIcon = computed(() => {
  if (!props.badge) return null
  switch (props.badge.variant) {
    case 'today':
      return IconClock
    case 'tomorrow':
      return IconClock
    case 'done':
      return IconCheck
    case 'cancelled':
      return IconClose
    default:
      return null // no_show («Не состоялась») / live / calculating → no icon
  }
})

// Map the booking status to a DS VBadge variant (no hand-rolled badge styling).
// live / today / done -> success (teal), tomorrow -> warning (peach),
// cancelled / no_show / calculating -> error/muted. teal aligns to the DS
// canon (teal-600).
const vbadgeVariant = computed<'success' | 'warning' | 'error' | 'muted'>(() => {
  switch (props.badge?.variant) {
    case 'tomorrow':
      return 'warning'
    case 'cancelled':
      return 'error'
    case 'no_show':
      return 'muted' // «Не состоялась» — low-key blue-grey, no drama
    case 'calculating':
      return 'muted' // AT-2: «Подсчитывается» — same low-key tone, not a verdict yet
    default:
      return 'success'
  }
})

// F5: render the date in the viewer's own profile timezone (the profile decides).
const viewerTz = useViewerTimezone()

const formattedDate = computed(() =>
  formatShortDate(props.booking.practice.scheduled_at, viewerTz.value),
)

// Дата под иконкой — короткая (список идёт по разным дням), поэтому время суток
// складываем в мета-ячейку рядом с длительностью: «13:00 · 45 мин» (тот же
// приём, что на странице мастера). Иначе на карточке брони не видно времени.
const timeAndDuration = computed(() => {
  const time = formatTime(props.booking.practice.scheduled_at, viewerTz.value)
  const dur = formatDuration(props.booking.practice.duration_minutes)
  return `${time} · ${dur}`
})
</script>

<style scoped>
/* Only the "live" pulse dot is bespoke — the badge shell itself is the DS VBadge
   (success/warning/error). The dot lives inside the badge slot. */
.booking-card__live-dot {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  background: var(--velo-teal-600);
  flex-shrink: 0;
}
</style>
