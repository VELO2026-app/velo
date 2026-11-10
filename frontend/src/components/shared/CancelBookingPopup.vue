<!--
  VELO Frontend -- CancelBookingPopup Component (Phase F4.1, fixed F5 review)

  Confirmation popup for cancelling a booking. Built on VModal.

  Money theme temporarily removed: the "Are you sure..." subtitle and the
  refund warning (green "Funds will be returned" / red "Funds will NOT be
  returned") are gone for now. TODO: re-add the actual refund texts later.

  F5 review fix:
    W-22: Added loading prop + disabled state on confirm button

  Props:
    booking  -- anything with practice.title + practice.scheduled_at
                (BookingWithPracticeResponse or BookingDetailResponse)
    open     -- controls visibility
    loading  -- true while cancel request is in progress

  Emits:
    close    -- user dismissed the popup
    confirm  -- user confirmed cancellation (parent calls store.cancelBooking)
-->

<template>
  <VModal :open="open" @close="onClose">
    <h2 class="cancel__title">{{ t('bookingCancel.title') }}</h2>
    <!-- The "Are you sure..." subtitle (redundant with the title) and the
         refund / money warning were removed — the money theme is
         temporarily out. TODO: re-add the actual refund texts later. -->

    <!-- Actions — side-by-side: the safe action sits LEFT and gets the
         primary variant (Figma cancel-reservation.svg + the DS pattern for
         destructive-confirm: prominent = safe, subtle/destructive = pink). -->
    <div class="cancel__actions">
      <VButton variant="primary" block :disabled="loading" @click="onClose">
        {{ t('bookingCancel.keep') }}
      </VButton>
      <VButton
        variant="danger"
        block
        :loading="loading"
        :disabled="loading"
        @click="$emit('confirm')"
      >
        {{ t('bookingCancel.confirm') }}
      </VButton>
    </div>
  </VModal>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { VModal, VButton } from '@/components/ui'

// tz-i18n 2.2b: dialog copy via bookingCancel.*.

// Structural minimum: works with both BookingWithPracticeResponse (list)
// and BookingDetailResponse (detail) -- the popup only needs the practice
// title and scheduled_at.
interface CancellableBooking {
  practice: {
    title: string
    scheduled_at: string
  }
}

const props = withDefaults(
  defineProps<{
    booking: CancellableBooking
    open: boolean
    loading?: boolean
  }>(),
  {
    loading: false,
  },
)

const emit = defineEmits<{
  close: []
  confirm: []
}>()

function onClose(): void {
  if (props.loading) return
  emit('close')
}
</script>

<style scoped>
.cancel__title {
  font-family: var(--font-heading);
  font-size: var(--velo-fs-32);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  /* Breathing room before the actions now that the subtitle + warning are gone. */
  margin: 0 0 var(--space-5);
}

/* Actions: side-by-side (F-5.3 sync with Figma cancel-reservation.svg).
 * Each button is block (=100%) — the flex parent splits them in half.
 * Gap space-2 (8) is close to Figma's 11 (diff 3, acceptable visual
 * noise). */
.cancel__actions {
  display: flex;
  flex-direction: row;
  gap: var(--space-2);
}
</style>
