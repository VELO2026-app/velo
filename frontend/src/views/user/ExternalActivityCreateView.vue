<!--
  VELO Frontend -- ExternalActivityCreateView (FE-70 / BE-27)

  Hand-entry screen for an activity that happened OUTSIDE velo (a home
  meditation, a massage, a dance class). Reached from the dashboard's
  «Быстрый доступ» -> «Внести активность». NOT a FormShell form: the shared
  shell is built around a practice card + one question, while this screen is
  a plain fill-route column (own header, scrolling body, floating save pill).

  Owner amendments (2026-09-10):
    - «Сохранить» is a FLOATING GLASS PILL -- the diary composer's Liquid
      Glass recipe hovering over the scrolling body (the body reserves the
      bottom clearance), not an in-flow footer bar;
    - required seals float in the LAYOUT's right padding: every field spans
      the full rail, the 22px marker centres in the 24px gutter;
    - the header carries no right-hand "..." placeholder;
    - the «Мое состояние» block is HIDDEN for now (EXTERNAL_ACTIVITY_MOOD_HIDDEN
      in utils/constants.ts): the backend's required mood submits as the
      neutral zone centre until the block returns with its Figma pressed
      states, and the feed card hides the «· N/10» suffix for the same reason.

  Everything a person enters here deliberately starts EMPTY: no prefilled
  "now", no default mood shown. The reference starts blank, and an autofill
  would invent a plausible-but-wrong diary entry.

  Submit is the real POST /api/v1/diary/external-activities through
  diaryStore.submitExternalActivity; the store refreshes the feed (the
  backend writes the activity and its diary event in one transaction), the
  view only toasts and navigates. Field-level 422s bind to their controls --
  the backend answers with SEVERAL at once on purpose.
-->

