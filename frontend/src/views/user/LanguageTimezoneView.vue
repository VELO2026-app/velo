<!--
  VELO Frontend -- LanguageTimezoneView (Phase-3 redesign, 2026-06-13)

  Shared settings screen for interface language + timezone + date format. Mounted
  on BOTH the user (`user-language-timezone`) and master (`master-language-timezone`)
  routes — one file, role-agnostic. Rebuilt to the operator SVG «7 Language/Timezone».

  Operator decisions 2026-06-13:
    - TIMEZONE (В1): KEPT the existing TimezoneCityPicker combobox («align with the
      user's» — already built, covers ~100 cities with live time + UTC offset). The
      SVG's Москва/Лондон preset rows are NOT built — the search covers that need.
    - LANGUAGE (В2=А): two rows per the SVG — «Русский» (active) and «English».
      The app has NO i18n yet, so English does NOT switch the language; tapping it
      toasts «появится позже» (no fake switch). Russian stays the only real option;
      nothing is persisted (there is nothing to change).
    - DATE FORMAT (В2=А): the «Формат даты» dropdown is built per the SVG but is
      CAPTURED-ONLY — selecting a format does not change how dates render (dates go
      through the fixed format.ts). Backend task (Zod): store + actually apply a
      date-format preference app-wide.
    - SAVE (В3=А): no «Сохранить» button — timezone auto-saves on selection (the
      established behaviour); a button on an auto-saving screen would mislead.

  Route: /{user,master}/profile/language-timezone.
-->
<template>
  <div class="lang-tz">
    <VHeader title="Язык/Часовой пояс" show-back @back="router.back()" />

    <div class="lang-tz__content">
      <!-- Language: Русский (real) + English (stub, toasts «later») -->
      <section class="lang-tz__section">
        <h2 class="lang-tz__section-title">Язык интерфейса</h2>
        <div class="lang-tz__langs">
          <button
            v-for="opt in LANGUAGE_OPTIONS"
            :key="opt.value"
            type="button"
            class="lang-tz__lang"
            :class="{ 'lang-tz__lang--active': opt.value === selectedLanguage }"
            @click="onSelectLanguage(opt)"
          >
            <IconGlobe :size="22" class="lang-tz__lang-globe" />
            <span class="lang-tz__lang-label">{{ opt.label }}</span>
            <IconCheck
              v-if="opt.value === selectedLanguage"
              :size="20"
              class="lang-tz__lang-check"
            />
          </button>
        </div>
      </section>

      <!-- Timezone (UNCHANGED — existing onboarding picker, shared with the user) -->
      <section class="lang-tz__section">
        <h2 class="lang-tz__section-title">Часовой пояс</h2>
        <p class="lang-tz__subtitle">
          Время практик будет отображаться в выбранном часовом поясе
        </p>
        <TimezoneCityPicker :model-value="selectedTimezone" @update:modelValue="onTimezoneChange" />
      </section>

      <!-- Date format (captured-only — see header / Zod task) -->
      <section class="lang-tz__section">
        <h2 class="lang-tz__section-title">Формат даты</h2>
        <VSelect v-model="selectedDateFormat" :options="DATE_FORMAT_OPTIONS" />
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VSelect } from '@/components/ui'
import { IconCheck, IconGlobe } from '@/components/icons'
import TimezoneCityPicker from '@/components/shared/TimezoneCityPicker.vue'
import { useToast } from '@/composables/useToast'
import { useAuthStore } from '@/stores/auth'
import { extractApiError } from '@/composables/useApiError'

const router = useRouter()
const toast = useToast()
const authStore = useAuthStore()

// -- Language ---------------------------------------------------------------
// «Русский» is the only real option (no i18n yet). «English» is rendered per the
// design but is a stub: tapping it toasts «later», it does NOT switch the language.
interface LanguageOption {
  value: string
  label: string
  available: boolean
}
// English is hidden for now (operator 2026-06-19) — Russian is the only option
// until i18n lands. The «available:false» stub path is kept for when English returns.
const LANGUAGE_OPTIONS: LanguageOption[] = [
  { value: 'ru', label: 'Русский', available: true },
]

