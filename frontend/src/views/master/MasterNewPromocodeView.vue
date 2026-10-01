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
      <!-- Required-fields legend: HIDDEN for now (owner 2026-10-01) -- the
           per-label asterisk reads without an explanation. Restore the block
           below when an explanation is needed again. -->
      <!--
      <div class="new-promo__legend">
        <IconRequired class="new-promo__legend-seal" :size="22" />
        <span>— поля, обязательные для заполнения</span>
      </div>
      -->

      <!-- .cp-req-label injects the red * after the field's visible label
           (owner 2026-10-01 canon, see the CSS below). -->
      <div class="cp-req-label">
        <VInput v-model="form.code" label="Код промокода" placeholder="Латиница, цифры, дефис" />
        <span
          class="new-promo__field-error"
          :class="{ 'new-promo__field-error--show': !!codeError }"
          >{{ codeError }}</span
        >
      </div>
      <div class="cp-req-label">
        <VSelect v-model="form.discount" label="Скидка" :options="DISCOUNT_OPTIONS" />
      </div>
      <!-- «Действует до»: opens the shared DatePickerSheet (consistent in-app picker;
           future-only via :min) instead of the OS-native date input. -->
      <div class="cp-req-label">
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
          </div>
          <span
            class="new-promo__field-error"
            :class="{ 'new-promo__field-error--show': !!untilError }"
            >{{ untilError }}</span
          >
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
import { reactive, computed, ref, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VInput, VSelect, VButton } from '@/components/ui'
import DatePickerSheet from '@/components/shared/DatePickerSheet.vue'
import { useToast } from '@/composables/useToast'
import { useKeyboardFieldScroll } from '@/composables/useKeyboardFieldScroll'
import { formatShortDate, todayLocalISO } from '@/utils/format'
import { createPromo } from '@/api/promos'
import { extractApiError } from '@/composables/useApiError'
import { queryDocument } from '@/platform/dom'

const router = useRouter()
const toast = useToast()

// Inline field errors through the constant slots (owner 2026-10-01 canon):
// the message fades in without growing its block; the scroll brings the
// failing field into view.
const codeError = ref('')
const untilError = ref('')

async function showFieldError(setter: () => void): Promise<void> {
  setter()
  await nextTick()
  queryDocument('.new-promo__field-error--show')?.scrollIntoView({
    behavior: 'smooth',
    block: 'center',
  })
}

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
    await showFieldError(() => {
      codeError.value = 'Введите код промокода'
    })
    toast.error('Введите код промокода')
    return
  }
  if (!form.until) {
    await showFieldError(() => {
      untilError.value = 'Укажите дату окончания действия'
    })
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
    void router.push({ name: 'master-promocodes' })
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

/* Per-label required asterisk + constant-height error slots (owner
   2026-10-01 canon): the rosette is gone; the message fades in without
   growing its block. VInput's own error line is hidden -- its red border
   still marks the field. */
.new-promo :deep(.cp-req-label .v-input__label)::after,
.new-promo :deep(.cp-req-label .v-select__label)::after,
.cp-req-label .new-promo__label::after {
  content: ' *';
  color: var(--velo-error);
}

.new-promo__field-error {
  display: block;
  min-height: 17px;
  margin-top: 0;
  font-size: var(--text-xs);
  line-height: 1.2;
  color: var(--velo-error);
  opacity: 0;
}

.new-promo__field-error--show {
  opacity: 1;
}

.new-promo :deep(.v-input__error) {
  display: none;
}

.new-promo__submit {
  margin-top: var(--space-4);
}

/* «Действует до» date trigger — same box as a VInput field (tokens match
   .v-input__field / CreatePractice's picker), opens DatePickerSheet. */
.new-promo__field {
  margin-bottom: 0;
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
</style>
