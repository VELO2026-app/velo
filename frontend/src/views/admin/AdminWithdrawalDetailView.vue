<!--
  VELO Frontend -- AdminWithdrawalDetailView (Admin DS, 2026-06-14, operator SVGs
  «Withdrawal request» + «Confirm payment» + «Confirm payment 2»)

  Admin reviews a single payout request: hero (amount + master) + breakdown (bank /
  provider fee / net) + Отклонить / Подтвердить. Подтвердить → ConfirmPaymentModal →
  TwoFactorModal → approve.

  DATA is REAL: the withdrawal is handed via router state; approve/reject hit the live
  admin endpoints (POST /admin/withdrawals/:id/approve|reject). Amount / fee / net /
  currency / payout method come from AdminWithdrawalResponse.
  STUB (build-full-design-now): the master display name is NOT in the payload (only
  user_id + payout account_holder) → shows the bank holder or «—»; the 2FA code has no
  backend (approve takes only an optional note) → the OTP is a UI gate, approve fires on
  submit. Roadmap (Zod): master name on the withdrawal payload + a real 2FA verify step.
-->

<template>
  <div class="wd">
    <header class="wd__top">
      <VBackButton @click="router.back()" />
      <span class="wd__title">Запрос на вывод</span>
    </header>

    <template v-if="w">
      <!-- Hero -->
      <div class="wd__hero">
        <div class="wd__hero-label">Выплата</div>
        <div class="wd__hero-amount">{{ grossLabel }}</div>
        <div class="wd__hero-master">{{ masterName }}</div>
      </div>

      <!-- Breakdown -->
      <VCard class="wd__rows" padding="none">
        <div class="wd__row">
          <span class="wd__k">Банк</span>
          <span class="wd__v">{{ bankLabel }}</span>
        </div>
        <div class="wd__row">
          <span class="wd__k">Комиссия провайдера</span>
          <span class="wd__v">{{ feeLabel }}</span>
        </div>
        <div class="wd__row">
          <span class="wd__k">К получению</span>
          <span class="wd__v">{{ netLabel }}</span>
        </div>
      </VCard>

      <!-- Actions (pending only) -->
      <div v-if="isPending" class="wd__foot">
        <VButton variant="danger" :disabled="anyLoading" @click="openReject">Отклонить</VButton>
        <VButton variant="primary" :disabled="anyLoading" @click="showConfirm = true">
          Подтвердить
        </VButton>
      </div>
      <VCard v-else class="wd__processed">
        Запрос уже обработан — статус: <strong>{{ statusLabel }}</strong>
      </VCard>
    </template>

    <VCard v-else><p class="wd__empty">Запрос недоступен</p></VCard>

    <!-- Reject reason -->
    <VBottomSheet
      :open="showReject"
      title="Причина отклонения"
      save-label="Отклонить выплату"
      @save="onReject"
      @close="showReject = false"
    >
      <VTextarea
        v-model="rejectReason"
        placeholder="Укажите причину отклонения выплаты"
        :rows="3"
        :error="rejectError"
      />
    </VBottomSheet>

    <!-- Confirm → 2FA flow -->
    <ConfirmPaymentModal
      :open="showConfirm"
      :amount="grossLabel"
      :fee="feeLabel"
      :net="netLabel"
      :bank="bankLabel"
      :master="masterName"
      @confirm="onConfirm"
      @close="showConfirm = false"
    />
    <TwoFactorModal
      :open="showTwoFa"
      :amount="grossLabel"
      :master="masterName"
      :loading="approving"
      @submit="onApprove"
      @close="showTwoFa = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { VBackButton, VCard, VButton, VTextarea, VBottomSheet } from '@/components/ui'
import ConfirmPaymentModal from '@/components/shared/ConfirmPaymentModal.vue'
import TwoFactorModal from '@/components/shared/TwoFactorModal.vue'
import { useToast } from '@/composables/useToast'
import { approveWithdrawal, rejectWithdrawal } from '@/api/admin'
import type { AdminWithdrawalResponse } from '@/api/admin'
import { extractApiError } from '@/composables/useApiError'
import { formatMoney } from '@/utils/format'

const router = useRouter()
const toast = useToast()

// Handed via router state by the originating list (no GET-by-id endpoint).
const w = ref<AdminWithdrawalResponse | null>(
  (window.history.state as { withdrawal?: AdminWithdrawalResponse }).withdrawal ?? null,
)

// W-5: the withdrawal arrives ONLY via router state, so a deep-link or a page
// reload leaves w null -> '—' placeholders, disabled actions, and a VBackButton
// that runs router.back() out of the app (dead-end). Bounce to the list instead
// of stranding the admin on a blank screen.
onMounted((): void => {
  if (!w.value) router.replace('/admin/withdrawals')
})

