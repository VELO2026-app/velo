<!--
  VELO Frontend -- CancelBookingPopup Component (Phase F4.1, fixed F5 review)

  Confirmation popup for cancelling a booking. Built on VModal.

  Money theme temporarily removed: the "Вы уверены…" subtitle and the refund
  warning (green "Средства вернутся" / red "Средства НЕ будут возвращены") are
  gone for now. TODO: re-add the actual refund texts later.

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
    <!-- The "Вы уверены…" subtitle (redundant with the title) and the refund /
         money warning were removed — the money theme is temporarily out.
         TODO: re-add the actual refund texts later. -->

    <!-- Actions — side-by-side, safe action ЛЕВЕЕ и primary-вариант
         (Figma cancel-reservation.svg + DS-паттерн для destructive-confirm:
         prominent = safe, subtle/destructive = pink). -->
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
import { useI18n } from 'vue-i18n'
import { VModal, VButton } from '@/components/ui'

// tz-i18n 2.2b: dialog copy via bookingCancel.*.
const { t } = useI18n({ useScope: 'global' })

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
  font-size: var(--text-xl);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0 0 var(--space-3);
}

/* Title needs a little breathing room before the actions now that the
   subtitle + warning are gone. */
.cancel__title {
  margin-bottom: var(--space-5);
}

/* Actions: side-by-side (F-5.3 sync с Figma cancel-reservation.svg).
 * Каждая кнопка block (=100%) — flex parent делит пополам. Gap space-2 (8)
 * близок к Figma 11 (diff 3, acceptable visual noise). */
.cancel__actions {
  display: flex;
  flex-direction: row;
  gap: var(--space-2);
}
</style>
