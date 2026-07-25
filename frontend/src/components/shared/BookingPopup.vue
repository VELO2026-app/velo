<!--
  VELO Frontend -- BookingPopup Component (Phase F4.1, fixed F5 review)

  Purchase flow popup built on VModal.

  Flow:
    1. Shows practice summary (title, date, master, price)
    2. Optional promo code input + "OK" -> preview-purchase API
    3. Displays discount if promo applied
    4. "Оплатить" button -> purchase API (booking + ledger)
    5. Error handling: insufficient balance, full, already booked

  F5 review fixes:
    C-2: Double tap guard (if purchasing return early)
    C-3: Refresh balance on popup open (watch props.open)

  Props:
    practice   -- PracticeResponse from the detail view
    open       -- controls visibility (v-model pattern via emit)

  Emits:
    close      -- close the popup
    purchased  -- purchase succeeded (parent refreshes data)
-->

<template>
  <VModal :open="open" @close="onClose">
    <h2 class="popup__title">Бронирование</h2>

    <!-- Summary -->
    <div class="popup__summary">
      <div class="popup__row">
        <span class="popup__label">Практика</span>
        <span class="popup__value">{{ practice.title }}</span>
      </div>
      <div class="popup__row">
        <span class="popup__label">Дата</span>
        <span class="popup__value">{{ formattedDate }}</span>
      </div>
      <div class="popup__row">
        <span class="popup__label">Мастер</span>
        <span class="popup__value">{{ practice.master_name ?? 'Мастер' }}</span>
      </div>
    </div>

    <!-- Promo code (temporarily hidden in the prototype; see PROMO_ENABLED) -->
    <div v-if="PROMO_ENABLED" class="popup__promo">
      <input
        v-model.trim="promoCode"
        type="text"
        class="popup__promo-input"
        placeholder="Промокод"
        :disabled="purchasing"
        @keydown.enter="onApplyPromo"
      />
      <VButton
        size="sm"
        variant="secondary"
        :loading="previewing"
        :disabled="!promoCode || purchasing"
        @click="onApplyPromo"
      >
        OK
      </VButton>
    </div>

    <!-- Promo result -->
    <div v-if="PROMO_ENABLED && promoApplied" class="popup__discount">
      <span class="popup__discount-label">Скидка {{ discountPercent }}%</span>
      <span class="popup__discount-value"> −{{ formattedDiscount }} </span>
    </div>

    <!-- Total -->
    <div class="popup__total">
      <span class="popup__total-label">Итого</span>
      <span class="popup__total-value">{{ formattedTotal }}</span>
    </div>

    <!-- Insufficient balance warning -->
    <div v-if="insufficientBalance" class="popup__warning">
      Недостаточно средств. Ваш баланс: {{ balanceStore.formattedBalance }}
    </div>

    <!-- Actions -->
    <div class="popup__actions">
      <VButton
        variant="primary"
        size="lg"
        block
        :loading="purchasing"
        :disabled="purchasing || previewing"
        @click="onPurchase"
      >
        {{ purchaseButtonText }}
      </VButton>
      <VButton variant="ghost" block :disabled="purchasing" @click="onClose"> Отмена </VButton>
    </div>
  </VModal>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { VModal, VButton } from '@/components/ui'
import { useToast } from '@/composables/useToast'
import { useBalanceStore } from '@/stores/balance'
import { purchasePractice, previewPurchase } from '@/api/bookings'
import { ApiResponseError } from '@/api/client'
import { extractApiError } from '@/composables/useApiError'
import { formatDate, formatMoney } from '@/utils/format'
import type { PracticeResponse, PreviewPurchaseResponse } from '@/api/types'

const props = defineProps<{
  practice: PracticeResponse
  open: boolean
}>()

const emit = defineEmits<{
  close: []
  purchased: []
  /** Гонка: места кончились пока юзер читал/бронировал (backend practice_full).
   *  Родитель показывает полноэкранный стейт «Места закончились». */
  soldOut: []
}>()

const router = useRouter()
const toast = useToast()
const balanceStore = useBalanceStore()

// Promo codes are temporarily hidden in the prototype (kept, not removed).
// Flip to true to bring the promo input + discount line back.
const PROMO_ENABLED = false

// -- State --
const promoCode = ref('')
const previewing = ref(false)
const purchasing = ref(false)
const preview = ref<PreviewPurchaseResponse | null>(null)

// -- C-3: Refresh balance when popup opens (prevents stale cache) --
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      balanceStore.refresh()
    }
  },
)

// -- Computed --
const formattedDate = computed(() =>
  formatDate(props.practice.scheduled_at, props.practice.timezone),
)

const promoApplied = computed(() => preview.value !== null && preview.value.discount_cents > 0)

const discountPercent = computed(() => preview.value?.discount_percent ?? 0)