// Current language: the stored value if it is a real (available) option, else ru.
const selectedLanguage = ref(
  LANGUAGE_OPTIONS.find((o) => o.value === authStore.user?.language && o.available)?.value ?? 'ru',
)

function onSelectLanguage(opt: LanguageOption): void {
  if (!opt.available) {
    // No i18n backend yet — don't fake a switch (Zod: real i18n).
    toast.info('Английский язык появится позже')
    return
  }
  selectedLanguage.value = opt.value
  // Only one real language today → nothing to persist.
}

// -- Date format (captured-only) --------------------------------------------
// Built per the SVG but inert: dates render through the fixed format.ts, so the
// choice does not apply yet. Zod task: persist + apply a date-format preference.
const DATE_FORMAT_OPTIONS = [
  { value: 'dd.mm.yyyy', label: 'ДД.ММ.ГГГГ' },
  { value: 'yyyy-mm-dd', label: 'ГГГГ-ММ-ДД' },
  { value: 'mm/dd/yyyy', label: 'ММ/ДД/ГГГГ' },
]
const selectedDateFormat = ref('dd.mm.yyyy')

// -- Timezone (unchanged from the prior build) ------------------------------
const FALLBACK_TIMEZONE = 'UTC'

/** Whether an IANA id is a real, resolvable zone (Intl throws otherwise). */
function isValidIana(zone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: zone })
    return true
  } catch {
    return false
  }
}

// Initial timezone: the user's profile zone (kept as-is when valid, even if it is
// outside the curated list), else fallback.
const profileTz = authStore.user?.timezone
const initialTimezone = profileTz && isValidIana(profileTz) ? profileTz : FALLBACK_TIMEZONE
const selectedTimezone = ref(initialTimezone)

const saving = ref(false)

async function onTimezoneChange(value: string): Promise<void> {
  if (saving.value) return
  const previous = selectedTimezone.value
  selectedTimezone.value = value
  saving.value = true
  try {
    await authStore.updateProfile({ timezone: value })
    toast.info('Часовой пояс сохранён')
  } catch (error) {
    // Revert the selection so the UI matches the server on failure.
    selectedTimezone.value = previous
    toast.error(extractApiError(error, 'Не удалось сохранить часовой пояс'))
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.lang-tz {
  display: flex;
  flex-direction: column;
  margin: calc(-1 * var(--space-4));
}

.lang-tz__content {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  padding: 0 var(--space-4) var(--space-4);
}

.lang-tz__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.lang-tz__section-title {
  font-family: var(--font-body);
  font-size: var(--text-base);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0;
  /* Matches the SVG section headers (Marmelad has no bold weight; the design
     thickens them with a 0.3 stroke). */
  -webkit-text-stroke: var(--velo-text-stroke-strong) currentColor;
}

/* -- Language rows (filled-selected per the SVG) -- */
.lang-tz__langs {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.lang-tz__lang {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  height: 47px;
  padding: 0 var(--velo-inset-row);
  border-radius: var(--radius-md);
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  color: var(--velo-text-primary);
  cursor: pointer;
  font-family: var(--font-body);
  text-align: left;
  transition:
    background-color var(--transition-base),
    color var(--transition-base);
}

.lang-tz__lang--active {
  background: var(--velo-primary);
  border-color: var(--velo-primary);
  color: var(--velo-white);
}

.lang-tz__lang-globe {
  flex-shrink: 0;
}

.lang-tz__lang-label {
  flex: 1;
  font-size: var(--text-base);
  letter-spacing: 0.02em;
}

.lang-tz__lang-check {
  flex-shrink: 0;
}

/* Subtitle directly under the «Часовой пояс» heading (operator 2026-06-19). The
   negative top margin pulls it tight to the heading inside the section gap. */
.lang-tz__subtitle {
  margin: calc(-1 * var(--space-2)) 0 0;
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  line-height: 1.35;
}
</style>