<template>
  <div class="ea">
    <header class="ea__header">
      <VBackButton aria-label="Назад на главную" @click="goBack" />
      <h1 class="ea__title">Новое событие</h1>
    </header>

    <div ref="bodyEl" class="ea__body">
      <!-- Required-fields legend (the same DS plate as CreatePracticeView) --
           a permanent legend, never a submit-time error. -->
      <div class="ea__legend">
        <IconRequired class="ea__legend-seal" :size="22" />
        <span>— поля, обязательные для заполнения</span>
      </div>

      <!-- ================= Когда произошло событие ================= -->
      <section class="ea__section">
        <h2 class="velo-section-title">Когда произошло событие</h2>

        <div class="ea__field" data-field="date">
          <button
            type="button"
            class="ea__picker"
            :class="{ 'ea__picker--empty': !date, 'ea__picker--error': !!errors.date }"
            @click="showDate = true"
          >
            {{ date ? dateDisplay : 'Дата' }}
          </button>
          <!-- Seals float in the LAYOUT's right padding (owner 2026-09-10):
               the field spans the full rail, the marker lives in the gutter. -->
          <span class="ea__seal ea__seal--gutter" :class="{ 'ea__seal--done': !!date }">
            <IconRequired v-if="!date" :size="22" />
            <IconRequiredDone v-else :size="22" />
          </span>
          <span v-if="errors.date" class="ea__field-error">{{ errors.date }}</span>
        </div>

        <div class="ea__field" data-field="time">
          <button
            type="button"
            class="ea__picker"
            :class="{
              'ea__picker--empty': !time,
              'ea__picker--error': !!errors.time || !!errors.future,
            }"
            @click="showTime = true"
          >
            {{ time || 'Время' }}
          </button>
          <span class="ea__seal ea__seal--gutter" :class="{ 'ea__seal--done': !!time }">
            <IconRequired v-if="!time" :size="22" />
            <IconRequiredDone v-else :size="22" />
          </span>
          <span v-if="errors.time || errors.future" class="ea__field-error">
            {{ errors.time || errors.future }}
          </span>
        </div>
      </section>

      <!-- ================= Выбор активности ================= -->
      <section class="ea__section">
        <h2 class="velo-section-title">Выбор активности</h2>

        <div class="ea__activity" data-field="activity">
          <span class="ea__seal ea__seal--gutter" :class="{ 'ea__seal--done': activityFilled }">
            <IconRequired v-if="!activityFilled" :size="22" />
            <IconRequiredDone v-else :size="22" />
          </span>
          <div class="ea__chips">
            <VChip
              v-for="opt in ACTIVITY_OPTIONS"
              :key="opt.value"
              class="ea__chip"
              size="md"
              clickable
              :active="selectedActivity === opt.value"
              :aria-pressed="selectedActivity === opt.value"
              @click="selectActivity(opt.value)"
            >
              {{ opt.label }}
            </VChip>
            <!-- The committed custom variant: its OWN text on the board with
                 an × to remove it (owner 2026-09-14: one custom chip at a
                 time -- while it is on the board the input is unavailable;
                 removing the chip brings the input back). -->
            <span v-if="customChip" class="ea__chip ea__chip--custom">
              {{ customChip }}
              <button
                type="button"
                class="ea__chip-remove"
                aria-label="Убрать свой вариант"
                @click="removeCustomChip"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </span>
          </div>

          <div
            class="ea__custom"
            data-field="custom"
            :class="{ 'ea__custom--error': !!errors.custom }"
          >
            <input
              v-model="customInput"
              class="ea__custom-input"
              type="text"
              placeholder="Укажите ваш вариант"
              :maxlength="CUSTOM_NAME_MAX"
              aria-label="Свой вариант активности"
              :disabled="!!customChip"
              @input="onCustomInput"
              @keydown.enter.prevent="commitCustom"
            />
            <button
              type="button"
              class="ea__custom-commit"
              aria-label="Выбрать свой вариант"
              :disabled="!!customChip"
              @click="commitCustom"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M7 17L17 7" />
                <path d="M8 7h9v9" />
              </svg>
            </button>
          </div>
          <span v-if="errors.custom" class="ea__field-error">{{ errors.custom }}</span>
        </div>
        <span v-if="errors.activity" class="ea__field-error">{{ errors.activity }}</span>
      </section>

      <!-- ================= Мое состояние =================
           HIDDEN for now (owner 2026-09-10, flag: EXTERNAL_ACTIVITY_MOOD_HIDDEN
           in utils/constants.ts): the block comes back with its Figma pressed
           states; until then the backend's required mood is submitted as the
           neutral zone centre and the feed card hides the suffix. The
           markup/logic stay in place behind the flag. -->
      <section v-if="!EXTERNAL_ACTIVITY_MOOD_HIDDEN" class="ea__section">
        <h2 class="velo-section-title">Мое состояние</h2>

        <div class="ea__state-block" data-field="state">
          <span
            class="ea__seal ea__seal--gutter"
            :class="{ 'ea__seal--done': stateScore !== null }"
          >
            <IconRequired v-if="stateScore === null" :size="22" />
            <IconRequiredDone v-else :size="22" />
          </span>
          <div class="ea__state" role="group" aria-label="Мое состояние">
            <button
              v-for="opt in STATE_OPTIONS"
              :key="opt.score"
              type="button"
              class="ea__state-btn"
              :class="{ 'ea__state-btn--selected': stateScore === opt.score }"
              :style="{ color: opt.color }"
              :aria-pressed="stateScore === opt.score"
              :aria-label="opt.label"
              @click="selectState(opt.score)"
            >
              <component :is="opt.icon" class="ea__state-icon" :size="56" />
            </button>
          </div>
        </div>
        <span v-if="errors.state" class="ea__field-error">{{ errors.state }}</span>
      </section>

      <!-- ================= Мысли ================= -->
      <section class="ea__section">
        <h2 class="velo-section-title">Мысли</h2>
        <div class="ea__thoughts" data-field="thoughts">
          <VTextarea
            label="Мысли"
            hide-label
            :rows="5"
            :maxlength="THOUGHTS_MAX"
            :error="errors.thoughts"
            :model-value="thoughts"
            :placeholder="THOUGHTS_PLACEHOLDER"
            @update:model-value="onThoughtsInput"
          />
        </div>
      </section>
    </div>

    <!-- Floating glass save pill (owner 2026-09-10): the diary composer's
         Liquid Glass recipe -- an overlay hovering OVER the scrolling body,
         not an in-flow bar. The body reserves bottom clearance, so the pill
         never covers the last field. -->
    <div class="ea__save-wrap">
      <button
        type="button"
        class="ea__save"
        :disabled="diaryStore.externalActivitySubmitting"
        @click="onSubmit"
      >
        <span
          v-if="diaryStore.externalActivitySubmitting"
          class="ea__save-spinner"
          aria-hidden="true"
        />
        <span class="ea__save-label">Сохранить</span>
      </button>
    </div>

    <DatePickerSheet
      :open="showDate"
      :model-value="date"
      :max="todayIso"
      title="Дата события"
      @update:model-value="onDatePicked"
      @close="showDate = false"
    />
    <TimePickerSheet
      :open="showTime"
      :model-value="time"
      title="Время события"
      @update:model-value="onTimePicked"
      @close="showTime = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { DateTime } from 'luxon'
