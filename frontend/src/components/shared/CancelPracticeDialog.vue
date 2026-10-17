<!--
  VELO Frontend -- CancelPracticeDialog (master, 2026-06-12)

  Branded confirm for cancelling a whole practice (master). Built on the shared
  <VModal> + DS pieces, per the operator SVG «Abolish the practice»:
    - practice card (icon + title + when + N участников)
    - warning Banner (DS warning variant, kept as-is per Q3=А)
    - recurring block + scope radio (Только эту / Эту и будущие) — shown only for
      a `series` practice. The chosen scope is emitted on @confirm ('this' /
      'this_and_future'); the parent forwards it into cancelPractice (full
      refund). A non-series practice emits 'this' (it has no siblings).

  Replaces the generic VConfirmDialog cancel-confirm in EditPracticeView.
-->
<template>
  <VModal :open="open" :show-close="false" :close-on-overlay="!loading" @close="$emit('cancel')">
    <div v-if="practice" class="cpd">
      <h2 class="cpd__title">{{ t('practiceCancel.title') }}</h2>

      <!-- Practice card -->
      <div class="cpd__pcard">
        <span class="cpd__pico"><component :is="practiceIcon" :size="44" /></span>
        <div class="cpd__pinfo">
          <div class="cpd__ptitle">{{ practice.title }}</div>
          <div class="cpd__pmeta">
            <span>{{ practiceWhen }}</span>
            <span class="cpd__pcount"
              ><IconGroup :size="15" />
              {{ t('practiceCancel.participants', { n: practice.current_participants }) }}</span
            >
          </div>
        </div>
      </div>

      <!-- Warning banner (DS Banner, warning variant — kept as-is, Q3=А) -->
      <Banner variant="warning" :body="t('practiceCancel.notify')">
        <template #icon><IconWarning :size="28" /></template>
      </Banner>

      <!-- Recurring scope (series only). Default = cancel only this occurrence. -->
      <template v-if="practice.practice_type === 'series'">
        <div class="cpd__recur"><IconRepeat :size="22" /> {{ t('practiceCancel.recurring') }}</div>
        <VRadioGroup v-model="scope" :options="SCOPE_OPTIONS" />
      </template>

      <div class="cpd__actions">
        <VButton variant="primary" :disabled="loading" @click="$emit('cancel')">{{
          t('practiceCancel.keep')
        }}</VButton>
        <VButton variant="danger" :loading="loading" @click="onConfirm">{{
          t('practiceCancel.cancel')
        }}</VButton>
      </div>
    </div>
  </VModal>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { VModal, VButton, VRadioGroup } from '@/components/ui'
import Banner from '@/components/shared/Banner.vue'
import { IconWarning, IconRepeat, IconGroup } from '@/components/icons'
import { practiceIconFor } from '@/utils/displayHelpers'
import { formatDateShort, formatTime } from '@/utils/format'
import type { PracticeResponse } from '@/api/types'

// tz-i18n 2.2b: dialog copy via practiceCancel.*; scope radio labels resolve
// at ACCESS time (getters).
const { t } = useI18n({ useScope: 'global' })

const props = withDefaults(
  defineProps<{
    open: boolean
    practice: PracticeResponse | null
    loading?: boolean
  }>(),
  { loading: false },
)

const emit = defineEmits<{
  confirm: [scope: 'this' | 'this_and_future']
  cancel: []
}>()

// Cancel scope for a series. Plain string ref so v-model matches VRadioGroup
// (modelValue: string); mapped to the backend vocabulary on confirm.
const scope = ref('one')
const SCOPE_OPTIONS = [
  {
    value: 'one',
    get label(): string {
      return t('practiceCancel.scopeOne')
    },
  },
  {
    value: 'future',
    get label(): string {
      return t('practiceCancel.scopeFuture')
    },
  },
]

/** Emit the backend cancel scope. Non-series practices keep the 'one' default
 *  (the radio is hidden) → 'this'. */
function onConfirm(): void {
  emit('confirm', scope.value === 'future' ? 'this_and_future' : 'this')
}

const practiceIcon = computed(() => (props.practice ? practiceIconFor(props.practice) : null))

const practiceWhen = computed((): string => {
  if (!props.practice) return ''
  const day = formatDateShort(props.practice.scheduled_at, props.practice.timezone)
  const time = formatTime(props.practice.scheduled_at, props.practice.timezone)
  return `${day}, ${time}`
})
</script>

<style scoped>
.cpd {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.cpd__title {
  font-family: var(--font-heading);
  font-size: var(--text-lg);
  font-weight: 400;
  color: var(--velo-text-primary);
  text-align: center;
  letter-spacing: 0.02em;
  margin: 0;
}

/* Practice card — bordered white plate (operator SVG). */
.cpd__pcard {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  border: 1px solid var(--velo-primary);
  border-radius: var(--radius-md);
  padding: var(--velo-card-padding-y) var(--space-4);
}

.cpd__pico {
  flex-shrink: 0;
  color: var(--velo-text-primary);
  display: flex;
}

.cpd__pinfo {
  min-width: 0;
}

.cpd__ptitle {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}

.cpd__pmeta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: var(--velo-gap-2);
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
}

.cpd__pcount {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.cpd__pcount :deep(svg) {
  opacity: 0.8;
}

/* Recurring marker — glass-blue plate. */
.cpd__recur {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  background: var(--velo-glass-blue-15);
  border-radius: 10px;
  padding: 11px var(--space-4);
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}

.cpd__recur :deep(svg) {
  flex-shrink: 0;
  color: var(--velo-text-primary);
}

.cpd__actions {
  display: flex;
  gap: var(--space-3);
}

.cpd__actions > * {
  flex: 1;
}
</style>