const formattedDiscount = computed(() => {
  if (!preview.value) return ''
  return formatMoney(preview.value.discount_cents, preview.value.currency)
})

/** Final price to pay (after promo discount if applied). */
const totalCents = computed(() => preview.value?.paid_cents ?? props.practice.price_cents)

const totalCurrency = computed(() => preview.value?.currency ?? props.practice.currency)

const formattedTotal = computed(() => formatMoney(totalCents.value, totalCurrency.value))

const insufficientBalance = computed(
  () => !props.practice.is_free && !balanceStore.hasEnough(totalCents.value),
)

const purchaseButtonText = computed(() => {
  if (insufficientBalance.value) return 'Пополнить баланс'
  if (props.practice.is_free) return 'Записаться'
  return 'Оплатить'
})

// -- Actions --

function onClose(): void {
  if (purchasing.value) return
  resetState()
  emit('close')
}

function resetState(): void {
  promoCode.value = ''
  preview.value = null
  previewing.value = false
  purchasing.value = false
}

async function onApplyPromo(): Promise<void> {
  if (!promoCode.value || previewing.value) return

  previewing.value = true
  try {
    preview.value = await previewPurchase(props.practice.id, promoCode.value)
  } catch (e) {
    preview.value = null
    toast.error(extractApiError(e, 'Не удалось проверить промокод'))
  } finally {
    previewing.value = false
  }
}

async function onPurchase(): Promise<void> {
  // C-2: Guard against double tap / rapid clicks.
  if (purchasing.value) return

  // Redirect to topup if insufficient balance.
  if (insufficientBalance.value) {
    resetState()
    emit('close')
    router.push({ name: 'user-topup' })
    return
  }

  purchasing.value = true
  try {
    const appliedPromo = promoApplied.value ? promoCode.value : undefined
    await purchasePractice(props.practice.id, appliedPromo)

    toast.success('Вы записаны!')
    resetState()
    emit('purchased')
  } catch (e) {
    if (e instanceof ApiResponseError) {
      // F-03: switch on machine-readable code instead of string-matching message.
      // Backend sets unique codes via BadRequestError("...", code="...").
      if (e.code === 'insufficient_balance') {
        toast.error('Недостаточно средств на балансе')
      } else if (e.code === 'practice_full') {
        // Места кончились в гонке — закрываем попап и поднимаем полноэкранный
        // стейт «Места закончились» (вместо тоста). Решение оператора 2026-06-04.
        resetState()
        emit('close')
        emit('soldOut')
      } else if (e.status === 409) {
        toast.error('Вы уже записаны на эту практику')
      } else {
        toast.error(e.detail)
      }
    } else {
      toast.error('Ошибка при бронировании')
    }
  } finally {
    // F-02: always refresh balance -- on success deduction is confirmed,
    // on error a concurrent operation may have changed it.
    await balanceStore.refresh()
    purchasing.value = false
  }
}
</script>

<style scoped>
.popup__title {
  font-family: var(--font-body);
  font-size: var(--text-xl);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0 0 var(--space-5);
}

/* Summary rows */
.popup__summary {
  margin-bottom: var(--space-5);
}

.popup__row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: var(--space-2) 0;
}

.popup__row + .popup__row {
  border-top: 1px solid var(--velo-border-light);
}

.popup__label {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-muted);
}

.popup__value {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  text-align: right;
  max-width: 60%;
}

/* Promo input */
.popup__promo {
  display: flex;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}

.popup__promo-input {
  flex: 1;
  padding: 10px var(--space-4);
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  background: var(--velo-glass-blue-15);
  border: 2px solid transparent;
  border-radius: var(--velo-radius-badge);
  transition: border-color var(--transition-fast);
}

.popup__promo-input:focus {
  outline: none;
  border-color: var(--velo-border-input-focus);
}

.popup__promo-input::placeholder {
  color: var(--velo-text-muted);
}

/* Discount line */
.popup__discount {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-2) var(--space-3);
  margin-bottom: var(--space-4);
  background: var(--velo-glass-teal-30);
  border-radius: var(--radius-md);
}

.popup__discount-label {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-success);
}

.popup__discount-value {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-success);
}

/* Total */
.popup__total {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-4) 0;
  margin-bottom: var(--space-4);
  border-top: 1px solid var(--velo-border-light);
}

.popup__total-label {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}

.popup__total-value {
  font-family: var(--font-body);
  font-size: var(--text-xl);
  color: var(--velo-primary);
}

/* Warning */
.popup__warning {
  padding: var(--space-3);
  margin-bottom: var(--space-4);
  background: var(--velo-glass-peach-40);
  border: 1px solid var(--velo-warning);
  border-radius: var(--radius-md);
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-warning-text);
}

/* Actions */
.popup__actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
</style>