import { VBackButton, VChip, VTextarea } from '@/components/ui'
import {
  IconRequired,
  IconRequiredDone,
  IconRatingConfused,
  IconRatingGood,
  IconRatingFire,
} from '@/components/icons'
import DatePickerSheet from '@/components/shared/DatePickerSheet.vue'
import TimePickerSheet from '@/components/shared/TimePickerSheet.vue'
import { useDiaryStore, type ExternalActivityFieldErrors } from '@/stores/diary'
import { useToast } from '@/composables/useToast'
import { useViewerTimezone } from '@/composables/useViewerTimezone'
import { EXTERNAL_ACTIVITY_MOOD_HIDDEN } from '@/utils/constants'
import { RATING_ICON_COLOR } from '@/utils/displayHelpers'
import { formatShortDate } from '@/utils/format'
import type { ExternalActivityType } from '@/api/types'

const router = useRouter()
const diaryStore = useDiaryStore()
const toast = useToast()
const timezone = useViewerTimezone()

// -- Closed option sets --------------------------------------------------------
// The values ARE the backend enum (generated ExternalActivityType), so the
// "UI key -> backend enum" adapter the task doc planned is this table itself:
// one place to read, nothing to drift.
const ACTIVITY_OPTIONS: ReadonlyArray<{ value: ExternalActivityType; label: string }> = [
  { value: 'vocal', label: 'Вокал' },
  { value: 'nail_standing', label: 'Гвоздестояние' },
  { value: 'meditation', label: 'Медитация' },
  { value: 'massage', label: 'Массаж' },
  { value: 'yoga', label: 'Йога' },
  { value: 'dance', label: 'Танцы' },
]

// The three MoodSlider zone centres (2 / 6 / 9) as plain icon buttons: this
// screen has no track/thumb/zone labels, and the initial value stays null --
// a silently pre-picked «Хорошо» would answer the question for the person.
const STATE_OPTIONS = [
  {
    score: 2 as const,
    label: 'Есть вопросы',
    icon: IconRatingConfused,
    color: RATING_ICON_COLOR.confused,
  },
  {
    score: 6 as const,
    label: 'Хорошо',
    icon: IconRatingGood,
    color: RATING_ICON_COLOR.good,
  },
  {
    score: 9 as const,
    label: 'Огонь',
    icon: IconRatingFire,
    color: RATING_ICON_COLOR.fire,
  },
]

// The «Мое состояние» mood block is currently hidden -- owner decision lives
// in EXTERNAL_ACTIVITY_MOOD_HIDDEN (utils/constants.ts): ONE flag drives the
// form (picker hidden, neutral centre submitted) AND the feed card (the
// «· N/10» suffix suppressed). Flip the constant when the block returns.

