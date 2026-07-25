<!--
  VELO Frontend -- MasterFinanceView (Phase-3 redesign «8 Withdrawal», 2026-06-13)

  Master withdrawal screen. Route: /master/finance (inside MasterShell).
  Guard: masterStatusGuard (verified masters only).

  Rebuilt to the operator SVG «8 Withdrawal» + «8 Withdrawal (add card)».
  Decision Б (operator 2026-06-13): the WORKING payout backend is KEPT — the
  «saved card» is the configured payout method (IBAN/PayPal/Revolut) shown as a
  card, «+ Добавить новую карту» opens the EXISTING method form (not literal card
  fields, which have no backend), so «Запросить вывод» stays real. Currency € (В2=А;
  ₽ on the mockup is illustrative).

  Sections: balance · «Метод оплаты» (method-as-card + add) · «Сумма вывода»
  (always visible — the toggle was removed) · «История выводов» (status icons).

  Stub → Zod (roadmap Screen 17): X removes the saved method — no delete-payout
  endpoint (only update) → toasts «later»; literal cards (number + holder, multiple
  cards) = card storage + card payouts; ₽ currency if wanted; per-period income /
  ledger (still «—», same gap as Screens 7/12).

  Money: formatMoney(cents, 'EUR', 'ru', true). MIN_WITHDRAWAL_EUROS=50,
  WITHDRAWAL_FEE_EUROS=2 (mirror backend config).
-->

