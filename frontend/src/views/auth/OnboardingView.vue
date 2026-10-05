<!--
  VELO Frontend -- Onboarding View (onboarding 05-07)

  Three-step welcome carousel, shown once to new users (those whose
  onboarding_completed flag is false) right after they tap "Войти" on
  WelcomeView. App.vue mounts this only for new users.

  Steps:
    0  "Найдите свою практику"      (intro)
    1  "Ведите дневник"             (intro)
    2  "Карта себя"                 (intro)

  The former timezone step is gone: the timezone is taken automatically from
  the user's DEVICE (Intl auto-detect, IANA-validated, UTC fallback) and
  persisted together with the onboarding flag on finish. It stays editable
  after onboarding: Профиль -> Часовой пояс (TimezoneSettingsView).

  Navigation:
    - "Далее" advances; on the last slide it turns into "Готово".
    - "Пропустить" finishes onboarding outright (same persistence as Готово).
    - "Готово" on the last slide persists { timezone, onboarding_completed:
      true } via authStore.updateProfile, then emits `done`.

  Single outward event: `done`. App.vue switches to the dashboard on it.
  Persistence happens here so App.vue stays a simple state machine.

  Illustrations live in public/onboarding/ (provided separately):
    /onboarding/onboarding-practice.svg
    /onboarding/onboarding-diary.svg
    /onboarding/onboarding-masters.svg
-->

<template>
  <div class="onboarding">
    <!-- Skip: visible on every step but the last (where «Готово» already IS
         the finish action). On the last step the row collapses to zero -- it
         reserved 24px for a button that never renders there, dead height the
         slide does not need. The reserve still stands BETWEEN earlier steps
         (no layout jump 0↔1). -->
    <div class="onboarding__skip-row" :class="{ 'onboarding__skip-row--last': isFinalStep }">
      <button v-if="!isFinalStep" type="button" class="onboarding__skip" @click="onSkip">
        Пропустить
      </button>
    </div>

    <!-- ================= INTRO STEPS (0-2) ================= -->
    <div class="onboarding__body velo-kbd-scroll">
      <img :src="currentSlide.image" :alt="currentSlide.title" class="onboarding__illustration" />
      <h2 class="onboarding__title">{{ currentSlide.title }}</h2>
      <p class="onboarding__text">{{ currentSlide.text }}</p>
    </div>

    <!-- ================= FOOTER: dots + action ================= -->
    <div class="onboarding__footer">
      <VPaginationDots :total="TOTAL_STEPS" :active="step" />

      <button
        type="button"
        class="onboarding__button"
        :disabled="submitting"
        @click="onPrimaryAction"
      >
        {{ isFinalStep ? 'Готово' : 'Далее' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
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

// Total steps: 3 intro slides. The last one is also the finish step.
const TOTAL_STEPS = 3
const FINAL_STEP_INDEX = TOTAL_STEPS - 1

const step = ref(0)
const submitting = ref(false)
// Guards against a fast multi-click slipping past the last intro slide.
//
// The naive "step += 1" lets click 1 land on the final index (isFinalStep
// turns true synchronously) and click 2 immediately hit finish() -- the user
// never sees the last slide and a stray double-tap ends onboarding.
//
// Two flags fix it deterministically:
//   advancing   -- blocks re-entrant slide->slide advances.
//   finishArmed -- finish() only fires once the final step has been
//                  ENTERED and settled (armed on the next microtask). A click
//                  that races the transition onto the final step finds
//                  finishArmed=false and is ignored; a deliberate later tap
//                  finds it true and proceeds.
const advancing = ref(false)
const finishArmed = ref(false)

const isFinalStep = computed(() => step.value === FINAL_STEP_INDEX)

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

// step is capped at FINAL_STEP_INDEX, so SLIDES[step] is always defined here.
// The ?? SLIDES[0] is a defensive fallback for an impossible state, not a
// normal-flow branch.
const currentSlide = computed(() => SLIDES[step.value] ?? SLIDES[0])

// -- Timezone: taken from the DEVICE, there is no manual step. ---------------
// We do NOT clamp to the curated TIMEZONE_OPTIONS set and do NOT prefer the
// profile zone: everyone reaching this screen is a NEW user whose profile
// zone is just the server default ('UTC') -- preferring it would shadow the
// real device zone. The backend accepts any valid IANA id (users/schemas.py
// validate_timezone), so the detected zone is sent as-is. Only a missing /
// invalid detection falls back, and the fallback is UTC.
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

function detectDeviceTimezone(): string {
  let detected = ''
  try {
    detected = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  } catch {
    detected = ''
  }
  return isValidIana(detected) ? detected : FALLBACK_TIMEZONE
}

// Detected once per mount; finish() persists it as-is.
const deviceTimezone = detectDeviceTimezone()

// -- Navigation --------------------------------------------------------------

/**
 * Enter the final step and arm finish() only after the change settles.
 * Arming on the next microtask is what prevents a click that raced the
 * transition from immediately triggering finish().
 */
async function enterFinalStep(): Promise<void> {
  step.value = FINAL_STEP_INDEX
  finishArmed.value = false
  await Promise.resolve()
  finishArmed.value = true
}

/** "Пропустить" -- finish onboarding outright with the device timezone. */
function onSkip(): void {
  void finish()
}

async function onPrimaryAction(): Promise<void> {
  if (isFinalStep.value) {
    // Ignore clicks that raced the transition onto the final step.
    if (!finishArmed.value) return
    await finish()
    return
  }
  // Intro steps: block re-entrant advances; cap at the final index.
  if (advancing.value) return
  advancing.value = true
  // try/finally so advancing is always released. Nothing here throws today
  // (assignments + a microtask await), but the finally guards against a
  // future change introducing a throw and leaving the button permanently
  // locked (every click would hit the `if (advancing.value) return` above).
  try {
    const next = Math.min(step.value + 1, FINAL_STEP_INDEX)
    if (next === FINAL_STEP_INDEX) {
      await enterFinalStep()
    } else {
      step.value = next
    }
  } finally {
    advancing.value = false
  }
}

// -- Finish: persist device timezone + onboarding flag, then emit done. ------

async function finish(): Promise<void> {
  if (submitting.value) return
  submitting.value = true
  try {
    await authStore.updateProfile({
      timezone: deviceTimezone,
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

.onboarding__skip-row--last {
  min-height: 0;
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
     slide text scrolls (html/body/#app no longer absorb overflow). */
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: var(--space-4);
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
  max-width: var(--velo-content-width-narrow);
  line-height: 1.5;
}

.onboarding__footer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding-top: var(--space-3);
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

/* === FE-36: keyboard-open compaction ===
   When the keyboard opens, global.css shrinks .app-frame to --velo-vvh, so
   the whole column (footer included) must fit the VISIBLE area. While typing
   anywhere: halve the gaps, slim the frame paddings. The button and dots stay
   put -- only their breathing room shrinks. Inert at rest:
   html.is-keyboard-open exists only while the keyboard is open
   (useViewportGeometry). */
:global(html.is-keyboard-open) .onboarding {
  padding-top: var(--space-3);
  padding-bottom: var(--space-3);
}

:global(html.is-keyboard-open) .onboarding__footer {
  gap: var(--space-2);
  padding-top: var(--space-2);
}
</style>