// Backend contract caps (CreateExternalActivityRequest): custom name <= 120,
// thoughts <= 10000. Enforced here so a 422 length error is unreachable.
const CUSTOM_NAME_MAX = 120
const THOUGHTS_MAX = 10000
const THOUGHTS_PLACEHOLDER =
  'Напишите, что это было и что с вами произошло. Вы можете вернуться к рефлексии позже'

// -- Draft: everything empty at start (no prefilled now / default state) ------
const date = ref('') // YYYY-MM-DD, the viewer's own calendar
const time = ref('') // HH:mm
const selectedActivity = ref<ExternalActivityType | null>(null)
// The custom text stays an editable draft while typing; the arrow/Enter
// commits it onto the board as a chip (customChip) and clears the draft.
// Preset selection or the chip's × removes the chip.
const customInput = ref('')
// FE-70 owner rule 2026-09-14: the committed custom chip text -- null means
// no custom chip is on the board (the input is available again).
const customChip = ref<string | null>(null)
const stateScore = ref<2 | 6 | 9 | null>(null)
const thoughts = ref('')

const errors = ref({
  date: '',
  time: '',
  future: '',
  activity: '',
  custom: '',
  state: '',
  thoughts: '',
})

const showDate = ref(false)
const showTime = ref(false)
const bodyEl = ref<HTMLElement | null>(null)

// The section is "filled" when any choice exists; a custom choice always
// carries its chip (the chip IS the name), so it is filled by construction.
const activityFilled = computed(() => {
  if (selectedActivity.value === null) return false
  return selectedActivity.value !== 'custom' || customChip.value !== null
})

// Every clock in this screen runs in the PROFILE timezone: a browser-local
// "today" would hand a (+tz) user their own tomorrow as pickable.
const zone = computed(() => timezone.value ?? 'UTC')
const todayIso = computed(() => DateTime.now().setZone(zone.value).toISODate() ?? '')

// Friendly date for the trigger field, e.g. "25 янв. 2026" -- the same recipe
// CreatePracticeView's own date trigger uses.
const dateDisplay = computed((): string =>
  date.value ? `${formatShortDate(`${date.value}T12:00:00`)} ${date.value.slice(0, 4)}` : '',
)

function clearError(key: keyof typeof errors.value): void {
  errors.value[key] = ''
}

function onDatePicked(value: string): void {
  date.value = value
  clearError('date')
  clearError('future')
}

function onTimePicked(value: string): void {
  time.value = value
  clearError('time')
  clearError('future')
}

function selectActivity(value: ExternalActivityType): void {
  selectedActivity.value = value
  // A preset choice replaces the custom chip entirely (single-select board).
  customChip.value = null
  clearError('activity')
  clearError('custom')
}

function onCustomInput(): void {
  if (customInput.value.trim().length > 0) clearError('custom')
}

// Typing alone never selects «custom»: the choice is an explicit commit -- the
// arrow button or Enter on a non-empty value. The commit puts the variant's
// OWN text on the chip board (with its ×), clears the input, and hides the
// input: one custom chip at a time, the next one only after removing it.
function commitCustom(): void {
  const name = customInput.value.trim()
  if (name.length === 0) {
    errors.value.custom = 'Укажите ваш вариант'
    return
  }
  customChip.value = name
  customInput.value = ''
  selectedActivity.value = 'custom'
  clearError('custom')
  clearError('activity')
}

// The chip's ×: removes the custom variant from the board and returns the
// input -- only then can a new custom variant be added.
function removeCustomChip(): void {
  customChip.value = null
  selectedActivity.value = null
  clearError('custom')
  clearError('activity')
}

function selectState(score: 2 | 6 | 9): void {
  stateScore.value = score
  clearError('state')
}

function onThoughtsInput(value: string): void {
  thoughts.value = value
  clearError('thoughts')
}

