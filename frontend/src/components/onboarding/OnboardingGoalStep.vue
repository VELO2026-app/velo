<!--
  VELO Frontend -- OnboardingGoalStep (FE-101, onboarding step 5 of 5)

  The «К чему бы вы хотели прийти?» body of the user onboarding: a
  multi-select checkbox list from USER_GOAL_OPTIONS plus the «Свой вариант»
  reveal (GOAL_CUSTOM) with a free-text input. The shell (dots, back arrow,
  «Готово») belongs to OnboardingView; this component only owns the picks.

  Nothing is REQUIRED: «Готово» stays enabled with zero picks -- the flow
  never traps a user who would rather not say (the same optionality the
  Skip on every earlier step gives). The parent decides what to send.
-->

<template>
  <div class="ob-goals">
    <h2 class="ob-goals__title">{{ t('auth.onboarding.goals.title') }}</h2>

    <div class="ob-goals__list velo-kbd-scroll">
      <VCheckbox
        v-for="slug in USER_GOAL_OPTIONS"
        :key="slug"
        :model-value="selected.includes(slug)"
        :label="t(`auth.onboarding.goals.options.${slug}`)"
        class="ob-goals__option"
        @update:model-value="toggle(slug)"
      />

      <!-- «Свой вариант» reveal: the input mounts only while the pick is
           on, so the list never reserves dead space for it. The wrapper div
           carries the class -- VInput sets inheritAttrs:false and forwards
           attrs (a class included) onto its INNER input, so a class placed
           on the component would land on the wrong element for every
           caller trying to target it. -->
      <div v-if="selected.includes(GOAL_CUSTOM)" class="ob-goals__custom">
        <VInput
          v-model="customText"
          :placeholder="t('auth.onboarding.goals.customPlaceholder')"
          :maxlength="200"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { VCheckbox, VInput } from '@/components/ui'
import { GOAL_CUSTOM, USER_GOAL_OPTIONS } from '@/utils/userGoals'

// v-model:selected -- the picked slugs, in the catalog's order.
// v-model:custom -- the free text behind GOAL_CUSTOM.
const selected = defineModel<string[]>('selected', { required: true })
const customText = defineModel<string>('custom', { required: true })

function toggle(slug: string): void {
  if (selected.value.includes(slug)) {
    selected.value = selected.value.filter((s) => s !== slug)
  } else {
    selected.value = [...selected.value, slug]
  }
}
</script>

<style scoped>
.ob-goals {
  display: flex;
  flex-direction: column;
  width: 100%;
  gap: var(--space-5);
}

.ob-goals__title {
  font-family: var(--font-body);
  font-size: var(--text-xl);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0;
  text-align: center;
}

.ob-goals__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  width: 100%;
  max-width: var(--velo-content-width);
  margin: 0 auto;
  /* The list is the tallest step of the flow: own the scroll so the title,
     dots and «Готово» stay pinned (ROOT-LOCK, same as the intro body). */
  min-height: 0;
  overflow-y: auto;
  padding-bottom: var(--space-2);
}

.ob-goals__option {
  align-self: flex-start;
}

.ob-goals__custom {
  padding-left: var(--space-8);
}
</style>
