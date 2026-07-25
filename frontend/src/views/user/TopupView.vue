<!--
  VELO Frontend -- TopupView (Phase F5, fixed F5 review)

  Balance topup screen:
    - Current balance display
    - Preset amounts (EUR 5, 10, 20, 50)
    - Custom amount input (EUR 1-500)
    - "Пополнить" button -> POST /api/v1/payments/topup -> redirect

  F5 review fixes:
    C-1: Validate checkout_url before redirect (whitelist)
    W-27: Use formatMoney instead of local formatEur

  Route: /user/topup (name: 'user-topup')
-->

<template>
  <div class="topup">
    <!-- Balance -->
    <div class="topup__balance">
      <span class="topup__balance-label">Ваш баланс</span>
      <span class="topup__balance-value">{{ balanceStore.formattedBalance }}</span>
    </div>

    <!-- Preset amounts -->
    <div class="topup__section-title">Выберите сумму</div>
    <div class="topup__presets">
      <button
        v-for="preset in PRESETS"
        :key="preset"
        class="topup__preset"
        :class="{ 'topup__preset--active': selectedCents === preset && !customMode }"
        @click="selectPreset(preset)"
      >
        {{ formatMoney(preset, 'EUR') }}
      </button>
    </div>

    <!-- Custom amount -->
    <div class="topup__custom">
      <div
        class="topup__custom-toggle"
        :class="{ 'topup__custom-toggle--active': customMode }"
        @click="enableCustom"
      >
        Другая сумма
      </div>
      <VInput
        v-if="customMode"
        ref="customInput"
        v-model="customValue"
        type="number"
        placeholder="1 — 500"
        :min="1"
        :max="500"
        step="1"
        inputmode="numeric"
        @update:model-value="onCustomInput"
      >
        <template #prefix>€</template>
      </VInput>
    </div>

    <!-- Error -->
    <div v-if="validationError" class="topup__error">
      {{ validationError }}
    </div>

    <!-- Action -->
    <div class="topup__action">
      <VButton
        variant="primary"
        size="lg"
        block
        :loading="loading"
        :disabled="!canSubmit"
        @click="onTopup"
      >
        Пополнить {{ selectedLabel }}
      </VButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted } from 'vue'
import { VButton, VInput } from '@/components/ui'
import { useBalanceStore } from '@/stores/balance'
import { useToast } from '@/composables/useToast'
import { createTopup } from '@/api/payments'
import { extractApiError } from '@/composables/useApiError'
import { formatMoney } from '@/utils/format'
import { eurStringToCents } from '@/utils/currency'

const balanceStore = useBalanceStore()
const toast = useToast()

// -- Constants --
const PRESETS = [500, 1000, 2000, 5000] // cents: EUR 5, 10, 20, 50
const MIN_CENTS = 100 // EUR 1.00 (from backend config)
const MAX_CENTS = 50000 // EUR 500.00 (from backend config)

// C-1: Allowed URL prefixes for checkout redirect.
// FAILS CLOSED (ПРОМТ №563, same posture as api/practices.ts's
// zoomStartRedirectUrl, ПРОМТ №557): no hardcoded fallback domain. The
// second prefix (our own backend, used for the stub-mode success URL) is
// only added when VITE_API_BASE_URL is actually configured -- api.talentir.
// info belongs to a different project entirely. If the env var is missing,
// the allowlist admits ONLY Stripe's real checkout domain; a stub-mode
// checkout_url (which would need the second prefix) is then rejected by
// isAllowedRedirectUrl() below, and the user sees the existing "Некорректный
// URL платёжной системы" toast instead of the allowlist silently widening
// to permit a foreign domain.
const ALLOWED_REDIRECT_PREFIXES = [
  'https://checkout.stripe.com/',
  ...(import.meta.env.VITE_API_BASE_URL ? [import.meta.env.VITE_API_BASE_URL] : []),
]

// -- State --
const selectedCents = ref(1000) // default EUR 10
const customMode = ref(false)
const customValue = ref('')
const loading = ref(false)
const customInput = ref<{ focus: () => void } | null>(null)

