<!--
  VELO Frontend -- OnboardingDateStep (FE-101, onboarding step 4 of 5)

  The «Дата рождения» body of the user onboarding: title, one line of copy
  and a single field-styled button that opens BirthDateSheet. The shell
  (dots, «Пропустить», back arrow, «Далее») belongs to OnboardingView; this
  component only owns the date itself.

  v-model is an ISO 'YYYY-MM-DD' string, '' until a date is saved in the
  sheet. Choosing is OPTIONAL by design: the step's «Далее» stays enabled
  with no date (nothing is sent for birth_date then) -- the screen collects
  a nicety, it does not gate the flow, same spirit as «Пропустить».
-->

<template>
  <div class="ob-date">
    <h2 class="ob-date__title">{{ t('auth.onboarding.birth.title') }}</h2>
    <p class="ob-date__text">{{ t('auth.onboarding.birth.text') }}</p>

    <button type="button" class="ob-date__field" @click="sheetOpen = true">
      <IconCalendar class="ob-date__icon" :size="20" />
      <span class="ob-date__value" :class="{ 'ob-date__value--empty': !modelValue }">
        {{ modelValue ? formatted : t('auth.onboarding.birth.choose') }}
      </span>
    </button>

    <BirthDateSheet
      :open="sheetOpen"
      :model-value="modelValue"
      @update:model-value="onPick"
      @close="sheetOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { getLocale, t } from '@/locales'
import { IconCalendar } from '@/components/icons'
import BirthDateSheet from '@/components/shared/BirthDateSheet.vue'

const props = withDefaults(
  defineProps<{
    /** ISO 'YYYY-MM-DD', '' = not chosen yet. */
    modelValue?: string
  }>(),
  { modelValue: '' },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const sheetOpen = ref(false)

// «14 октября 2001 г.» in ru, straight from ICU -- the app's single date
// spelling authority (utils/format.ts uses the same composer). Noon anchor:
// the ISO date is parsed in the RUNNER's zone, and a midnight anchor can
// slide to the previous day in a zone behind UTC. Called WITHOUT `new`
// (Intl constructors are legacy-callable; keeps the test Intl spy happy).
const formatted = computed(() =>
  Intl.DateTimeFormat(getLocale(), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${props.modelValue}T12:00:00`)),
)

function onPick(value: string): void {
  emit('update:modelValue', value)
}
</script>

<style scoped>
.ob-date {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  width: 100%;
  /* Same vertical rest spot the intro slides centre on: the shell's body
     centres this column, so the field keeps the slide's optical rhythm. */
  padding: var(--space-6) 0;
}

.ob-date__title {
  font-family: var(--font-body);
  font-size: var(--text-xl);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0;
  text-align: center;
}

.ob-date__text {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-secondary);
  margin: 0;
  max-width: var(--velo-content-width-narrow);
  line-height: 1.5;
  text-align: center;
}

/* Field-styled trigger: reads as the input from the mockup, acts as the
   button it is. Full content width so the calendar icon sits at the row's
   start, the value/placeholder next to it. */
.ob-date__field {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  max-width: var(--velo-content-width);
  height: var(--velo-size-50);
  padding: 0 var(--space-4);
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  border-radius: var(--radius-full);
  border: 1px solid var(--velo-glass-border);
  background: var(--velo-white);
  cursor: pointer;
  transition: border-color var(--transition-fast);
}

.ob-date__field:hover {
  border-color: var(--velo-primary);
}

.ob-date__field:focus-visible {
  outline: 2px solid var(--velo-primary);
  outline-offset: 2px;
}

.ob-date__icon {
  flex-shrink: 0;
  color: var(--velo-primary);
}

.ob-date__value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ob-date__value--empty {
  color: var(--velo-text-secondary);
}
</style>