<template>
  <div class="finance-view">
    <VHeader title="Вывод средств" show-back @back="router.back()" />

    <!-- ===================== BALANCE ===================== -->
    <div class="finance-view__balance">
      <div class="finance-view__balance-label">Доступно к выводу</div>
      <div class="finance-view__balance-value">{{ formattedAvailable }}</div>
      <!-- frozen kept beyond the SVG: real «in review» money the master should see -->
      <div v-if="frozenCents > 0" class="finance-view__balance-frozen">
        На рассмотрении: {{ formattedFrozen }}
      </div>
    </div>

    <!-- ===================== PAYMENT METHOD (= configured payout, Б) ===================== -->
    <section class="finance-view__section">
      <h2 class="finance-view__title">Метод оплаты</h2>

      <template v-if="!showPayoutForm">
        <div v-if="hasPayout" class="finance-view__card">
          <div class="finance-view__card-text">
            <span class="finance-view__card-num">
              {{ maskedDetails(masterStore.profile!.payout!) }}
            </span>
            <span v-if="payoutHolder(masterStore.profile!.payout!)" class="finance-view__card-name">
              {{ payoutHolder(masterStore.profile!.payout!) }}
            </span>
          </div>
          <button
            type="button"
            class="finance-view__card-x"
            aria-label="Удалить способ выплаты"
            @click="removePayout"
          >
            <IconClose :size="16" />
          </button>
        </div>
        <p v-else class="finance-view__hint">
          Способ выплаты не настроен. Добавьте карту, чтобы выводить средства.
        </p>

        <VButton variant="outline" class="finance-view__add" @click="openPayoutForm(hasPayout)">
          + Добавить метод оплаты
        </VButton>
      </template>

      <div v-else class="finance-view__payout-form">
        <!-- No own label — the section heading «Метод оплаты» is the single title
             (operator 2026-06-19: drop the duplicate «Способ выплаты»). -->
        <VSelect
          v-model="payoutForm.method"
          :options="METHOD_OPTIONS"
          @update:model-value="onMethodChange"
        />

        <template v-if="payoutForm.method === 'bank_transfer'">
          <VInput
            v-model="payoutForm.iban"
            label="IBAN *"
            placeholder="DE89 3704 0044 0532 0130 00"
            :error="formErrors.iban"
          />
          <VInput
            v-model="payoutForm.accountHolder"
            label="Имя владельца счёта"
            placeholder="Ivan Ivanov"
          />
          <VInput
            v-model="payoutForm.swift"
            label="BIC / SWIFT (необязательно)"
            placeholder="COBADEFFXXX"
          />
        </template>

        <template v-else-if="payoutForm.method === 'paypal'">
          <VInput
            v-model="payoutForm.email"
            label="PayPal Email *"
            type="email"
            placeholder="you@example.com"
            :error="formErrors.email"
          />
        </template>

        <template v-else-if="payoutForm.method === 'revolut'">
          <VInput
            v-model="payoutForm.tag"
            label="Revolut Tag или телефон *"
            placeholder="@username или +49123456789"
            :error="formErrors.tag"
          />
        </template>

        <!-- Card transfer (operator SVG «8 Withdrawal (add card)»). В1=А: only the
             card NUMBER is persisted as the payout method (no CVV, no expiry) via
             the same freeform PATCH /me/payout the other methods use. Имя владельца
             stays a display-only field. -->
        <template v-else-if="payoutForm.method === 'card'">
          <VInput
            v-model="payoutForm.cardNumber"
            label="Номер карты"
            placeholder="0000 0000 0000 0000"
            :error="formErrors.card"
          />
          <VInput v-model="payoutForm.cardHolder" label="Имя владельца" placeholder="IVAN IVANOV" />
        </template>

        <div class="finance-view__form-actions">
          <VButton
            variant="primary"
            :loading="savingPayout"
            :disabled="savingPayout"
            @click="savePayout"
          >
            Сохранить
          </VButton>
          <VButton variant="ghost" :disabled="savingPayout" @click="closePayoutForm">
            Отмена
          </VButton>
        </div>
      </div>
    </section>

    <!-- ===================== WITHDRAW AMOUNT (always visible) ===================== -->
    <section class="finance-view__section">
      <h2 class="finance-view__title">Сумма вывода</h2>
      <p class="finance-view__hint">
        Срок зачисления: 1-3 рабочих дня. Комиссия платёжного провайдера будет удержана из суммы
        вывода.
      </p>

      <template v-if="hasPayout">
        <div class="finance-view__amount-row">
          <VInput
            v-model="amountInput"
            type="number"
            :min="MIN_WITHDRAWAL_EUROS"
            step="0.01"
            placeholder="0.00"
          />
          <IconRequired :size="22" class="finance-view__amount-seal" />
        </div>
        <p v-if="amountError" class="finance-view__error">{{ amountError }}</p>
        <p v-else-if="amountCents > 0" class="finance-view__hint">
          Минимум {{ formatMoney(MIN_WITHDRAWAL_EUROS * 100, 'EUR', 'ru', true) }} · Комиссия
          {{ formatMoney(WITHDRAWAL_FEE_EUROS * 100, 'EUR', 'ru', true) }} · Вы получите
          {{ formattedNetAmount }}
        </p>

        <VButton variant="ghost" size="sm" class="finance-view__all" @click="fillMaxAmount">
          Вывести все
        </VButton>

        <VButton
          variant="primary"
          block
          :loading="submitting"
          :disabled="submitting || !!amountError || !amountInput"
          class="finance-view__cta"
          @click="submitWithdrawal"
        >
          Запросить вывод
        </VButton>
      </template>

      <p v-else class="finance-view__warning-text">
        Сначала добавьте способ выплаты в разделе «Метод оплаты» выше.
      </p>
    </section>

    <!-- ===================== HISTORY ===================== -->
    <section class="finance-view__section">
      <h2 class="finance-view__title">История выводов</h2>

      <div v-if="historyLoading && withdrawals.length === 0" class="finance-view__loader">
        <VLoader size="md" />
      </div>

      <p v-else-if="!historyLoading && withdrawals.length === 0" class="finance-view__empty-text">
        Выводов ещё не было
      </p>

      <div v-else class="finance-view__history">
        <div v-for="w in withdrawals" :key="w.id" class="finance-view__hitem">
          <span
            class="finance-view__hicon"
            :class="`finance-view__hicon--${w.status}`"
            :title="statusLabel(w.status)"
          >
            <component :is="statusIcon(w.status)" :size="24" />
          </span>
          <div class="finance-view__htext">
            <span class="finance-view__hamt">
              {{ formatMoney(w.amount_cents, 'EUR', 'ru', true) }}
            </span>
            <span class="finance-view__hmeta">
              {{ withdrawalDate(w) }} • {{ maskedDetails(w.payout_details) }}
            </span>
          </div>
        </div>
      </div>

      <VButton
        v-if="hasMore"
        variant="ghost"
        block
        :loading="historyLoading"
        class="finance-view__load-more"
        @click="loadMoreWithdrawals"
      >
        Показать ещё
      </VButton>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive, onMounted, type Component } from 'vue'
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VButton, VLoader, VInput, VSelect } from '@/components/ui'
import { IconCheck, IconClose, IconPending, IconRequired } from '@/components/icons'
import { useToast } from '@/composables/useToast'
import { useViewerTimezone } from '@/composables/useViewerTimezone'
import { useMasterStore } from '@/stores/master'
import { getMyWithdrawals, createWithdrawal, updatePayoutDetails, deletePayout } from '@/api/masters'
import { extractApiError } from '@/composables/useApiError'
import { formatMoney, formatDateShort } from '@/utils/format'
import { eurStringToCents, centsToEurString } from '@/utils/currency'
import type { WithdrawalResponse, WithdrawalStatus, PayoutDetails } from '@/api/types'