// -- Computed --
// FP-03: eurStringToCents() avoids IEEE-754 float precision trap.
// parseFloat('0.575') * 100 = 57.499... -> rounds to 57, not 58.
const customCents = computed(() => eurStringToCents(customValue.value))

const effectiveCents = computed(() => (customMode.value ? customCents.value : selectedCents.value))

const validationError = computed(() => {
  if (!customMode.value) return ''
  if (!customValue.value) return ''
  if (customCents.value < MIN_CENTS) return 'Минимальная сумма — €1'
  if (customCents.value > MAX_CENTS) return 'Максимальная сумма — €500'
  return ''
})

const canSubmit = computed(
  () =>
    effectiveCents.value >= MIN_CENTS &&
    effectiveCents.value <= MAX_CENTS &&
    !validationError.value &&
    !loading.value,
)

const selectedLabel = computed(() => {
  if (effectiveCents.value <= 0) return ''
  return formatMoney(effectiveCents.value, 'EUR')
})

// -- Actions --

function selectPreset(cents: number): void {
  customMode.value = false
  customValue.value = ''
  selectedCents.value = cents
}

async function enableCustom(): Promise<void> {
  customMode.value = true
  await nextTick()
  customInput.value?.focus()
}

function onCustomInput(): void {
  // Prevent negative values in UI.
  const val = parseFloat(customValue.value)
  if (val < 0) customValue.value = ''
}

/**
 * C-1: Validate checkout URL against whitelist before redirect.
 * Prevents open redirect if backend is compromised.
 */
function isAllowedRedirectUrl(url: string): boolean {
  return ALLOWED_REDIRECT_PREFIXES.some((prefix) => url.startsWith(prefix))
}

async function onTopup(): Promise<void> {
  if (!canSubmit.value || loading.value) return

  loading.value = true
  try {
    const response = await createTopup(effectiveCents.value)

    // C-1: Validate redirect URL before navigating.
    if (!isAllowedRedirectUrl(response.checkout_url)) {
      toast.error('Некорректный URL платёжной системы')
      return
    }

    // Redirect to Stripe checkout (or success URL in stub mode).
    window.location.href = response.checkout_url
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось создать платёж'))
  } finally {
    loading.value = false
  }
}

// -- Lifecycle --
onMounted(() => {
  balanceStore.refresh()
})
</script>

<style scoped>
.topup {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

/* Balance */
.topup__balance {
  text-align: center;
  padding: var(--space-5);
  background: var(--velo-glass-blue-15);
  border: 1px solid var(--velo-glass-border);
  border-radius: var(--radius-md);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}

.topup__balance-label {
  display: block;
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-muted);
  margin-bottom: var(--space-2);
}

.topup__balance-value {
  font-family: var(--font-body);
  font-size: var(--text-xl);
  color: var(--velo-primary);
}

/* Section title */
.topup__section-title {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

/* Presets */
.topup__presets {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}

.topup__preset {
  padding: var(--space-4);
  background: var(--velo-glass-blue-15);
  border: 1px solid var(--velo-glass-border);
  border-radius: var(--radius-md);
  font-family: var(--font-body);
  font-size: var(--text-lg);
  color: var(--velo-text-primary);
  cursor: pointer;
  transition: all var(--transition-fast);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}

.topup__preset:hover {
  opacity: 0.8;
}

.topup__preset--active {
  border-color: var(--velo-primary);
  background: var(--velo-glass-blue-60);
  color: var(--velo-primary);
  box-shadow: var(--velo-shadow-glow);
}

/* Custom amount */
.topup__custom-toggle {
  padding: var(--space-3) var(--space-4);
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-primary);
  cursor: pointer;
  text-align: center;
  border: 1px dashed var(--velo-border-light);
  border-radius: var(--radius-md);
  transition: all var(--transition-fast);
}

.topup__custom-toggle:hover {
  opacity: 0.8;
}

.topup__custom-toggle--active {
  border-color: var(--velo-primary);
  background: var(--velo-glass-blue-15);
}

/* Error */
.topup__error {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-error);
  text-align: center;
}

/* Action */
.topup__action {
  margin-top: var(--space-2);
}
</style>
