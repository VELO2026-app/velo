<!--
  VELO Frontend -- Onboarding View (onboarding 05-07 + FE-101)

  Five-step welcome flow, shown once to new users (those whose
  onboarding_completed flag is still false). App.vue mounts it after "Войти"
  on WelcomeView; the school-join flow (CuratorGroupJoinView) mounts the same
  flow AFTER a successful join (FE-83) -- the invitation comes first.

  Steps:
    0  "Найдите свою практику"      (intro)
    1  "Ведите дневник"             (intro)
    2  "Карта себя"                 (intro)
    3  "Дата рождения"              (FE-101, form)
    4  "К чему бы вы хотели прийти?" (FE-101, form, finish)

  FE-101 reloaded the earlier screens' progress indicator for the new total:
  the dots (VPaginationDots) count every step of the flow, so the three intro
  slides now show five dots -- the indicator was already dots, what changed
  is the count it must reflect.

  The former timezone step is gone: the timezone is taken automatically from
  the user's DEVICE (Intl auto-detect, IANA-validated, UTC fallback) and
  persisted together with the onboarding flag on finish. It stays editable
  after onboarding: Профиль -> Часовой пояс (TimezoneSettingsView).

  Navigation:
    - "Далее" advances; on the last step it turns into "Готово".
    - "Пропустить" finishes onboarding outright (same persistence as Готово);
      visible on every step but the last, exactly as before FE-101.
    - The round back arrow (steps 3-4, per the operator mockup) steps back
      one screen; the collected answers stay in memory -- nothing persists
      until the finish.
    - "Готово" on the last step persists { timezone, onboarding_completed:
      true, birth_date?, goals?, goals_custom? } via authStore.updateProfile,
      then emits `done`. The FE-101 answers ride the SAME single PATCH --
      there is no per-step save, so a user who skips never leaves half an
      answer behind. Empty answers are simply not sent (the backend's
      "not sent leaves untouched" semantics).

  Single outward event: `done`. App.vue switches to the dashboard on it.
  Persistence happens here so App.vue stays a simple state machine.

  Illustrations live in public/onboarding/ (provided separately):
    /onboarding/onboarding-practice.svg
    /onboarding/onboarding-diary.svg
    /onboarding/onboarding-masters.svg
-->

<template>
  <div class="onboarding">
    <!-- Top row: back arrow on the FE-101 form steps (left), «Пропустить» on
         every step but the last (right). The intro slides keep the row at
         skip-height via the left spacer; the form steps' 44px back button
         sizes it. No step hides BOTH controls anymore (the last step keeps
         its back arrow), so the old collapse-to-zero on the final step is
         gone with the jump it existed to prevent. -->
    <div class="onboarding__top">
      <VBackButton v-if="step >= FIRST_FORM_STEP" class="onboarding__back" @click="goBack" />
      <span v-else class="onboarding__top-spacer" aria-hidden="true" />

      <button v-if="!isFinalStep" type="button" class="onboarding__skip" @click="onSkip">
        {{ t('common.skip') }}
      </button>
    </div>

    <!-- ================= INTRO STEPS (0-2) ================= -->
    <div v-if="step <= LAST_INTRO_STEP" class="onboarding__body velo-kbd-scroll">
      <img
        :src="currentSlide.image"
        :alt="currentSlide.title"
        class="onboarding__illustration"
        decoding="async"
      />
      <h2 class="onboarding__title">{{ currentSlide.title }}</h2>
      <p class="onboarding__text">{{ currentSlide.text }}</p>
    </div>

    <!-- ================= DATE STEP (3, FE-101) ================= -->
    <div v-else-if="step === DATE_STEP" class="onboarding__body velo-kbd-scroll">
      <OnboardingDateStep v-model="birthDate" />
    </div>

    <!-- ================= GOALS STEP (4, FE-101, finish) ================= -->
    <div v-else class="onboarding__body velo-kbd-scroll">
      <OnboardingGoalStep v-model:selected="selectedGoals" v-model:custom="customGoal" />
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
        {{ isFinalStep ? t('auth.onboarding.done') : t('auth.onboarding.next') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { ref, computed } from 'vue'
import { VBackButton, VPaginationDots } from '@/components/ui'
import OnboardingDateStep from '@/components/onboarding/OnboardingDateStep.vue'
import OnboardingGoalStep from '@/components/onboarding/OnboardingGoalStep.vue'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import { extractApiError } from '@/composables/useApiError'
import { GOAL_CUSTOM } from '@/utils/userGoals'
import type { UserUpdate } from '@/api/types'

const emit = defineEmits<{
  /** Onboarding finished (completed or skipped); flag is already persisted. */
  done: []
}>()

const authStore = useAuthStore()
const toast = useToast()

// Total steps: 3 intro slides + the FE-101 date and goal screens. The last
// one (goals) is also the finish step.
const TOTAL_STEPS = 5
const FINAL_STEP_INDEX = TOTAL_STEPS - 1
const LAST_INTRO_STEP = 2
const DATE_STEP = 3
const FIRST_FORM_STEP = DATE_STEP

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
    get title(): string {
      return t('auth.onboarding.find.title')
    },
    get text(): string {
      return t('auth.onboarding.find.text')
    },
  },
  {
    image: '/onboarding/onboarding-diary.svg',
    get title(): string {
      return t('auth.onboarding.diary.title')
    },
    get text(): string {
      return t('auth.onboarding.diary.text')
    },
  },
  {
    image: '/onboarding/onboarding-masters.svg',
    get title(): string {
      return t('auth.onboarding.map.title')
    },
    get text(): string {
      return t('auth.onboarding.map.text')
    },
  },
] as const