// TD-FE-W6: imported from utils/constants -- mirrors backend config.py.
// min_withdrawal_cents=5000, withdrawal_fee_cents=200.
import { MIN_WITHDRAWAL_EUROS, WITHDRAWAL_FEE_EUROS } from '@/utils/constants'

/** Items per history page. */
const LIMIT = 20

const router = useRouter()
const toast = useToast()
const masterStore = useMasterStore()
const viewerTz = useViewerTimezone()

// ---------------------------------------------------------------------------
// Balance (derived from master store profile)
// ---------------------------------------------------------------------------

const availableCents = computed(() => masterStore.profile?.available_cents ?? 0)
const frozenCents = computed(() => masterStore.profile?.frozen_cents ?? 0)
const hasPayout = computed(() => masterStore.profile?.payout != null)

const formattedAvailable = computed(() => formatMoney(availableCents.value, 'EUR', 'ru', true))

const formattedFrozen = computed(() => formatMoney(frozenCents.value, 'EUR', 'ru', true))

// ---------------------------------------------------------------------------
// Payout method ("saved card" = configured payout, Б — working backend kept)
// ---------------------------------------------------------------------------

const METHOD_OPTIONS = [
  { value: 'bank_transfer', label: 'Банковский перевод (IBAN)' },
  { value: 'paypal', label: 'PayPal' },
  { value: 'revolut', label: 'Revolut' },
  { value: 'card', label: 'Перевод по номеру карты' },
]

const showPayoutForm = ref(false)
const savingPayout = ref(false)

const payoutForm = reactive({
  method: 'bank_transfer',
  iban: '',
  accountHolder: '',
  swift: '',
  email: '',
  tag: '',
  // Card transfer (М4, В1=А): only cardNumber is persisted; cardHolder is
  // display-only.
  cardNumber: '',
  cardHolder: '',
})

const formErrors = reactive({ iban: '', email: '', tag: '', card: '' })

function clearFormErrors(): void {
  formErrors.iban = ''
  formErrors.email = ''
  formErrors.tag = ''
  formErrors.card = ''
}

/** Open the payout form, pre-filling from the existing payout when editing. */
function openPayoutForm(editing: boolean): void {
  clearFormErrors()
  if (editing && masterStore.profile?.payout) {
    const p = masterStore.profile.payout
    payoutForm.method = p.method
    const d = p.details as Record<string, string>
    payoutForm.iban = d['iban'] ?? ''
    payoutForm.accountHolder = d['account_holder'] ?? ''
    payoutForm.swift = d['swift'] ?? ''
    payoutForm.email = d['email'] ?? ''
    payoutForm.tag = d['tag'] ?? d['phone'] ?? ''
    payoutForm.cardNumber = d['card_number'] ?? ''
  } else {
    payoutForm.method = 'bank_transfer'
    payoutForm.iban = ''
    payoutForm.accountHolder = ''
    payoutForm.swift = ''
    payoutForm.email = ''
    payoutForm.tag = ''
    payoutForm.cardNumber = ''
  }
  // cardHolder is display-only (never persisted — В1=А stores only the number).
  payoutForm.cardHolder = ''
  showPayoutForm.value = true
}