const showReject = ref(false)
const rejectReason = ref('')
const rejectError = ref('')
const showConfirm = ref(false)
const showTwoFa = ref(false)
const approving = ref(false)
const rejecting = ref(false)

const anyLoading = computed<boolean>(() => approving.value || rejecting.value)
const isPending = computed<boolean>(() => w.value?.status === 'pending')

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
const payoutDetails = computed<Record<string, unknown>>(
  () => (w.value?.payout_details.details ?? {}) as Record<string, unknown>,
)

// No master name on the payload → fall back to the bank account holder, else «—».
const masterName = computed<string>(() => str(payoutDetails.value.account_holder) || '—')

function money(cents: number | undefined): string {
  if (cents === undefined || !w.value) return '—'
  return formatMoney(cents, w.value.currency, 'ru', true)
}
const grossLabel = computed<string>(() => money(w.value?.amount_cents))
const feeLabel = computed<string>(() => money(w.value?.fee_cents))
const netLabel = computed<string>(() =>
  w.value ? money(w.value.amount_cents - w.value.fee_cents) : '—',
)

const bankLabel = computed<string>(() => {
  const p = w.value?.payout_details
  if (!p) return '—'
  const d = payoutDetails.value
  if (p.method === 'bank_transfer') {
    const bank = str(d.bank_name) || 'Банк'
    const acc = (str(d.iban) || str(d.account)).replace(/\s+/g, '')
    const tail = acc ? acc.slice(-4) : ''
    return tail ? `${bank} •••• ${tail}` : bank
  }
  if (p.method === 'paypal') return str(d.email) || 'PayPal'
  if (p.method === 'revolut') return str(d.tag) || str(d.phone) || 'Revolut'
  return p.method
})

const STATUS_LABELS: Record<string, string> = {
  pending: 'Ожидает',
  approved: 'Одобрен',
  rejected: 'Отклонён',
}
const statusLabel = computed<string>(() => STATUS_LABELS[w.value?.status ?? ''] ?? '')

function openReject(): void {
  rejectReason.value = ''
  rejectError.value = ''
  showReject.value = true
}

function onConfirm(): void {
  showConfirm.value = false
  showTwoFa.value = true
}

async function onApprove(): Promise<void> {
  if (!w.value || approving.value) return
  approving.value = true
  try {
    await approveWithdrawal(w.value.id)
    toast.success('Выплата одобрена')
    showTwoFa.value = false
    router.back()
  } catch (e) {
    toast.error(extractApiError(e, 'Ошибка одобрения выплаты'))
  } finally {
    approving.value = false
  }
}

async function onReject(): Promise<void> {
  if (!w.value || rejecting.value) return
  rejectError.value = ''
  if (!rejectReason.value.trim()) {
    rejectError.value = 'Укажите причину отклонения'
    return
  }
  rejecting.value = true
  try {
    await rejectWithdrawal(w.value.id, rejectReason.value.trim())
    toast.success('Выплата отклонена')
    showReject.value = false
    router.back()
  } catch (e) {
    toast.error(extractApiError(e, 'Ошибка отклонения выплаты'))
  } finally {
    rejecting.value = false
  }
}
</script>

<style scoped>
.wd {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.wd__top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: var(--velo-size-44);
}

.wd__title {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

/* -- Hero (solid primary) -- */
.wd__hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-8) var(--space-4);
  border-radius: var(--radius-md);
  background: var(--velo-primary);
  color: var(--velo-white);
}

.wd__hero-label {
  font-size: var(--text-xs);
  letter-spacing: 0.02em;
  opacity: 0.85;
}

.wd__hero-amount {
  font-size: var(--text-xl);
  letter-spacing: 0.02em;
}

.wd__hero-master {
  font-size: var(--text-lg);
  letter-spacing: 0.02em;
}

/* -- Breakdown -- */
.wd__rows {
  display: flex;
  flex-direction: column;
  padding: var(--space-3) var(--velo-inset-row);
}

.wd__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) 0;
}

.wd__k {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
}

.wd__v {
  font-size: var(--text-xs);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  text-align: right;
}

/* -- Sticky footer -- */
.wd__foot {
  position: sticky;
  bottom: 0;
  z-index: var(--z-sticky);
  display: flex;
  gap: var(--velo-gap-15);
  margin-top: var(--space-1);
  padding: var(--space-3) 0;
  background: linear-gradient(to top, var(--velo-bg-start) 55%, transparent);
}

.wd__foot :deep(.v-btn) {
  flex: 1;
}

.wd__processed {
  text-align: center;
  font-size: var(--text-sm);
  color: var(--velo-text-muted);
}

.wd__empty {
  margin: 0;
  text-align: center;
  color: var(--velo-text-muted);
  font-size: var(--text-sm);
  padding: var(--space-4) var(--space-2);
}
</style>
