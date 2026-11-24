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
import { computed, type Component } from 'vue'
import { formatShortDate, formatTime, formatDuration } from '@/utils/format'
import { IconCheck, IconClock, IconClose } from '@/components/icons'
import { VBadge } from '@/components/ui'
import PracticeListCard from '@/components/shared/PracticeListCard.vue'
import { useViewerTimezone } from '@/composables/useViewerTimezone'
import type { BookingWithPracticeResponse } from '@/api/types'

/** Badge descriptor passed by the parent (null = no badge). */
import type { BookingBadge } from './bookingBadge'

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

// One table per mapping: the Record type makes a new badge variant fail here.
const BADGE_ICON: Record<BookingBadge['variant'], Component | null> = {
  today: IconClock,
  tomorrow: IconClock,
  done: IconCheck,
  cancelled: IconClose,
  no_show: null, // i18n:user.screens.myBookings.status.noShow
  live: null,
  calculating: null,
}
const badgeIcon = computed(() => (props.badge ? BADGE_ICON[props.badge.variant] : null))

// Map the booking status to a DS VBadge variant (no hand-rolled badge styling).
// live / today / done -> success (teal), tomorrow -> warning (peach),
// cancelled / no_show / calculating -> error/muted. teal aligns to the DS
// canon (teal-600).
type BadgeTone = 'success' | 'warning' | 'error' | 'muted'
const BADGE_TONE: Record<BookingBadge['variant'], BadgeTone> = {
  live: 'success',
  today: 'success',
  done: 'success',
  tomorrow: 'warning',
  cancelled: 'error',
  no_show: 'muted', // i18n:user.screens.myBookings.status.noShow — low-key blue-grey, no drama
  calculating: 'muted', // AT-2: i18n:user.screens.myBookings.status.counting — same low-key tone, not a verdict yet
}
const vbadgeVariant = computed<BadgeTone>(() =>
  props.badge ? BADGE_TONE[props.badge.variant] : 'success',
)

// F5: render the date in the viewer's own profile timezone (the profile decides).
const viewerTz = useViewerTimezone()

const formattedDate = computed(() =>
  formatShortDate(props.booking.practice.scheduled_at, viewerTz.value),
)

// The date under the icon is short (the list spans different days), so the
// time of day is folded into the meta cell next to the duration
// (`13:00 · <duration>`, the same trick as on the master's page). Otherwise
// the booking card would show no time at all.
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