function closePayoutForm(): void {
  showPayoutForm.value = false
  clearFormErrors()
}

function onMethodChange(): void {
  clearFormErrors()
}

/** Build the PayoutDetails body from the flat form, validating required fields. */
function buildPayoutBody(): PayoutDetails | null {
  clearFormErrors()
  if (payoutForm.method === 'bank_transfer') {
    if (!payoutForm.iban.trim()) {
      formErrors.iban = 'IBAN обязателен'
      return null
    }
    const details: Record<string, string> = { iban: payoutForm.iban.trim() }
    if (payoutForm.accountHolder.trim()) details['account_holder'] = payoutForm.accountHolder.trim()
    if (payoutForm.swift.trim()) details['swift'] = payoutForm.swift.trim()
    return { method: 'bank_transfer', details }
  }
  if (payoutForm.method === 'paypal') {
    if (!payoutForm.email.trim() || !payoutForm.email.includes('@')) {
      formErrors.email = 'Введите корректный email'
      return null
    }
    return { method: 'paypal', details: { email: payoutForm.email.trim() } }
  }
  if (payoutForm.method === 'revolut') {
    if (!payoutForm.tag.trim()) {
      formErrors.tag = 'Укажите Revolut tag или телефон'
      return null
    }
    const value = payoutForm.tag.trim()
    const key = value.startsWith('+') ? 'phone' : 'tag'
    return { method: 'revolut', details: { [key]: value } }
  }
  if (payoutForm.method === 'card') {
    // В1=А: persist ONLY the card number (no CVV, no expiry). Digits only.
    const digits = payoutForm.cardNumber.replace(/\D/g, '')
    if (digits.length < 12 || digits.length > 19) {
      formErrors.card = 'Введите корректный номер карты'
      return null
    }
    return { method: 'card', details: { card_number: digits } }
  }
  return null
}

async function savePayout(): Promise<void> {
  if (savingPayout.value) return
  const body = buildPayoutBody()
  if (!body) return
  savingPayout.value = true
  try {
    const result = await updatePayoutDetails(body)
    if (masterStore.profile) masterStore.profile.payout = result
    showPayoutForm.value = false
    toast.success('Реквизиты сохранены')
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось сохранить реквизиты'))
  } finally {
    savingPayout.value = false
  }
}

/** Masked summary of the configured payout details (shown as the «card number»). */
function maskedDetails(payout: PayoutDetails): string {
  const d = payout.details as Record<string, string>
  switch (payout.method) {
    case 'bank_transfer': {
      const iban = (d['iban'] ?? '').replace(/\s/g, '')
      const last4 = iban.slice(-4)
      return last4 ? `IBAN ···· ${last4}` : 'IBAN настроен'
    }
    case 'paypal': {
      const email = d['email'] ?? ''
      const at = email.indexOf('@')
      return at > 1 ? email[0] + '···' + email.slice(at) : email || 'Email настроен'
    }
    case 'revolut':
      return d['tag'] ?? d['phone'] ?? 'Настроено'
    case 'card': {
      const num = (d['card_number'] ?? '').replace(/\s/g, '')
      const last4 = num.slice(-4)
      return last4 ? `Карта ···· ${last4}` : 'Карта настроена'
    }
    default:
      return 'Настроено'
  }
}

/** Account-holder name shown under the masked number (bank transfers only). */
function payoutHolder(payout: PayoutDetails): string {
  const d = payout.details as Record<string, string>
  return d['account_holder'] ?? ''
}

/** Remove the saved payout method (X on the card) — real DELETE /me/payout (M3).
 *  Idempotent server-side; on success the local profile.payout is cleared so the
 *  UI reverts to the «не настроен» state. */
async function removePayout(): Promise<void> {
  if (savingPayout.value) return
  savingPayout.value = true
  try {
    await deletePayout()
    if (masterStore.profile) masterStore.profile.payout = null
    toast.success('Способ выплаты удалён')
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось удалить способ выплаты'))
  } finally {
    savingPayout.value = false
  }
}

