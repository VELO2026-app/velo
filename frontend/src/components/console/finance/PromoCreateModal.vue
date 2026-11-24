<!--
  VELO Frontend -- PromoCreateModal (FE-267)

  The form for a company promo code: the code, the discount, an optional use
  limit and last day, and whether it works for a first purchase only. The
  company pays for the discount, so this is the admin's own promo (a master's
  promos are made by the master). Sends `POST /admin/promos`; the server
  uppercases the code and starts the promo now. Validation shows next to the
  field; a refusal of the server (a code that already exists, a discount it
  does not allow) is one toast and the form stays as it was.
-->

<template>
  <VModal :open="open" @close="onClose">
    <form class="promo-form" novalidate @submit.prevent="onSubmit">
      <h2 class="promo-form__title">{{ t('console.finance.promos.createModal.title') }}</h2>
      <VInput
        v-model="code"
        :label="t('console.finance.promos.createModal.code')"
        :placeholder="t('console.finance.promos.createModal.codePlaceholder')"
        :error="codeError"
        required
        autocomplete="off"
      />
      <div class="promo-form__pair">
        <VSelect
          v-model="discount"
          :label="t('console.finance.promos.createModal.discount')"
          :options="DISCOUNT_OPTIONS"
        />
        <VInput
          v-model="maxUses"
          type="number"
          kind="numeric"
          min="1"
          :label="t('console.finance.promos.createModal.maxUses')"
          :placeholder="t('console.finance.promos.createModal.maxUsesPlaceholder')"
          :error="maxUsesError"
        />
      </div>
      <VInput
        v-model="until"
        type="date"
        :min="today"
        :label="t('console.finance.promos.createModal.until')"
        :error="untilError"
      />
      <VCheckbox
        v-model="firstPurchaseOnly"
        :label="t('console.finance.promos.createModal.firstPurchaseOnly')"
      />
      <div class="promo-form__actions">
        <VButton type="button" variant="ghost" @click="onClose">
          {{ t('console.finance.promos.createModal.cancel') }}
        </VButton>
        <VButton type="submit" variant="primary" :loading="creating">
          {{ t('console.finance.promos.createModal.submit') }}
        </VButton>
      </div>
    </form>
  </VModal>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { ref, watch } from 'vue'
import { VButton, VCheckbox, VInput, VModal, VSelect } from '@/components/ui'
import { endOfDayIso, todayIn } from '@/components/console/finance/financeFormat'
import { createCompanyPromo } from '@/api/admin'
import { ApiResponseError } from '@/api/client'
import type { CreateCompanyPromoRequest } from '@/api/types'
import { useAdminMutation } from '@/composables/queries/admin'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { useViewerTimezone } from '@/composables/useViewerTimezone'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  /** The promo was created. */
  created: []
  close: []
}>()

const toast = useToast()
const zone = useViewerTimezone()

/**
 * The discounts the server accepts (`promo_allowed_discounts`, its default):
 * any other value is refused. The API does not publish the list.
 */
const DISCOUNTS = [5, 25, 50, 75, 100] as const
const DISCOUNT_OPTIONS = DISCOUNTS.map((n) => ({ value: String(n), label: `${n}%` }))

const CODE_MIN = 3
const CODE_MAX = 50

const code = ref('')
const discount = ref(String(DISCOUNTS[1]))
const maxUses = ref('')
const until = ref('')
const firstPurchaseOnly = ref(false)
const codeError = ref('')
const maxUsesError = ref('')
const untilError = ref('')
const creating = ref(false)
// The earliest last day is today (the admin's): a date before it is a promo
// that ended already. Set on every opening.
const today = ref('')

// Every opening starts a clean form.
watch(
  () => props.open,
  (open) => {
    if (!open) return
    code.value = ''
    discount.value = String(DISCOUNTS[1])
    maxUses.value = ''
    until.value = ''
    firstPurchaseOnly.value = false
    codeError.value = ''
    maxUsesError.value = ''
    untilError.value = ''
    today.value = todayIn(zone.value)
  },
  { immediate: true },
)

// A field's error goes as soon as the field is fixed; typing never adds one.
watch(code, (v) => {
  if (codeError.value && validCode(v)) codeError.value = ''
})
watch(maxUses, (v) => {
  if (maxUsesError.value && validMaxUses(v)) maxUsesError.value = ''
})
watch(until, (v) => {
  if (untilError.value && validUntil(v)) untilError.value = ''
})

function validCode(value: string): boolean {
  const n = value.trim().length
  return n >= CODE_MIN && n <= CODE_MAX
}
/** An empty limit is no limit; otherwise a whole number from 1. */
function validMaxUses(value: string): boolean {
  const text = value.trim()
  return text === '' || (/^\d+$/.test(text) && Number(text) >= 1)
}
/** An empty date is no end; otherwise today or later (`YYYY-MM-DD` compares as text). */
function validUntil(value: string): boolean {
  return value === '' || value >= today.value
}

const mutation = useAdminMutation('createPromo', (body: CreateCompanyPromoRequest) =>
  createCompanyPromo(body),
)

function onClose(): void {
  // A request in flight keeps its window: the outcome would go unseen.
  if (creating.value) return
  emit('close')
}

async function onSubmit(): Promise<void> {
  // The guard comes before the input check: a second press while the first
  // request is in flight must neither validate nor send.
  if (creating.value) return
  codeError.value = validCode(code.value) ? '' : t('console.finance.promos.createModal.errors.code')
  maxUsesError.value = validMaxUses(maxUses.value)
    ? ''
    : t('console.finance.promos.createModal.errors.maxUses')
  untilError.value = validUntil(until.value)
    ? ''
    : t('console.finance.promos.createModal.errors.until')
  if (codeError.value || maxUsesError.value || untilError.value) return

  const body: CreateCompanyPromoRequest = {
    code: code.value.trim(),
    discount_percent: Number(discount.value),
    first_purchase_only: firstPurchaseOnly.value,
  }
  if (maxUses.value.trim() !== '') body.max_uses = Number(maxUses.value)
  if (until.value !== '') body.valid_until = endOfDayIso(until.value, zone.value)

  creating.value = true
  try {
    await mutation.mutateAsync(body)
    toast.success(t('console.finance.promos.createModal.created'))
    emit('created')
  } catch (e) {
    // The server answers 400 for a code that exists and for a discount it does
    // not allow; the shared "bad request" phrase would not say which.
    toast.error(
      e instanceof ApiResponseError && e.status === 400
        ? t('console.finance.promos.createModal.refused')
        : extractApiError(e, t('console.finance.promos.createModal.failed')),
    )
  } finally {
    creating.value = false
  }
}
</script>

<style scoped>
.promo-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: min(420px, 100%);
}

.promo-form__title {
  margin: 0 0 var(--space-2);
  font-size: var(--velo-fs-20);
  font-weight: inherit;
  color: var(--velo-text-primary);
}

.promo-form__pair {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--space-4);
}

.promo-form__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
  margin-top: var(--space-3);
}
</style>
