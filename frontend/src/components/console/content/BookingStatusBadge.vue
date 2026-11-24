<!--
  VELO Frontend -- BookingStatusBadge (FE-262)

  The status of one booking as a badge: confirmed, attended, no_show,
  pending. A status the screen does not know is shown as it came.
-->

<template>
  <ConsoleStatusBadge
    :tone="known ? TONES[status as BookingStatus] : 'neutral'"
    data-testid="booking-status"
  >
    {{ known ? t(`console.practices.detail.booking.${status}`) : status }}
  </ConsoleStatusBadge>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed } from 'vue'
import ConsoleStatusBadge from '@/components/console/content/ConsoleStatusBadge.vue'

/** A booking status the API sends for a live (not cancelled) booking. */
type BookingStatus = 'confirmed' | 'attended' | 'no_show' | 'pending'

const TONES: Record<BookingStatus, 'success' | 'warning' | 'error' | 'info'> = {
  confirmed: 'info',
  attended: 'success',
  no_show: 'error',
  pending: 'warning',
}

const props = defineProps<{
  /** Booking status as the API sends it. */
  status: string
}>()

const known = computed(() => Object.hasOwn(TONES, props.status))
</script>