// ---------------------------------------------------------------------------
// Withdraw amount
// ---------------------------------------------------------------------------

const amountInput = ref<string>('')
const submitting = ref(false)

/** Fill amount input with full available balance in euros.
 * W-2: centsToEurString() uses integer division + toFixed(2) -- no float issues.
 */
function fillMaxAmount(): void {
  amountInput.value = centsToEurString(availableCents.value)
}

// W-1: eurStringToCents() avoids IEEE-754 float precision trap.
const amountCents = computed((): number => eurStringToCents(amountInput.value))

/** Inline validation message for amount input. */
const amountError = computed((): string => {
  if (!amountInput.value) return ''
  const cents = amountCents.value
  if (cents <= 0) return 'Введите корректную сумму'
  if (cents < MIN_WITHDRAWAL_EUROS * 100) {
    return `Минимальная сумма вывода ${formatMoney(MIN_WITHDRAWAL_EUROS * 100, 'EUR', 'ru', true)}`
  }
  if (cents > availableCents.value) {
    return 'Недостаточно средств'
  }
  return ''
})

/** Net amount master receives after fee deduction. */
const formattedNetAmount = computed((): string => {
  const cents = amountCents.value
  if (cents <= 0) return formatMoney(0, 'EUR', 'ru', true)
  const net = Math.max(0, cents - WITHDRAWAL_FEE_EUROS * 100)
  return formatMoney(net, 'EUR', 'ru', true)
})

async function submitWithdrawal(): Promise<void> {
  // Double-submit guard.
  if (submitting.value) return
  if (amountError.value || !amountCents.value) return

  submitting.value = true
  try {
    await createWithdrawal(amountCents.value)
    toast.success('Запрос на вывод отправлен. Ожидайте решения администратора.')
    amountInput.value = ''
    // Refresh profile to update available/frozen balances.
    await masterStore.fetchMyProfile(true)
    // Reload withdrawal history from start.
    await reloadHistory()
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось создать запрос'))
  } finally {
    submitting.value = false
  }
}

// ---------------------------------------------------------------------------
// Withdrawal history
// ---------------------------------------------------------------------------

const withdrawals = ref<WithdrawalResponse[]>([])
const historyTotal = ref(0)
const historyOffset = ref(0)
const historyLoading = ref(false)

const hasMore = computed(() => withdrawals.value.length < historyTotal.value)

async function reloadHistory(): Promise<void> {
  historyLoading.value = true
  historyOffset.value = 0
  try {
    const data = await getMyWithdrawals(LIMIT, 0)
    withdrawals.value = data.items
    historyTotal.value = data.total
    historyOffset.value = data.items.length
  } catch {
    // Non-critical -- history remains empty, balance card still works.
  } finally {
    historyLoading.value = false
  }
}

async function loadMoreWithdrawals(): Promise<void> {
  if (historyLoading.value) return
  historyLoading.value = true
  try {
    const data = await getMyWithdrawals(LIMIT, historyOffset.value)
    withdrawals.value.push(...data.items)
    historyTotal.value = data.total
    historyOffset.value += data.items.length
  } catch {
    toast.error('Не удалось загрузить историю выводов')
  } finally {
    historyLoading.value = false
  }
}

// ---------------------------------------------------------------------------
// Status helpers (history: colored icon + accessible title)
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<WithdrawalStatus, string> = {
  pending: 'На рассмотрении',
  approved: 'Одобрен',
  rejected: 'Отклонён',
}

function statusLabel(s: WithdrawalStatus): string {
  return STATUS_LABEL[s] ?? s
}

const STATUS_ICON: Record<WithdrawalStatus, Component> = {
  pending: IconPending,
  approved: IconCheck,
  rejected: IconClose,
}

function statusIcon(s: WithdrawalStatus): Component {
  return STATUS_ICON[s]
}

