<!--
  VELO Frontend -- Onboarding View (onboarding 05-08)

  Four-step welcome carousel, shown once to new users (those whose
  onboarding_completed flag is false) right after they tap "Войти" on
  WelcomeView. App.vue mounts this only for new users.

  Steps:
    0  "Найдите свою практику"      (intro)
    1  "Ведите дневник"             (intro)
    2  "Карта себя"                 (intro)
    3  "Часовой пояс" -- VSelect of IANA zones, default from auto-detect

  Navigation:
    - "Далее" advances; on the last intro step it goes to the timezone step.
    - "Пропустить" jumps straight to the timezone step (step 3) -- the zone
      still has to be confirmed, so we never skip it entirely.
    - "Готово" on step 3 persists { timezone, onboarding_completed: true }
      via authStore.updateProfile, then emits `done`.

  Single outward event: `done`. App.vue switches to the dashboard on it.
  Persistence happens here so App.vue stays a simple state machine.

  Illustrations live in public/onboarding/ (provided separately):
    /onboarding/onboarding-practice.svg
    /onboarding/onboarding-diary.svg
    /onboarding/onboarding-masters.svg
-->

<template>
  <div class="onboarding">
    <!-- Skip: visible on intro steps only (not on the timezone step). -->
    <div class="onboarding__skip-row">
      <button
        v-if="!isTimezoneStep"
        type="button"
        class="onboarding__skip"
        @click="goToTimezoneStep"
      >
        Пропустить
      </button>
    </div>

    <!-- ================= INTRO STEPS (0-2) ================= -->
    <div v-if="!isTimezoneStep" class="onboarding__body velo-kbd-scroll">
      <img :src="currentSlide.image" :alt="currentSlide.title" class="onboarding__illustration" />
      <h2 class="onboarding__title">{{ currentSlide.title }}</h2>
      <p class="onboarding__text">{{ currentSlide.text }}</p>
    </div>

    <!-- ================= TIMEZONE STEP (3) ================= -->
    <div v-else class="onboarding__body onboarding__body--form velo-kbd-scroll">
      <h2 class="onboarding__title">Часовой пояс</h2>
      <p class="onboarding__text">
        Укажите ваш часовой пояс, чтобы мы правильно показывали время практик
      </p>
      <div class="onboarding__field">
        <TimezoneCityPicker :model-value="selectedTimezone" @update:modelValue="onPickTimezone" />
      </div>
    </div>

    <!-- ================= FOOTER: dots + action ================= -->
    <div class="onboarding__footer">
      <VPaginationDots :total="TOTAL_STEPS" :active="step" />

      <button
        type="button"
        class="onboarding__button"
        :disabled="submitting || (isTimezoneStep && !timezoneChosen)"
        @click="onPrimaryAction"
      >
        {{ isTimezoneStep ? 'Готово' : 'Далее' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import TimezoneCityPicker from '@/components/shared/TimezoneCityPicker.vue'
import { VPaginationDots } from '@/components/ui'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import { extractApiError } from '@/composables/useApiError'

const emit = defineEmits<{
  /** Onboarding finished (completed or skipped); flag is already persisted. */
  done: []
}>()

const authStore = useAuthStore()
const toast = useToast()

// Total steps: 3 intro + 1 timezone. Last index (3) is the timezone step.
const TOTAL_STEPS = 4
const TIMEZONE_STEP_INDEX = TOTAL_STEPS - 1

const step = ref(0)
const submitting = ref(false)
// Guards against a fast multi-click slipping past the timezone screen.
//
// The naive "step += 1" lets click 1 land on the timezone index (isTimezoneStep
// turns true synchronously) and click 2 immediately hit finish() -- the user
// never sees the timezone picker and it saves with the default zone.
//
// Two flags fix it deterministically:
//   advancing   -- blocks re-entrant intro->intro/->timezone advances.
//   finishArmed -- finish() only fires once the timezone step has been
//                  ENTERED and settled (armed on the next microtask). A click
//                  that races the transition into the timezone step finds
//                  finishArmed=false and is ignored; a deliberate later tap
//                  finds it true and proceeds.
const advancing = ref(false)
const finishArmed = ref(false)

const isTimezoneStep = computed(() => step.value === TIMEZONE_STEP_INDEX)

// -- Intro slides (0-2). Illustrations served from public/onboarding/. --
const SLIDES = [
  {
    image: '/onboarding/onboarding-practice.svg',
    title: 'Найдите свою практику',
    text: 'Выбирайте из медитаций, дыхательных и других практик с лучшими мастерами',
  },
  {
    image: '/onboarding/onboarding-diary.svg',
    title: 'Ведите дневник',
    text: 'Отслеживайте свое состояние до и после практик, получайте AI-инсайты',
  },
  {
    image: '/onboarding/onboarding-masters.svg',
    title: 'Карта себя',
    text: 'Живая карта, которая меняется вместе с вами, оставаясь актуальной по мере того, как вы продолжаете исследовать себя',
  },
] as const

// Only read on intro steps (v-if="!isTimezoneStep" -> step in 0..2), and
// step is capped at TIMEZONE_STEP_INDEX, so SLIDES[step] is always defined
// here. The ?? SLIDES[0] is a defensive fallback for an impossible state,
// not normal flow.
const currentSlide = computed(() => SLIDES[step.value] ?? SLIDES[0])

// -- Timezone default: auto-detect, fall back to UTC. -------------------------
// We do NOT clamp to the curated TIMEZONE_OPTIONS set: any valid IANA zone is
// kept as-is (the picker injects it as an extra option below). Only a missing /
// invalid detection falls back, and the fallback is UTC (not Moscow).
const FALLBACK_TIMEZONE = 'UTC'

/**
 * True if `zone` is a valid IANA id. The browser has no ZoneInfo, so we probe
 * via Intl: an invalid timeZone makes the constructor throw RangeError.
 */
function isValidIana(zone: string): boolean {
  if (!zone) return false
  try {
    Intl.DateTimeFormat(undefined, { timeZone: zone })
    return true
  } catch {
    return false
  }
}

function detectDefaultTimezone(): string {
  // 1. Prefer the user's existing profile zone if it is a valid IANA id.
  const profileTz = authStore.user?.timezone
  if (profileTz && isValidIana(profileTz)) {
    return profileTz
  }
  // 2. Otherwise the auto-detected zone, kept as-is if it is valid IANA.
  let detected = ''
  try {
    detected = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  } catch {
    detected = ''
  }
  if (isValidIana(detected)) {
    return detected
  }
  // 3. Nothing usable -> UTC.
  return FALLBACK_TIMEZONE
}

const selectedTimezone = ref(detectDefaultTimezone())

// Explicit-selection gate: the onboarding "Готово" button stays disabled until
// the user actually taps a city (operator 2026-06-09), even though a default
// zone is auto-detected above for persistence.
const timezoneChosen = ref(false)
function onPickTimezone(iana: string): void {
  selectedTimezone.value = iana
  timezoneChosen.value = true
}

// -- Navigation --------------------------------------------------------------

/**
 * Enter the timezone step and arm finish() only after the change settles.
 * Arming on the next microtask is what prevents a click that raced the
 * transition from immediately triggering finish().
 */
async function enterTimezoneStep(): Promise<void> {
  step.value = TIMEZONE_STEP_INDEX
  finishArmed.value = false
  await Promise.resolve()
  finishArmed.value = true
}

function goToTimezoneStep(): void {
  // "Пропустить" -- same destination, also armed after settle.
  void enterTimezoneStep()
}

async function onPrimaryAction(): Promise<void> {
  if (isTimezoneStep.value) {
    // Ignore clicks that raced the transition into the timezone step.
    if (!finishArmed.value) return
    await finish()
    return
  }
  // Intro steps: block re-entrant advances; cap at the timezone index.
  if (advancing.value) return
  advancing.value = true
  // try/finally so advancing is always released. Nothing here throws today
  // (assignments + a microtask await), but the finally guards against a
  // future change introducing a throw and leaving the button permanently
  // locked (every click would hit the `if (advancing.value) return` above).
  try {
    const next = Math.min(step.value + 1, TIMEZONE_STEP_INDEX)
    if (next === TIMEZONE_STEP_INDEX) {
      await enterTimezoneStep()
    } else {
      step.value = next
    }
  } finally {
    advancing.value = false
  }
}

// -- Finish: persist timezone + onboarding flag, then emit done. -------------

async function finish(): Promise<void> {
  if (submitting.value) return
  submitting.value = true
  try {
    await authStore.updateProfile({
      timezone: selectedTimezone.value,
      onboarding_completed: true,
    })
    emit('done')
  } catch (error) {
    toast.error(extractApiError(error, 'Не удалось сохранить. Попробуйте ещё раз.'))
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.onboarding {
  display: flex;
  flex-direction: column;
  /* Fill AppFrame's content area (it owns viewport height + safe-area once,
     app-wide). A fresh 100dvh here double-applies and makes content jump. */
  min-height: 100%;
  padding: var(--space-5);
  background: transparent;
}

.onboarding__skip-row {
  display: flex;
  justify-content: flex-end;
  /* Reserve height even when Skip is hidden so layout doesn't jump. */
  min-height: 24px;
}

.onboarding__skip {
  background: transparent;
  border: none;
  cursor: pointer;
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  padding: var(--space-1) var(--space-2);
}

.onboarding__body {
  flex: 1;
  /* ROOT-LOCK: own the scroll so the skip-row/footer stay pinned while long
     slide text or the timezone picker scrolls (html/body/#app no longer
     absorb overflow). */
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: var(--space-4);
}

.onboarding__body--form {
  justify-content: center;
  gap: var(--space-5);
}

.onboarding__illustration {
  width: 180px;
  height: 180px;
  object-fit: contain;
}

.onboarding__title {
  font-family: var(--font-body);
  font-size: var(--text-xl);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0;
}

.onboarding__text {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-secondary);
  margin: 0;
  max-width: 300px;
  line-height: 1.5;
}

.onboarding__field {
  width: 100%;
  max-width: var(--velo-content-width);
  text-align: left;
}

.onboarding__footer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-5);
  padding-top: var(--space-4);
}

.onboarding__button {
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

.onboarding__button:hover {
  opacity: 0.9;
}

.onboarding__button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.onboarding__button:focus-visible {
  outline: 2px solid var(--velo-primary);
  outline-offset: 2px;
}
</style>