// step is capped at LAST_INTRO_STEP inside the intro branch, so SLIDES[step]
// is always defined there. The ?? SLIDES[0] is a defensive fallback for an
// impossible state, not a normal-flow branch.
const currentSlide = computed(() => SLIDES[step.value] ?? SLIDES[0])

// -- FE-101 answers: kept in memory until the single finish PATCH. ---------
const birthDate = ref('')
const selectedGoals = ref<string[]>([])
const customGoal = ref('')

// -- Timezone: taken from the DEVICE, there is no manual step. ---------------
// We do NOT clamp to the curated TIMEZONE_OPTIONS set and do NOT prefer the
// profile zone: everyone reaching this screen is a NEW user whose profile
// zone is just the server default ('UTC') -- preferring it would shadow the
// real device zone. The backend accepts any known IANA id in either spelling
// and stores it canonical ("Asia/Katmandu" -> "Asia/Kathmandu", users/schemas.py
// validate_timezone -> app/core/timezones.py), so the detected zone is sent
// as-is. Only a missing / invalid detection falls back, and the fallback is UTC.
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

/** The back arrow on the FE-101 form steps: one step back, floor at zero. */
function goBack(): void {
  if (advancing.value) return
  step.value = Math.max(step.value - 1, 0)
}

/** t('common.skip') -- finish onboarding outright with the device timezone. */
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
  // Non-final steps: block re-entrant advances; cap at the final index.
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

// -- Finish: persist device timezone + FE-101 answers + the onboarding flag,
//    then emit done. Empty answers are not sent at all -- the backend treats
//    an absent key as "leave untouched", and a first-run profile has nothing
//    older to protect, so this is purely "send what was actually chosen". --

function finishPayload(): UserUpdate {
  const payload: UserUpdate = {
    timezone: deviceTimezone,
    onboarding_completed: true,
  }
  if (birthDate.value) {
    payload.birth_date = birthDate.value
  }
  if (selectedGoals.value.length > 0) {
    payload.goals = selectedGoals.value
    // The free text travels only with its pick: unchecked «Свой вариант»
    // must not save a stale answer typed before the toggle went off.
    if (selectedGoals.value.includes(GOAL_CUSTOM)) {
      const custom = customGoal.value.trim()
      if (custom) payload.goals_custom = custom
    }
  }
  return payload
}

async function finish(): Promise<void> {
  if (submitting.value) return
  submitting.value = true
  try {
    await authStore.updateProfile(finishPayload())
    emit('done')
  } catch (error) {
    toast.error(extractApiError(error, t('auth.onboarding.saveFailed')))
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

.onboarding__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  /* Reserve the skip row's height so the body below does not reflow between
     the intro steps (the FE-101 steps carry the taller back button). */
  min-height: 24px;
}

.onboarding__top-spacer {
  width: 44px;
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
  /* ROOT-LOCK: own the scroll so the top row/footer stay pinned while long
     slide text (or the goal list) scrolls (html/body/#app no longer absorb
     overflow). */
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