/** Withdrawal creation date, shown in the master's own profile timezone. */
function withdrawalDate(w: WithdrawalResponse): string {
  return formatDateShort(w.created_at, viewerTz.value)
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

onMounted(async () => {
  // Profile is already loaded by masterStatusGuard -- lazy fetch skips if so.
  await masterStore.fetchMyProfile()
  await reloadHistory()
})
</script>

<style scoped>
.finance-view {
  /* F-5 rail sync: horizontal padding removed — MobileLayout supplies the 24px
     screen rail. Vertical kept. */
  padding: var(--space-4) 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

/* -- Balance card (centered, per SVG) -- */
.finance-view__balance {
  background: var(--velo-primary);
  color: var(--velo-white);
  border-radius: var(--radius-md);
  padding: var(--space-4) var(--space-5);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
}

.finance-view__balance-label {
  font-size: var(--text-xs);
  opacity: 0.9;
}

.finance-view__balance-value {
  font-family: var(--font-body);
  font-size: var(--text-xl);
  letter-spacing: -0.5px;
}

.finance-view__balance-frozen {
  font-size: var(--text-xs);
  opacity: 0.8;
}

/* -- Section (title on the fog bg + content) -- */
.finance-view__section {
  display: flex;
  flex-direction: column;
  gap: var(--velo-card-meta-row-gap);
}

.finance-view__title {
  font-family: var(--font-body);
  font-size: var(--text-base);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0;
  -webkit-text-stroke: var(--velo-text-stroke-strong) currentColor;
}

.finance-view__hint {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  line-height: 1.45;
  margin: 0;
}

/* -- Saved method-as-card -- */
.finance-view__card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--velo-inset-row);
}

.finance-view__card-text {
  display: flex;
  flex-direction: column;
  gap: var(--velo-gap-3);
  min-width: 0;
  flex: 1;
}

.finance-view__card-num {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.04em;
}

.finance-view__card-name {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
}

.finance-view__card-x {
  flex-shrink: 0;
  width: var(--velo-size-40);
  height: var(--velo-size-40);
  padding: 0;
  border-radius: var(--radius-full);
  border: 2px solid var(--velo-error);
  background: transparent;
  color: var(--velo-error);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.finance-view__add {
  align-self: center;
}

/* -- Payout form -- */
.finance-view__payout-form {
  display: flex;
  flex-direction: column;
}

.finance-view__form-actions {
  display: flex;
  gap: var(--space-3);
  margin-top: var(--space-2);
}

/* -- Withdraw amount -- */
.finance-view__amount-row {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

/* VInput grows; drop its default bottom margin (hint/error sit below). */
.finance-view__amount-row :deep(.v-input) {
  flex: 1;
  margin-bottom: 0;
}

.finance-view__amount-seal {
  flex-shrink: 0;
  color: var(--velo-error);
}

.finance-view__error {
  font-size: var(--text-xs);
  color: var(--velo-error);
  margin: 0;
}

.finance-view__all {
  align-self: flex-start;
}

.finance-view__cta {
  margin-top: var(--space-1);
}

.finance-view__warning-text {
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  line-height: 1.5;
  margin: 0;
}

/* -- History -- */
.finance-view__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-5) 0;
}

.finance-view__empty-text {
  font-size: var(--text-sm);
  color: var(--velo-text-muted);
  text-align: center;
  padding: var(--space-5) 0;
  margin: 0;
}

.finance-view__history {
  display: flex;
  flex-direction: column;
}

.finance-view__hitem {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--velo-inset-row);
}

.finance-view__hitem + .finance-view__hitem {
  margin-top: var(--velo-card-meta-row-gap);
}

.finance-view__hicon {
  flex-shrink: 0;
  display: inline-flex;
}

.finance-view__hicon--pending {
  color: var(--velo-warning);
}

.finance-view__hicon--approved {
  color: var(--velo-success);
}

.finance-view__hicon--rejected {
  color: var(--velo-error);
}

.finance-view__htext {
  display: flex;
  flex-direction: column;
  gap: var(--velo-gap-2);
  min-width: 0;
}

.finance-view__hamt {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}

.finance-view__hmeta {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
}

.finance-view__load-more {
  margin-top: var(--space-3);
}
</style>
