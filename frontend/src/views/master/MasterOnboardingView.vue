<!--
  VELO Frontend -- MasterOnboardingView (master onboarding, Phase D slice-1)

  Three-step welcome carousel shown ONCE to a freshly-verified master, as a
  full-screen overlay on first master-dashboard entry (gate + persistence live
  in MasterDashboardView + utils/masterOnboarding; this view is presentational).

  Cloned 1:1 from the user OnboardingView so the two carousels feel like one
  system (operator EYEBALL-1), MINUS the timezone step (the master already set
  their timezone as a user).

  Steps:
    0  "Добро пожаловать"                 -> master-welcome.svg
    1  "Ваше пространство"                -> master-space.svg
    2  "AI-аналитика о состоянии группы"  -> master-analytics.svg

  Navigation:
    - "Далее" advances; on the last step the CTA is "Войти в кабинет".
    - "Пропустить" dismisses the whole carousel.
    Both finish paths emit a single `done` event; the parent persists the flag
    and hides the overlay (no navigation).

  Illustrations live in public/onboarding/ (extracted from the design SVGs).
-->

<template>
  <div class="master-onboarding">
    <!-- Skip: dismisses the carousel from any step. -->
    <div class="master-onboarding__skip-row">
      <button type="button" class="master-onboarding__skip" @click="skip">Пропустить</button>
    </div>

    <div class="master-onboarding__body">
      <img
        :src="currentSlide.image"
        :alt="currentSlide.title"
        class="master-onboarding__illustration"
      />
      <h2 class="master-onboarding__title">{{ currentSlide.title }}</h2>
      <p class="master-onboarding__text">{{ currentSlide.text }}</p>
    </div>

    <div class="master-onboarding__footer">
      <VPaginationDots :total="TOTAL_STEPS" :active="step" />

      <button type="button" class="master-onboarding__button" @click="onPrimaryAction">
        {{ isLastStep ? 'Войти в кабинет' : 'Далее' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { VPaginationDots } from '@/components/ui'

const emit = defineEmits<{
  /** Carousel finished (completed or skipped). Parent persists + hides. */
  done: []
}>()

// -- Intro slides. Illustrations served from public/onboarding/. --
const SLIDES = [
  {
    image: '/onboarding/master-welcome.svg',
    title: 'Добро пожаловать',
    text: 'Вы — часть сообщества мастеров VELO',
  },
  {
    image: '/onboarding/master-space.svg',
    title: 'Ваше пространство',
    text: 'Персональное пространство с вашим профилем, описанием метода, расписанием и записями практик',
  },
  {
    image: '/onboarding/master-analytics.svg',
    title: 'AI-аналитика о состоянии группы',
    text: 'Эмоциональный ландшафт участников до и после практики',
  },
] as const

const TOTAL_STEPS = SLIDES.length

const step = ref(0)
// Emit `done` only once (guards a double-tap on the last step / skip).
const finished = ref(false)

const isLastStep = computed(() => step.value === TOTAL_STEPS - 1)

// step is capped at the last index, so SLIDES[step] is always defined; the
// ?? SLIDES[0] is a defensive fallback for an impossible state.
const currentSlide = computed(() => SLIDES[step.value] ?? SLIDES[0])

function finish(): void {
  if (finished.value) return
  finished.value = true
  emit('done')
}

function onPrimaryAction(): void {
  if (isLastStep.value) {
    finish()
    return
  }
  step.value = Math.min(step.value + 1, TOTAL_STEPS - 1)
}

function skip(): void {
  finish()
}
</script>

<style scoped>
.master-onboarding {
  display: flex;
  flex-direction: column;
  /* Fill the overlay area (the parent overlay owns viewport height + safe-area). */
  min-height: 100%;
  padding: var(--space-5);
  background: transparent;
}

.master-onboarding__skip-row {
  display: flex;
  justify-content: flex-end;
  /* Reserve height so layout doesn't depend on the button. */
  min-height: 24px;
}

.master-onboarding__skip {
  background: transparent;
  border: none;
  cursor: pointer;
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  padding: var(--space-1) var(--space-2);
}

.master-onboarding__body {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: var(--space-4);
}

.master-onboarding__illustration {
  width: 180px;
  height: 180px;
  object-fit: contain;
}

.master-onboarding__title {
  font-family: var(--font-body);
  font-size: var(--text-xl);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0;
}

.master-onboarding__text {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-secondary);
  margin: 0;
  max-width: var(--velo-content-width-narrow);
  line-height: 1.5;
}

.master-onboarding__footer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-5);
  padding-top: var(--space-4);
}

.master-onboarding__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  max-width: var(--velo-content-width);
  height: var(--velo-size-50);
  font-family: var(--font-body);
  font-size: var(--text-base);
  cursor: pointer;
  border-radius: var(--radius-full);
  border: 1px solid var(--velo-glass-border);
  background: var(--velo-primary);
  color: var(--velo-white);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  box-shadow: var(--velo-shadow-glow);
  transition: opacity var(--transition-fast);
}

.master-onboarding__button:hover {
  opacity: 0.9;
}

.master-onboarding__button:focus-visible {
  outline: 2px solid var(--velo-primary);
  outline-offset: 2px;
}
</style>
