<!--
  VELO Frontend -- WithdrawalRejectModal (FE-267)

  The reason the admin gives when refusing a payout request: one text field
  and the refuse button. Presentational: the panel owns the reason, its
  error, the pending state and the request.
-->

<template>
  <VModal :open="open" @close="emit('close')">
    <div class="reject">
      <h2 class="reject__title">{{ t('console.finance.withdrawals.rejectModal.title') }}</h2>
      <p class="reject__text">
        {{ t('console.finance.withdrawals.rejectModal.text', { amount }) }}
      </p>
      <VTextarea
        :model-value="reason"
        :label="t('console.finance.withdrawals.rejectModal.reason')"
        :placeholder="t('console.finance.withdrawals.rejectModal.placeholder')"
        :rows="3"
        :error="error"
        @update:model-value="emit('update:reason', $event)"
      />
      <div class="reject__actions">
        <VButton variant="ghost" @click="emit('close')">
          {{ t('console.finance.withdrawals.rejectModal.cancel') }}
        </VButton>
        <VButton variant="danger" :loading="loading" @click="emit('confirm')">
          {{ t('console.finance.withdrawals.rejectModal.submit') }}
        </VButton>
      </div>
    </div>
  </VModal>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { VButton, VModal, VTextarea } from '@/components/ui'

defineProps<{
  open: boolean
  /** The request's amount, formatted. */
  amount: string
  /** The reason typed so far. */
  reason: string
  /** Why the reason is not accepted; empty when it is. */
  error: string
  /** The refusal is being sent. */
  loading: boolean
}>()

const emit = defineEmits<{
  'update:reason': [reason: string]
  confirm: []
  close: []
}>()
</script>

<style scoped>
.reject {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: min(420px, 100%);
}

.reject__title {
  margin: 0;
  font-size: var(--velo-fs-20);
  font-weight: inherit;
  text-align: center;
  color: var(--velo-text-primary);
}

.reject__text {
  margin: 0;
  font-size: var(--velo-fs-14);
  text-align: center;
  color: var(--velo-text-secondary);
}

.reject__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
}
</style>
