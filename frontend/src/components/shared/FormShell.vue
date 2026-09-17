<!--
  VELO Frontend -- FormShell (WARNING-9)

  Shared full-screen form shell used by CheckinView, FeedbackView, and ReflectionView.
  Extracts ~200 lines of identical CSS and layout structure.

  Layout:
    - Success screen (v-if submitted)
    - Form screen:
        - VHeader with back button
        - Practice info (emoji + name + meta)
        - Question (title + subtitle)
        - #selection slot  <- mood buttons / rating buttons
        - Comment textarea (v-model)
        - Actions (submit + optional skip)

  Slots:
    #selection          — mood or rating buttons
    #success-actions    — buttons shown on success screen
    #success-icon       -- success screen icon (defaults to successIcon emoji)
    #practice-meta      — meta line below practice name (date / "Завершена")

  Props:
    backLabel           — VHeader back label
    practice            — PracticeResponse | null
    practiceLoading     — boolean
    questionTitle       — main question text
    questionSubtitle    — subtitle below question
    comment             — v-model for textarea
    submitting          — loading state for submit button
    submitDisabled      — disable submit button
    submitLabel         — submit button text
    showSkip            — show "Пропустить" ghost button
    submitted           — show success screen instead of form
    successIcon         — emoji shown on success screen
    successTitle        — title on success screen
    successText         — body text on success screen

  Emits:
    back                — back button clicked
    submit              — submit button clicked
    skip                — skip button clicked
    update:comment      — textarea v-model
-->

<template>
  <!-- ===== SUCCESS SCREEN (shared full-bleed white takeover) ===== -->
  <ResultScreen v-if="submitted" :title="successTitle" :text="successText">
    <template #icon
      ><slot name="success-icon">{{ successIcon }}</slot></template
    >
    <template #actions><slot name="success-actions" /></template>
  </ResultScreen>

  <!-- ===== FORM SCREEN ===== -->
  <!-- Tap-to-dismiss keyboard is now app-global (useKeyboardDismiss, B1). -->
  <div v-else class="form-shell">
    <!-- Header -->
    <VHeader show-back :back-label="backLabel" @back="emit('back')" />

    <div class="form-shell__body">
      <!-- Load failed: say so instead of rendering a form that cannot land. The
           sibling of the loader rung below -- it was missing, so a deep link whose
           practice fetch failed rendered a headerless form the backend would
           refuse (№444). Optional: a consumer that passes no loadError renders
           exactly as before. -->
      <VEmptyState
        v-if="loadError"
        icon="warning"
        title="Не удалось загрузить практику"
        :description="loadError"
      >
        <VButton size="sm" @click="emit('retry')">Повторить</VButton>
      </VEmptyState>

      <template v-else>
        <!-- Practice info — общий PracticeHeroCard в form-варианте (F-3). -->
        <PracticeHeroCard
          v-if="practice"
          variant="form"
          :title="cleanTitle"
          :direction="practice.direction"
        >
          <template #meta>
            <slot name="practice-meta">
              <span class="form-shell__practice-meta-cell">
                с {{ practice.master_name ?? 'Мастером' }}
              </span>
            </slot>
          </template>
        </PracticeHeroCard>
        <div v-else-if="practiceLoading" class="form-shell__loader">
          <VLoader />
        </div>

        <!-- Question -->
        <div class="form-shell__question">
          <h3>{{ questionTitle }}</h3>
          <p>{{ questionSubtitle }}</p>
        </div>

        <!-- Selection slot (mood buttons / rating buttons). Omitted entirely when
           no slot content is passed (ReflectionView) so there's no phantom gap;
           CheckinView/FeedbackView always pass it, so they render unchanged. -->
        <div v-if="$slots.selection" class="form-shell__selection">
          <slot name="selection" />
        </div>

        <!-- Comment textarea. @focus scrolls it above the soft keyboard once the
           keyboard settles (batch I — shared useKeyboardFieldScroll). -->
        <VTextarea
          :model-value="comment"
          placeholder="Добавьте комментарий..."
          :rows="3"
          maxlength="1000"
          @focus="onFieldFocus"
          @update:model-value="emit('update:comment', $event)"
        />

        <!-- Actions -->
        <div class="form-shell__actions">
          <VButton
            variant="primary"
            size="lg"
            block
            :disabled="submitDisabled"
            :loading="submitting"
            @click="emit('submit')"
          >
            {{ submitLabel }}
          </VButton>
          <p v-if="submitDisabled && disabledHint" class="form-shell__disabled-hint">
            {{ disabledHint }}
          </p>
          <VButton v-if="showSkip" variant="ghost" block @click="emit('skip')">
            Пропустить
          </VButton>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { VButton, VLoader, VTextarea, VEmptyState } from '@/components/ui'
