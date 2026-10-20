<!--
  VELO Frontend -- TimezoneSettingsView (Phase-3 redesign, 2026-06-13; renamed
  from LanguageTimezoneView 2026-09-17 when the language section was removed)

  Shared settings screen for timezone + date format. Mounted on BOTH the user
  (`user-timezone`) and master (`master-timezone`) routes — one file,
  role-agnostic. Rebuilt to the operator SVG «7 Language/Timezone».

  Operator decisions 2026-06-13:
    - TIMEZONE (В1): KEPT the existing TimezoneCityPicker combobox («align with the
      user's» — already built, covers ~100 cities with live time + UTC offset). The
      SVG's Москва/Лондон preset rows are NOT built — the search covers that need.
    - LANGUAGE: RETURNED (tz-i18n phase 5; the section was removed 2026-09-17
      with the note «a switcher returns together with real i18n» -- it has).
      Rows per the original SVG markup (globe + checkmark on the active row);
      the list is availableLocales() -- locales that actually have catalogs
      (ru/en today; de/es appear when their catalogs land). Selecting a row
      switches the locale IMMEDIATELY (optimistic, live re-render) and PATCHes
      user.language via the existing /users/me endpoint; the App.vue watcher's
      follow-up applyUserLanguage is a no-op (setLocale early-exits on the
      same locale). Revert + toast on failure, same contract as the timezone
      row below. The server owns the value; no switcher state lives here.
    - DATE FORMAT (В2=А): the «Формат даты» dropdown is built per the SVG but is
      CAPTURED-ONLY — selecting a format does not change how dates render (dates go
      through the fixed format.ts). Backend task (Zod): store + actually apply a
      date-format preference app-wide.
    - SAVE (В3=А): no «Сохранить» button — timezone auto-saves on selection (the
      established behaviour); a button on an auto-saving screen would mislead.

  Route: /{user,master}/profile/timezone.
-->
<template>
  <div class="tz-settings">
    <VHeader :title="t('user.screens.timezoneSettings.title')" show-back @back="router.back()" />

    <div class="tz-settings__content">
      <!-- Language (returned tz-i18n phase 5 — see header) -->
      <section class="tz-settings__section">
        <h2 class="tz-settings__section-title">
          {{ t('user.screens.timezoneSettings.language.title') }}
        </h2>
        <div class="tz-settings__langs">
          <button
            v-for="code in languageOptions"
            :key="code"
            type="button"
            class="tz-settings__lang"
            :class="{ 'tz-settings__lang--active': code === selectedLanguage }"
            :disabled="savingLanguage"
            @click="onSelectLanguage(code)"
          >
            <IconGlobe :size="22" class="tz-settings__lang-globe" />
            <span class="tz-settings__lang-label">{{ t(`ui.languageNames.${code}`) }}</span>
            <IconCheck
              v-if="code === selectedLanguage"
              :size="20"
              class="tz-settings__lang-check"
            />
          </button>
        </div>
      </section>

      <!-- Timezone (UNCHANGED — existing onboarding picker, shared with the user) -->
      <section class="tz-settings__section">
        <h2 class="tz-settings__section-title">
          {{ t('user.screens.timezoneSettings.timezone.label') }}
        </h2>
        <p class="tz-settings__subtitle">
          {{ t('user.screens.timezoneSettings.note') }}
        </p>
        <TimezoneCityPicker :model-value="selectedTimezone" @update:modelValue="onTimezoneChange" />
      </section>

      <!-- Date format (captured-only — see header / Zod task) -->
      <section class="tz-settings__section">
        <h2 class="tz-settings__section-title">
          {{ t('user.screens.timezoneSettings.dateFormat.label') }}
        </h2>
        <VSelect v-model="selectedDateFormat" :options="DATE_FORMAT_OPTIONS" />
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t, availableLocales, setLocale } from '@/locales'
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

// -- Language (returned tz-i18n phase 5) -------------------------------------
// Options: locales that actually have catalogs, in canonical order -- the
// switcher never advertises a locale that would render fallback forever.
const languageOptions = availableLocales()

// The stored value if it is an offered option, else the default locale.
const selectedLanguage = ref(
  languageOptions.includes(authStore.user?.language ?? '')
    ? (authStore.user?.language as string)
    : 'ru',
)

const savingLanguage = ref(false)

async function onSelectLanguage(code: string): Promise<void> {
  if (savingLanguage.value || code === selectedLanguage.value) return
  const previous = selectedLanguage.value
  // Optimistic: switch the UI NOW (live re-render of every t() call); the
  // App.vue watcher's later applyUserLanguage is a same-locale no-op.
  // setLocale is INSIDE the try (review P1): a rejected chunk load used to
  // leave the row flipped with no revert and an unhandled rejection.
  selectedLanguage.value = code
  savingLanguage.value = true
  try {
    await setLocale(code)
    await authStore.updateProfile({ language: code })
    toast.info(t('user.screens.timezoneSettings.language.toastSaved'))
  } catch (error) {
    selectedLanguage.value = previous
    await setLocale(previous)
    toast.error(extractApiError(error, t('user.screens.timezoneSettings.language.toastSaveFailed')))
  } finally {
    savingLanguage.value = false
  }
}

// -- Date format (captured-only) --------------------------------------------
// Built per the SVG but inert: dates render through the fixed format.ts, so the
// choice does not apply yet. Zod task: persist + apply a date-format preference.
const DATE_FORMAT_OPTIONS = [
  { value: 'dd.mm.yyyy', label: t('user.screens.timezoneSettings.dateFormat.dmy') },
  { value: 'yyyy-mm-dd', label: t('user.screens.timezoneSettings.dateFormat.ymd') },
  { value: 'mm/dd/yyyy', label: t('user.screens.timezoneSettings.dateFormat.mdy') },
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
    toast.info(t('user.screens.timezoneSettings.toast.saved'))
  } catch (error) {
    // Revert the selection so the UI matches the server on failure.
    selectedTimezone.value = previous
    toast.error(extractApiError(error, t('user.screens.timezoneSettings.toast.saveFailed')))
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.tz-settings {
  display: flex;
  flex-direction: column;
  margin: calc(-1 * var(--space-4));
}

.tz-settings__content {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  padding: 0 var(--space-4) var(--space-4);
}

.tz-settings__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.tz-settings__section-title {
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

/* Language rows -- ported verbatim from the original LanguageTimezoneView
   (the «7 Language/Timezone» SVG): full-width 47px cards, globe left,
   checkmark right; the active row fills primary. */
.tz-settings__langs {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.tz-settings__lang {
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

.tz-settings__lang:disabled {
  opacity: 0.6;
  cursor: default;
}

.tz-settings__lang--active {
  background: var(--velo-primary);
  border-color: var(--velo-primary);
  color: var(--velo-white);
}

.tz-settings__lang-globe {
  flex-shrink: 0;
}

.tz-settings__lang-label {
  flex: 1;
}

.tz-settings__lang-check {
  flex-shrink: 0;
}

/* Subtitle directly under the «Часовой пояс» heading (operator 2026-06-19). The
   negative top margin pulls it tight to the heading inside the section gap. */
.tz-settings__subtitle {
  margin: calc(-1 * var(--space-2)) 0 0;
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  line-height: 1.35;
}
</style>