// Timestamp in the PROFILE timezone (never the browser's), offset-aware --
// exactly what the backend's occurred_at expects.
function occurredAt(): DateTime | null {
  if (!date.value || !time.value) return null
  const ts = DateTime.fromISO(`${date.value}T${time.value}`, { zone: zone.value })
  return ts.isValid ? ts : null
}

// The scroll/focus order of the invalid-submit pass. The future-timestamp
// error rides the time field -- the finer of the two controls to fix.
const FIELD_ORDER = ['date', 'time', 'activity', 'custom', 'state', 'thoughts'] as const

function fieldHasError(key: (typeof FIELD_ORDER)[number]): boolean {
  if (key === 'time') return errors.value.time !== '' || errors.value.future !== ''
  return errors.value[key] !== ''
}

function validate(): boolean {
  errors.value.date = date.value ? '' : 'Выберите дату'
  errors.value.time = time.value ? '' : 'Выберите время'
  errors.value.activity = selectedActivity.value ? '' : 'Выберите активность'
  errors.value.custom =
    selectedActivity.value === 'custom' && customChip.value === null ? 'Укажите ваш вариант' : ''
  // The mood is only askable while its block is on screen; hidden, it owes
  // The mood is only askable while its block is on screen; hidden, it owes
  // no error (the neutral centre travels with the submit instead).
  errors.value.state =
    !EXTERNAL_ACTIVITY_MOOD_HIDDEN && stateScore.value === null ? 'Выберите состояние' : ''
  errors.value.future = ''
  const ts = occurredAt()
  if (ts && ts > DateTime.now()) {
    errors.value.future = 'Событие не может быть в будущем'
  }
  return !FIELD_ORDER.some(fieldHasError)
}

// Invalid submit: every error is set at once, the body scrolls to the first
// one and its control takes focus. The legend stays a legend, the entered
// values survive.
function focusFirstError(): void {
  for (const key of FIELD_ORDER) {
    if (!fieldHasError(key)) continue
    const field = bodyEl.value?.querySelector<HTMLElement>(`[data-field="${key}"]`)
    field?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    field?.querySelector<HTMLElement>('button, input, textarea')?.focus()
    return
  }
}

// Field-attributed 422s bind to their controls -- several at once, because the
// backend answers that way on purpose.
function applyFieldErrors(fieldErrors: ExternalActivityFieldErrors): void {
  if (fieldErrors.occurred_at) errors.value.future = fieldErrors.occurred_at
  if (fieldErrors.custom_activity_name) {
    // The backend refused the name: pull the chip off the board and give the
    // person their text back in the input to edit and re-commit.
    errors.value.custom = fieldErrors.custom_activity_name
    customInput.value = customChip.value ?? ''
    customChip.value = null
    selectedActivity.value = null
  }
  if (fieldErrors.thoughts) errors.value.thoughts = fieldErrors.thoughts
  if (fieldErrors.activity_type) errors.value.activity = fieldErrors.activity_type
  if (fieldErrors.mood) errors.value.state = fieldErrors.mood
  focusFirstError()
}

function goBack(): void {
  // Always the dashboard, never router.back(): a deep link may have no
  // in-app history to return to.
  void router.push({ name: 'user-dashboard' })
}

