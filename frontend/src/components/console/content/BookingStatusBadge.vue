<!--
  VELO Frontend -- BookingStatusBadge (FE-262)

  The status of one booking as a badge: confirmed, attended, no_show,
  pending. A status the screen does not know is shown as it came.
-->

<template>
  <ConsoleBadge
    :tone="isBookingStatus(status) ? TONES[status] : 'muted'"
    data-testid="booking-status"
  >
    {{
      labelOrRaw(status, isBookingStatus, (known) => t(`console.practices.detail.booking.${known}`))
    }}
  </ConsoleBadge>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import ConsoleBadge from '@/components/console/ConsoleBadge.vue'
import { labelOrRaw } from '@/utils/console/labelOrRaw'
import type { ConsoleTone } from '@/utils/console/tone'

const TONES = {
  confirmed: 'info',
  attended: 'success',
  no_show: 'error',
  pending: 'warning',
} as const satisfies Record<string, ConsoleTone>

/** A booking status the API sends for a live (not cancelled) booking. */
type BookingStatus = keyof typeof TONES

function isBookingStatus(status: string): status is BookingStatus {
  return Object.hasOwn(TONES, status)
}

defineProps<{
  /** Booking status as the API sends it. */
  status: string
}>()
</script>
