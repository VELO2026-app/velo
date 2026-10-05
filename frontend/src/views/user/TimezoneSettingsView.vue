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
    - LANGUAGE: the interface-language section was REMOVED (operator 2026-09-17):
      there is no i18n and none is planned yet, so a one-option «Русский» stub
      only advertised a switch that cannot happen. A switcher returns together
      with real i18n.
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
    <VHeader title="Часовой пояс" show-back @back="router.back()" />

    <div class="tz-settings__content">
      <!-- Timezone (UNCHANGED — existing onboarding picker, shared with the user) -->
      <section class="tz-settings__section">
        <h2 class="tz-settings__section-title">Часовой пояс</h2>
        <p class="tz-settings__subtitle">
          Время практик будет отображаться в выбранном часовом поясе
        </p>
        <TimezoneCityPicker :model-value="selectedTimezone" @update:modelValue="onTimezoneChange" />
      </section>

      <!-- Date format (captured-only — see header / Zod task) -->
      <section class="tz-settings__section">
        <h2 class="tz-settings__section-title">Формат даты</h2>
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
import TimezoneCityPicker from '@/components/shared/TimezoneCityPicker.vue'
import { useToast } from '@/composables/useToast'
import { useAuthStore } from '@/stores/auth'
import { extractApiError } from '@/composables/useApiError'

const router = useRouter()
const toast = useToast()
const authStore = useAuthStore()

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