async function onSubmit(): Promise<void> {
  // Double submit is blocked by the store's re-entrancy guard and by the
  // button's own :loading state -- the second tap changes nothing.
  if (diaryStore.externalActivitySubmitting) return
  if (!validate()) {
    focusFirstError()
    return
  }
  const ts = occurredAt()
  const activity = selectedActivity.value
  if (!ts || activity === null) return
  if (!EXTERNAL_ACTIVITY_MOOD_HIDDEN && stateScore.value === null) return
  const occurredIso = ts.toISO()
  if (occurredIso === null) return

  const result = await diaryStore.submitExternalActivity({
    occurred_at: occurredIso,
    activity_type: activity,
    // The custom name travels only with the custom choice; whitespace-only
    // thoughts become null -- both per the backend contract. While the mood
    // block is hidden the neutral centre (6) travels, per the shared flag.
    custom_activity_name: activity === 'custom' ? customChip.value : null,
    mood: EXTERNAL_ACTIVITY_MOOD_HIDDEN ? 6 : (stateScore.value as 2 | 6 | 9),
    thoughts: thoughts.value.trim() || null,
  })

  if (result.ok) {
    toast.success('Событие добавлено')
    void router.push({ name: 'user-diary' })
    return
  }
  if (result.fieldErrors) {
    applyFieldErrors(result.fieldErrors)
    return
  }
  // Unknown/network failure: stay on the form, keep the draft, one honest
  // toast -- never a success and never a navigation.
  toast.error('Не удалось сохранить событие')
}
</script>

<style scoped>
/* Three-row fill contract (EntryView's): fixed header, scrolling body, fixed
   footer -- «Сохранить» stays at the bottom edge while only the form scrolls.
   Safe-area insets belong to AppFrame; nothing here re-applies them. */
.ea {
  position: relative; /* anchors the floating glass save pill + header */
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  /* Header fog (owner 2026-09-14, «как на главной»): the header floats OVER
     the scroll body and content dissolves beneath it. --ea-fog-top = the
     header's full footprint (top pad + 44px row + bottom pad); the mask holds
     content transparent through --ea-fog-hard, then fades to opaque exactly
     at the header's bottom edge -- same shape as MobileLayout's fog mask. */
  --ea-fog-hard: 40px;
  --ea-fog-top: calc(var(--space-5) + var(--velo-size-44) + var(--space-3));
}

.ea__header {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 2; /* stays crisp above the masked, scrolling body */
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-5) var(--space-8) var(--space-3);
}

.ea__title {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  font-family: var(--font-heading);
  font-size: var(--text-base);
  letter-spacing: 0.36px;
  color: var(--velo-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ea__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  /* Top padding = the header's footprint: at rest the legend starts exactly
     below the fog, scrolled content dissolves into it (MobileLayout's fog
     mask recipe, applied to OUR scroll body -- the shell's fog class is
     fill-incompatible). The bottom step clears the glass pill (50px + one
     gap): the overlay hovers OVER the scroll, the last field stays
     reachable. */
  padding: var(--ea-fog-top) var(--space-8) calc(var(--velo-size-50) + var(--space-5));
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0,
    transparent var(--ea-fog-hard),
    #000 var(--ea-fog-top)
  );
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    transparent var(--ea-fog-hard),
    #000 var(--ea-fog-top)
  );
}

/* Required-fields legend: CreatePracticeView's DS plate (pink glass, rose
   border, 12px radius) -- the shared Banner is too tall for a one-line
   legend. */
.ea__legend {
  display: flex;
  align-items: center;
  gap: var(--velo-banner-gap-icon-text);
  background: var(--velo-glass-pink-40);
  border: 1px solid var(--velo-pink-300);
  border-radius: 12px;
  padding: 10px var(--space-4);
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-pink-700);
}

.ea__legend-seal {
  flex-shrink: 0;
  color: var(--velo-rating-good);
}

.ea__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* -- Date/time trigger fields: CreatePracticeView's picker recipe.
     Fields span the FULL rail; the required seal floats in the LAYOUT's
     right padding (owner 2026-09-10) -- 22px marker centred in the 24px
     gutter outside the field's edge. -- */
.ea__field {
  position: relative;
  display: flex;
  flex-direction: column;
}

.ea__picker {
  width: 100%;
  box-sizing: border-box;
  height: var(--velo-size-40);
  text-align: left;
  padding: 0 var(--space-4);
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  background: var(--velo-bg-card-solid);
  border: 2px solid transparent;
  border-radius: var(--velo-radius-badge);
  cursor: pointer;
}

.ea__picker--empty {
  color: var(--velo-text-muted);
}

