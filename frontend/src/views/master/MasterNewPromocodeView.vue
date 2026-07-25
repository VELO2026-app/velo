<!--
  VELO Frontend -- MasterNewPromocodeView (create-promocode form, 2026-06-13)

  Route /master/promocodes/new, built to the «5 New promo code» design. WIRED
  (PC1, 2026-07-12): POST /api/v1/masters/me/promos has been live since E10 --
  this form just never called it. Reuses the Phase-3 required-seal pattern
  (`required` prop on VInput/VSelect + legend).
-->

<template>
  <div class="new-promo">
    <VHeader title="Новый промокод" show-back @back="router.back()" />

    <div class="new-promo__content">
      <!-- Required-fields legend (DS, Phase-3). -->
      <div class="new-promo__legend">
        <IconRequired class="new-promo__legend-seal" :size="22" />
        <span>— поля, обязательные для заполнения</span>
      </div>

      <VInput
        v-model="form.code"
        label="Код промокода"
        placeholder="Латиница, цифры, дефис"
        required
      />
      <VSelect v-model="form.discount" label="Скидка" :options="DISCOUNT_OPTIONS" required />
      <!-- «Действует до»: opens the shared DatePickerSheet (consistent in-app picker;
           future-only via :min) instead of the OS-native date input. -->
      <div class="new-promo__field">
        <label class="new-promo__label">Действует до</label>
        <div class="new-promo__field-row">
          <button
            type="button"
            class="new-promo__picker"
            :class="{ 'new-promo__picker--empty': !form.until }"
            @click="showDate = true"
          >
            {{ form.until ? untilDisplay : 'Выберите дату' }}
          </button>
          <span class="new-promo__seal" :class="{ 'new-promo__seal--done': !!form.until }">
            <IconRequired v-if="!form.until" :size="22" />
            <IconRequiredDone v-else :size="22" />
          </span>
        </div>
      </div>
      <VInput
        v-model="form.limit"
        label="Лимит использований"
        type="number"
        min="1"
        placeholder="10"
        @focus="onFieldFocus"
      />

      <VButton
        variant="primary"
        block
        class="new-promo__submit"
        :loading="creating"
        @click="onCreate"
      >
        Создать промокод
      </VButton>
    </div>

    <DatePickerSheet
      :open="showDate"
      :model-value="form.until"
      :min="todayISO"
      title="Действует до"
      @update:model-value="form.until = $event"
      @close="showDate = false"
    />
  </div>
</template>

<script setup lang="ts">
import { reactive, computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VInput, VSelect, VButton } from '@/components/ui'
import { IconRequired, IconRequiredDone } from '@/components/icons'
import DatePickerSheet from '@/components/shared/DatePickerSheet.vue'
import { useToast } from '@/composables/useToast'
import { useKeyboardFieldScroll } from '@/composables/useKeyboardFieldScroll'
import { formatShortDate, todayLocalISO } from '@/utils/format'
import { createPromo } from '@/api/promos'
import { extractApiError } from '@/composables/useApiError'

const router = useRouter()
const toast = useToast()

// Lift the focused field above the soft keyboard once it settles (shared M5
// composable — replaces the bespoke racing vv.resize→scrollIntoView listener, K3).
const { onFieldFocus } = useKeyboardFieldScroll()

const DISCOUNT_OPTIONS = [
  { value: '10', label: '10%' },
  { value: '25', label: '25%' },
  { value: '50', label: '50%' },
  { value: '75', label: '75%' },
  { value: '100', label: '100%' },
]

const form = reactive({
  code: '',
  discount: '100',
  until: '',
  limit: '',
})

// «Действует до» must be in the future — DatePickerSheet :min = today disables the
// earlier days (B6; replaces the OS-native min attribute). Local-time date floor
// (not UTC) so it doesn't drift a day near midnight for east/west-of-UTC testers.
const todayISO = computed((): string => todayLocalISO())

// Shared calendar sheet state + the friendly trigger label, e.g. "27 июн. 2026".
const showDate = ref(false)
const untilDisplay = computed((): string =>
  form.until ? `${formatShortDate(`${form.until}T12:00:00`)} ${form.until.slice(0, 4)}` : '',
)

// Usage limit starts at 1 — clamp away 0 / negatives the number spinner allows (B1).
watch(
  () => form.limit,
  (v) => {
    if (v !== '' && Number(v) < 1) form.limit = '1'
  },
)

const creating = ref(false)

async function onCreate(): Promise<void> {
  if (creating.value) return
  if (!form.code.trim()) {
    toast.error('Введите код промокода')
    return
  }
  if (!form.until) {
    toast.error('Укажите дату окончания действия')
    return
  }
  creating.value = true
  try {
    await createPromo({
      code: form.code.trim(),
      discount_percent: Number(form.discount),
      // End of the selected local day, sent as UTC ISO (mirrors untilDisplay's
      // own noon-anchoring pattern -- avoids day-boundary drift near midnight).
      valid_until: new Date(`${form.until}T23:59:59`).toISOString(),
      max_uses: form.limit ? Number(form.limit) : null,
    })
    toast.success('Промокод создан')
    router.push({ name: 'master-promocodes' })
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось создать промокод'))
  } finally {
    creating.value = false
  }
}
</script>

<style scoped>
.new-promo {
  display: flex;
  flex-direction: column;
}

.new-promo__content {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-4) 0 var(--space-8);
}

/* Required-fields legend — mirrors CreatePracticeView. */
.new-promo__legend {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  /* Brighter than the default --velo-error-bg (was too pale, operator 2026-06-19):
     stronger pink fill + a defining error border. */
  background: var(--velo-error-bg-strong);
  border: 1.5px solid var(--velo-error-border);
  color: var(--velo-danger-text);
  font-size: var(--text-sm);
}

.new-promo__legend-seal {
  flex-shrink: 0;
  color: var(--velo-error);
}

.new-promo__submit {
  margin-top: var(--space-4);
}

/* «Действует до» date trigger — same box + required seal as a VInput field
   (tokens match .v-input__field / CreatePractice's picker), opens DatePickerSheet. */
.new-promo__field {
  margin-bottom: var(--space-4);
}

.new-promo__label {
  display: block;
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  margin-bottom: var(--space-2);
}

.new-promo__field-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.new-promo__picker {
  flex: 1;
  min-width: 0;
  height: var(--velo-size-40);
  text-align: left;
  padding: 0 var(--space-4);
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  background: var(--velo-bg-card-solid);
  border: 2px solid transparent;
  border-radius: var(--velo-radius-badge);
  cursor: pointer;
}

.new-promo__picker--empty {
  color: var(--velo-text-muted);
}

.new-promo__seal {
  flex-shrink: 0;
  display: flex;
  color: var(--velo-error);
}

.new-promo__seal--done {
  color: var(--velo-required-done);
}
</style>
