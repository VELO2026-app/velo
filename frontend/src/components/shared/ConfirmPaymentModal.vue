<!--
  VELO Frontend -- ConfirmPaymentModal (Admin DS, 2026-06-14, operator SVG «Confirm payment»)

  The confirmation step of the admin payout approval -- the only one: the 2FA window
  that used to follow it was removed (owner 2026-10-02) because the approve endpoint
  never took a code, so it gated nothing. Recap box (amount / fee / net / bank /
  master) + «Одобрить выплату». Pure presentational: the parent
  (AdminWithdrawalDetailView) passes pre-formatted strings and owns the approve call;
  `loading` keeps a second tap from firing a second approve while the first is in
  flight.
-->

<template>
  <VModal :open="open" @close="$emit('close')">
    <div class="cpm">
      <h2 class="cpm__title">{{ t('payout.title') }}</h2>
      <p class="cpm__sub">{{ t('payout.sub') }}</p>

      <div class="cpm__box">
        <div class="cpm__row">
          <span class="cpm__k">{{ t('payout.amount') }}</span
          ><span class="cpm__v">{{ amount }}</span>
        </div>
        <div class="cpm__row">
          <span class="cpm__k">{{ t('payout.fee') }}</span
          ><span class="cpm__v">{{ fee }}</span>
        </div>
        <div class="cpm__row">
          <span class="cpm__k">{{ t('payout.net') }}</span
          ><span class="cpm__v">{{ net }}</span>
        </div>
        <div class="cpm__row">
          <span class="cpm__k">{{ t('payout.bank') }}</span
          ><span class="cpm__v">{{ bank }}</span>
        </div>
        <div class="cpm__row">
          <span class="cpm__k">{{ t('payout.master') }}</span
          ><span class="cpm__v">{{ master }}</span>
        </div>
      </div>

      <VButton variant="primary" block :loading="loading" @click="$emit('confirm')">
        {{ t('payout.approve') }}
      </VButton>
    </div>
  </VModal>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { VModal, VButton } from '@/components/ui'

// tz-i18n 2.2b: payout sheet copy via payout.*.
const { t } = useI18n({ useScope: 'global' })

defineProps<{
  open: boolean
  amount: string
  fee: string
  net: string
  bank: string
  master: string
  loading?: boolean
}>()

defineEmits<{
  confirm: []
  close: []
}>()
</script>

<style scoped>
.cpm {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  text-align: center;
}

.cpm__title {
  font-family: var(--font-body);
  font-size: var(--text-lg);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0;
}

.cpm__sub {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
  margin: -8px 0 0;
}

.cpm__box {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  border: 1px solid var(--velo-text-primary);
  border-radius: var(--radius-md);
}

.cpm__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.cpm__k {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
}

.cpm__v {
  font-size: var(--text-xs);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  text-align: right;
}
</style>