.ea__picker--error {
  border-color: var(--velo-error);
}

.ea__seal {
  display: flex;
  color: var(--velo-error);
}

.ea__seal--done {
  color: var(--velo-required-done);
}

.ea__seal--gutter {
  position: absolute;
  right: calc(-1 * var(--space-8) + 1px);
  top: 50%;
  transform: translateY(-50%);
}

.ea__field-error {
  display: block;
  font-size: var(--text-xs);
  color: var(--velo-error);
  margin-top: var(--space-1);
}

/* -- Activity card: solid white plate, chips wrap naturally (no grid) -- */
.ea__activity {
  position: relative; /* anchors its gutter seal */
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  background: var(--velo-bg-card-solid);
  border-radius: var(--radius-md);
  padding: var(--space-3);
}

.ea__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

/* Owner (2026-09-14): chips a touch narrower than the DS md default
   (--space-4 -> --space-3 horizontal padding). Selector carries .ea__chips
   so the override wins the specificity tie with .v-chip--md's own padding;
   applies to selected, unselected and the filled «Свой вариант» alike. */
.ea__chips .ea__chip {
  padding: var(--space-2) var(--space-3);
}

/* Unselected preset chips read blue-on-white (reference); VChip's clickable
   rest state is grey-on-glass, so ONLY the two colours are overridden --
   geometry and the selected state remain VChip's own. The custom chip is
   excluded: it styles itself below. */
.ea__chip:not(.v-chip--active):not(.ea__chip--custom) {
  background: var(--velo-white);
  border-color: var(--velo-primary);
  color: var(--velo-primary);
}

/* The committed custom variant: filled primary pill carrying its OWN text
   and the × that removes it from the board. */
.ea__chip--custom {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  background: var(--velo-primary);
  border: 1px solid var(--velo-primary);
  border-radius: var(--radius-full);
  color: var(--velo-white);
  font-family: var(--font-body);
  font-size: var(--text-xs);
}

.ea__chip-remove {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-full);
  background: rgba(255, 255, 255, 0.25);
  color: var(--velo-white);
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.ea__chip-remove:active {
  opacity: 0.85;
}

.ea__chip-remove:focus-visible {
  outline: 2px solid var(--velo-white);
  outline-offset: 1px;
}

.ea__chip-remove svg {
  width: 10px;
  height: 10px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2.5;
  stroke-linecap: round;
}

/* -- «Свой вариант»: capsule on the white card with the commit disc nested
      into its right cap (the composer's send-disc pattern). Focus follows
      the VInput canon: ONE border that appears on focus (quiet --velo-border
      at rest -> --velo-border-input-focus) plus a soft glass ring -- never a
      second outline frame (owner 2026-09-10). -- */
.ea__custom {
  position: relative;
  display: flex;
  align-items: center;
}

.ea__custom-input {
  flex: 1 1 auto;
  min-width: 0;
  height: var(--velo-size-44);
  /* Right padding reserves the nested disc's seat (36px + breathing). */
  padding: 0 46px 0 var(--space-4);
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  background: transparent;
  border: 1.5px solid var(--velo-border);
  border-radius: var(--radius-full);
  transition:
    border-color var(--transition-base),
    box-shadow var(--transition-base);
}

.ea__custom-input::placeholder {
  color: var(--velo-text-placeholder);
}

/* While the custom chip is on the board the whole row is disabled (owner
   2026-09-14: the input stays VISIBLE, just muted -- one custom chip at a
   time; the chip's × re-enables it). */
.ea__custom-input:disabled,
.ea__custom-commit:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.ea__custom-input:focus {
  outline: none;
  border-color: var(--velo-border-input-focus);
  box-shadow: 0 0 0 3px var(--velo-glass-blue-15);
}

.ea__custom--error .ea__custom-input {
  border-color: var(--velo-error);
}

/* The arrow is a CONTROL, not decoration: it commits the custom choice.
   36px disc nested in the capsule's right cap -- the composer's own
   send-disc size (.composer--single .composer__btn). */