import { VHeader } from '@/components/layout'
import PracticeHeroCard from '@/components/shared/PracticeHeroCard.vue'
import ResultScreen from '@/components/shared/ResultScreen.vue'
import { cleanPracticeTitle } from '@/utils/format'
import { useKeyboardFieldScroll } from '@/composables/useKeyboardFieldScroll'
import type { PracticeResponse } from '@/api/types'

// Lift the focused textarea above the soft keyboard after it settles (M5 shared
// composable). Bound to the textarea's @focus below.
const { onFieldFocus } = useKeyboardFieldScroll()

const props = defineProps<{
  backLabel: string
  practice: PracticeResponse | null
  practiceLoading: boolean
  /** Optional: the practice fetch failed. When set, the body renders an error
   *  rung with this message INSTEAD of the form -- a form whose practice never
   *  loaded cannot be submitted (the backend refuses it), so offering it wastes
   *  the user's time. Omit it and this shell renders exactly as it always has. */
  loadError?: string | null
  questionTitle: string
  questionSubtitle: string
  comment: string
  submitting: boolean
  submitDisabled: boolean
  /** Helper text shown right under the submit button when submitDisabled is true
   * (e.g. "Чек-ин закрыт — практика уже началась"). */
  disabledHint?: string
  submitLabel: string
  showSkip?: boolean
  submitted: boolean
  /** Optional: emoji string for the success screen. Prefer the #success-icon
   *  slot with a DS icon component (F-9). */
  successIcon?: string
  successTitle: string
  successText: string
}>()

const emit = defineEmits<{
  back: []
  submit: []
  skip: []
  retry: []
  'update:comment': [value: string]
}>()

// Заголовок без суффикса «(эфир)» — единый хелпер (live-практику и так
// маркирует бейдж «В эфире»; в названии скобки не нужны). Покрывает оба
// экрана на FormShell: check-in и feedback.
const cleanTitle = computed(() => (props.practice ? cleanPracticeTitle(props.practice.title) : ''))
</script>

<style scoped>
/* Success screen is the shared <ResultScreen> (full-bleed white takeover) —
   styles live there now. */

/* ===== Form screen ===== */
.form-shell {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.form-shell__body {
  flex: 1;
  display: flex;
  flex-direction: column;
  /* Horizontal screen-padding теперь раздаётся MobileLayout-ом (--velo-screen-padding).
   * Здесь добавляем только vertical, чтобы не было двойного отступа по бокам. */
  padding: var(--space-5) 0;
  gap: var(--space-5);
}

/* Meta-cell для слота #practice-meta (контент от CheckinView / FeedbackView).
 * Layout самой practice-карточки (паддинги, иконка, заголовок, грид-meta) теперь
 * приходит из общего PracticeHeroCard variant="form" (F-3). Здесь остаётся только
 * стиль ячейки: дублируем scoped + :slotted, чтобы класс работал и для дефолтного
 * содержимого слота (FormShell scope), и для override от вьюх (parent scope). */
.form-shell__practice-meta-cell,
:slotted(.form-shell__practice-meta-cell) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
}

.form-shell__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-4) 0;
}

/* Question — паддинги и gap по Figma 2266:728 (карточка 336x87) */
.form-shell__question {
  text-align: center;
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: 20px var(--space-4) 22px;
}

.form-shell__question h3 {
  font-family: var(--font-body);
  font-size: var(--text-base);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin-bottom: 13px;
}

.form-shell__question p {
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
}

/* Selection slot wrapper */
.form-shell__selection {
  display: flex;
  justify-content: center;
}

/* Actions */
.form-shell__actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: auto;
}

.form-shell__disabled-hint {
  text-align: center;
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  margin: calc(-1 * var(--space-2)) 0 0;
}
</style>