.ea__custom-commit {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--radius-full);
  background: var(--velo-primary);
  color: var(--velo-white);
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.ea__custom-commit:active {
  opacity: 0.85;
}

.ea__custom-commit:focus-visible {
  outline: 2px solid var(--velo-primary);
  outline-offset: 2px;
}

.ea__custom-commit svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* -- «Мое состояние» (currently hidden behind EXTERNAL_ACTIVITY_MOOD_HIDDEN):
       full-rail icon row, gutter seal anchored to the block. -- */
.ea__state-block {
  position: relative;
}

.ea__state {
  display: flex;
  align-items: center;
  justify-content: space-around;
}

.ea__state-btn {
  flex: 0 1 auto;
  min-width: var(--velo-size-44);
  min-height: var(--velo-size-44);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
}

/* Selected: a thin outer halo in the glyph's OWN colour + a slight scale on
   the icon alone -- no glyph recolour (the three colours are semantic) and no
   row-height change. Interim treatment until the Figma pressed state lands. */
.ea__state-btn--selected {
  border-radius: var(--radius-full);
  box-shadow: 0 0 0 2px currentColor;
}

.ea__state-icon {
  transition: transform var(--transition-fast);
}

.ea__state-btn--selected .ea__state-icon {
  transform: scale(1.06);
}

.ea__state-btn:focus-visible {
  outline: 2px solid var(--velo-primary);
  outline-offset: 2px;
  border-radius: var(--radius-full);
}

/* -- «Мысли»: the DS textarea as a solid white plate (its rest state is
      transparent); rows=5 gives the ~120px reference height, text starts
      top-left, resize is already off in the DS. -- */
.ea__thoughts :deep(.v-textarea__field) {
  background: var(--velo-bg-card-solid);
  border-radius: var(--radius-md);
}

/* -- Floating glass save pill (owner 2026-09-10) -----------------------------
   The diary composer's Liquid Glass recipe, verbatim values: an overlay
   hovering OVER the scrolling body (wrap is pointer-transparent; only the
   pill is tappable), rim + inset edge highlights + floating shadow from
   .composer__field, the 20% white frost of the diary's glass BUTTON surface
   (VBackButton) over blur(18) saturate(180), and the composer's refraction
   sheen. translateZ keeps the label's repaints from racing the backdrop
   sampling (the iOS-stable shape for glass over moving content). -- */
.ea__save-wrap {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2; /* above the masked body, like the header */
  display: flex;
  justify-content: center;
  padding: 0 var(--space-8) var(--space-4);
  pointer-events: none;
}

.ea__save {
  pointer-events: auto;
  position: relative;
  width: 100%;
  height: var(--velo-size-50);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: var(--radius-full);
  background: transparent;
  transform: translateZ(0);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.55),
    inset 0 -1px 0 rgba(255, 255, 255, 0.15),
    0 8px 24px rgba(0, 0, 0, 0.08);
  font-family: var(--font-body);
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--velo-text-primary);
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.ea__save::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: rgba(255, 255, 255, 0.2);
  backdrop-filter: blur(18px) saturate(180%);
  -webkit-backdrop-filter: blur(18px) saturate(180%);
  z-index: -1;
}

.ea__save::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  background: linear-gradient(
    135deg,
    rgba(255, 255, 255, 0.35),
    rgba(255, 255, 255, 0.05) 45%,
    rgba(255, 255, 255, 0.18)
  );
  mix-blend-mode: soft-light;
}

.ea__save:active:not(:disabled) {
  opacity: 0.85;
}

.ea__save:focus-visible {
  outline: 2px solid var(--velo-primary);
  outline-offset: 2px;
}

.ea__save:disabled {
  cursor: default;
}

.ea__save-spinner {
  width: 18px;
  height: 18px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: var(--radius-full);
  animation: ea-save-spin 0.7s linear infinite;
}

@keyframes ea-save-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
