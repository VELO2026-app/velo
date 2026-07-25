<!--
  VELO Frontend -- CreatePracticeView (Phase F6.2, fixed W-2, W-6, W-7, W-9)

  Create a new practice. Protected by masterStatusGuard.
  Standalone within MasterShell (back button -> origin via router.back(); see onBack).

  Sections (matching mockup screen-practice-create):
    ОСНОВНОЕ    -- title (required), practice_type (required)
    РАСПИСАНИЕ  -- date, time (combined -> scheduled_at UTC), duration, timezone
    УЧАСТНИКИ   -- max_participants (null = unlimited)
    ЦЕНА        -- is_free toggle; if paid: price_cents
    ОПИСАНИЕ    -- description, what_to_prepare, contraindications (optional)
    ПОДКЛЮЧЕНИЕ -- zoom_link (optional)

  Submit: POST /api/v1/practices (status defaults to 'draft' in backend).
  On success -> show toast + navigate to master-practices + refreshMyPractices().

  Fixes:
    W-2: DURATION_OPTIONS / TIMEZONE_OPTIONS imported from @/utils/practiceOptions
    W-6: priceCents uses eurStringToCents() -- no parseFloat * 100 float trap
    W-7: todayDate is a computed ref -- not stale after midnight
    W-9: commission calc uses COMMISSION_RATE from @/utils/commission

  Timezone handling:
    The date + time inputs are wall-clock values in the timezone the master
    selects (form.timezone). They are converted to a UTC instant with luxon
    (DateTime.fromISO(..., { zone: form.timezone }).toUTC()), so the stored
    scheduled_at is the correct moment regardless of the master's browser
    timezone. Each viewer later sees it rendered in their own timezone.
    (Closes the earlier "F10" simplification that used browser-local time.)
-->

<template>
  <div class="create-practice">
    <!-- Header -->
    <VHeader title="Новая практика" show-back @back="onBack" />

    <div class="create-practice__content">
      <!-- Draft restore prompt (B2): a stored draft is NOT auto-filled — the
           master chooses to restore it or start fresh. -->
      <Banner
        v-if="showDraftBanner"
        variant="info"
        title="Продолжить черновик?"
        class="create-practice__draft-banner"
      >
        <template #body>
          <p class="create-practice__draft-text">У вас есть несохранённый черновик практики.</p>
          <div class="create-practice__draft-actions">
            <VButton variant="secondary" size="sm" @click="restoreDraft">Восстановить</VButton>
            <VButton variant="ghost" size="sm" @click="discardDraft">Начать заново</VButton>
          </div>
        </template>
      </Banner>

      <!-- Required-fields legend (DS banner, Phase-3). -->
      <div class="create-practice__legend">
        <IconRequired class="create-practice__legend-seal" :size="22" />
        <span>— поля, обязательные для заполнения</span>
      </div>

      <!-- ================================================================
           Использовать шаблон — prefill from one of the master's own past
           practices (newest-first). Reuses PracticeListCard rows. Date/time
           are NOT copied (a template must not schedule in the past).
           ================================================================ -->
      <div class="create-practice__section">
        <h2 class="velo-section-title">Использовать шаблон</h2>
        <!-- Full width (NOT railed): the block carries no required-seal of its
             own, so it spans the whole rail — as wide as a field PLUS its seal
             indicator (operator ПРОМТ №233). -->
        <UseTemplateBlock :practices="templatePractices" @select="applyTemplate" />
      </div>

      <!-- ================================================================
           Основное  (Q2=А: 3 поля — Направление / Вид=style / Уровень=difficulty;
           practice_type не показываем, выводим из «Повторения»)
           ================================================================ -->
      <div class="create-practice__section">
        <h2 class="velo-section-title">Основное</h2>

        <VInput v-model="form.title" placeholder="Название" :error="errors.title" required />

        <!-- Направление = дисциплина (meditation/yoga/…). Подпись = плейсхолдер.
             Options catalog-first (T2 stage 2) -- see directionOptions. -->
        <VSelect
          v-model="form.direction"
          placeholder="Направление практики"
          :options="directionOptions"
          :error="errors.direction"
          required
          @update:modelValue="onDirectionChange"
        />

        <!-- Вид практики = style. Показываем только если у направления есть виды
             (Q4=А: без явного «Без вида», не выбрано = null, необязательное). -->
        <div v-if="styleOptionsForForm.length > 0" class="create-practice__railed">
          <VSelect v-model="form.style" placeholder="Вид практики" :options="styleOptionsForForm" />
        </div>

        <!-- Уровень сложности = difficulty (локальные мужские лейблы, Q1=Б). -->
        <VSelect
          v-model="form.difficulty"
          placeholder="Уровень сложности"
          :options="DIFFICULTY_OPTIONS_CREATE"
          :error="errors.difficulty"
          required
        />
      </div>

      <!-- ================================================================
           Расписание
           ================================================================ -->
      <div class="create-practice__section">
        <h2 class="velo-section-title">Расписание</h2>

        <!-- Дата: открывает DatePickerSheet. Подпись = плейсхолдер внутри поля. -->
        <div class="create-practice__field">
          <div class="create-practice__field-row">
            <button
              type="button"
              class="create-practice__picker"
              :class="{
                'create-practice__picker--empty': !form.date,
                'create-practice__picker--error': !!errors.date,
              }"
              @click="showDate = true"
            >
              {{ form.date ? dateDisplay : 'Дата' }}
            </button>
            <span
              class="create-practice__seal"
              :class="{ 'create-practice__seal--done': !!form.date }"
            >
              <IconRequired v-if="!form.date" :size="22" />
              <IconRequiredDone v-else :size="22" />
            </span>
          </div>
          <span v-if="errors.date" class="create-practice__field-error">{{ errors.date }}</span>
        </div>

        <!-- Время: открывает TimePickerSheet (24ч). Подпись = плейсхолдер. -->
        <div class="create-practice__field">
          <div class="create-practice__field-row">
            <button
              type="button"
              class="create-practice__picker"
              :class="{
                'create-practice__picker--empty': !form.time,
                'create-practice__picker--error': !!errors.time,
              }"
              @click="showTime = true"
            >
              {{ form.time || 'Время' }}
            </button>
            <span
              class="create-practice__seal"
              :class="{ 'create-practice__seal--done': !!form.time }"
            >
              <IconRequired v-if="!form.time" :size="22" />
              <IconRequiredDone v-else :size="22" />
            </span>
          </div>
          <span v-if="errors.time" class="create-practice__field-error">{{ errors.time }}</span>
        </div>

        <VSelect
          v-model="form.duration_minutes"
          placeholder="Длительность"
          :options="DURATION_OPTIONS"
          :error="errors.duration_minutes"
          required
        />
        <!-- Часовой пояс убран: берётся из профиля мастера (form.timezone),
             расписание задаётся в его часовом поясе (operator 2026-06-18). -->
      </div>

      <!-- ================================================================
           Повторение  (Q1=А: полная секция — период + дни недели + «Завершить»
           + счётчик. РЕАЛЬНО только series/live из чекбокса-гейта; период/дни/
           условие/счётчик — captured-only (нет бэка), см. master-ds-zod-roadmap.
           Печати обязательности — Q2=В: на полях повтора, когда «регулярная» вкл.)
           ================================================================ -->
      <div class="create-practice__section">
        <h2 class="velo-section-title">Повторение</h2>

        <div class="create-practice__railed">
          <VCard class="create-practice__repeat" padding="none">
            <VCheckbox v-model="form.is_recurring" label="Сделать регулярной" />
          </VCard>
        </div>

        <template v-if="form.is_recurring">
          <!-- Повтор: период (всегда выбрано → печать не нужна). -->
          <div class="create-practice__seal-row">
            <VCard class="create-practice__repeat create-practice__grow" padding="none">
              <div class="create-practice__repeat-title">Повтор:</div>
              <VRadioGroup v-model="form.recurrence" :options="RECURRENCE_OPTIONS" />
            </VCard>
            <span
              class="create-practice__seal-card"
              :class="{ 'create-practice__seal-card--done': !!form.recurrence }"
            >
              <IconRequired v-if="!form.recurrence" :size="22" />
              <IconRequiredDone v-else :size="22" />
            </span>
          </div>

          <!-- Дни недели — ТОЛЬКО для weekly/biweekly. «Каждый день» (daily) не
               использует дни недели, поэтому пикер и его печать обязательности не
               рендерятся вовсе (operator NP-10). Валидация уже пропускает daily. -->
          <template v-if="form.recurrence !== 'daily'">
            <div class="create-practice__seal-row">
              <div class="create-practice__days create-practice__grow">
                <VDayPicker v-model="form.recurrence_days" aria-label="Дни недели для повтора" />
              </div>
              <span
                class="create-practice__seal-card"
                :class="{ 'create-practice__seal-card--done': form.recurrence_days.length > 0 }"
              >
                <IconRequired v-if="!form.recurrence_days.length" :size="22" />
                <IconRequiredDone v-else :size="22" />
              </span>
            </div>
            <span v-if="errors.recurrence_days" class="create-practice__field-error">{{
              errors.recurrence_days
            }}</span>
          </template>

          <!-- Завершить -->
          <div class="create-practice__seal-row">
            <VCard class="create-practice__repeat create-practice__grow" padding="none">
              <div class="create-practice__repeat-title">Завершить:</div>
              <VRadioGroup v-model="form.recurrence_end" :options="RECURRENCE_END_OPTIONS" />

              <!-- Выбрать дату: тот же DatePickerSheet, дата окончания серии (#10). -->
              <button
                v-if="form.recurrence_end === 'until_date'"
                type="button"
                class="create-practice__picker create-practice__end-control"
                :class="{ 'create-practice__picker--empty': !form.recurrence_end_date }"
                @click="showEndDate = true"
              >
                {{ form.recurrence_end_date ? endDateDisplay : 'Дата окончания' }}
              </button>

              <!-- После числа повторений: ручной ввод количества (#11). -->
              <input
                v-else-if="form.recurrence_end === 'after_count'"
                v-model.number="form.recurrence_count"
                type="number"
                inputmode="numeric"
                min="1"
                class="create-practice__end-control create-practice__count-input"
                placeholder="Число повторений"
                @focus="onFieldFocus"
              />
            </VCard>
            <span
              class="create-practice__seal-card"
              :class="{ 'create-practice__seal-card--done': !!form.recurrence_end }"
            >
              <IconRequired v-if="!form.recurrence_end" :size="22" />
              <IconRequiredDone v-else :size="22" />
            </span>
          </div>
          <span v-if="errors.recurrence_end_date" class="create-practice__field-error">{{
            errors.recurrence_end_date
          }}</span>
          <span v-if="errors.recurrence_count" class="create-practice__field-error">{{
            errors.recurrence_count
          }}</span>
        </template>
      </div>

      <!-- ================================================================
           Участники  (опционально → без печати; имя поля = плейсхолдер)
           ================================================================ -->
      <div class="create-practice__section">
        <h2 class="velo-section-title">Участники</h2>

        <div class="create-practice__railed">
          <VInput
            v-model="form.max_participants_raw"
            type="number"
            placeholder="Максимум мест"
            :error="errors.max_participants"
          />
        </div>
      </div>

      <!-- ================================================================
           Для кого практика  (P5, ПРОМТ №594): audience_kind single-select,
           + a multi-select of the master's own custom groups when 'groups'
           is chosen. No SVG mock exists -- MINIMAL DS-language design.
           ================================================================ -->
      <div class="create-practice__section">
        <h2 class="velo-section-title">Для кого практика</h2>

        <div class="create-practice__railed">
          <VCard class="create-practice__repeat" padding="none">
            <VRadioGroup v-model="form.audience_kind" :options="AUDIENCE_OPTIONS" />
          </VCard>

          <template v-if="form.audience_kind === 'groups'">
            <div v-if="customGroups.length" class="create-practice__audience-chips">
              <VChip
                v-for="g in customGroups"
                :key="g.id"
                size="md"
                clickable
                :active="form.audience_group_ids.includes(g.id)"
                @click="onAudienceGroupChipClick(g.id)"
              >
                {{ g.name }}
              </VChip>
            </div>
            <p v-else class="create-practice__audience-empty">
              Пока нет ни одной группы. Создайте группу на экране «Мои группы».
            </p>
            <span v-if="errors.audience_group_ids" class="create-practice__field-error">{{
              errors.audience_group_ids
            }}</span>
          </template>
        </div>
      </div>

      <!-- ================================================================
           Оплата  (платная опция убрана — пока только «Бесплатно», operator
           2026-06-18 Q2=А; «Платно» + цену вернём одной строкой при надобности)
           ================================================================ -->
      <div class="create-practice__section">
        <h2 class="velo-section-title">Оплата</h2>

        <div class="create-practice__railed">
          <VCard class="create-practice__repeat" padding="none">
            <VRadioGroup :model-value="'free'" :options="PAYMENT_OPTIONS" />
          </VCard>
        </div>
      </div>

      <!-- ================================================================
           Описание  (textarea + 2 однострочных; опциональны → без печати)
           ================================================================ -->
      <div class="create-practice__section create-practice__section--desc">
        <h2 class="velo-section-title">Описание</h2>

        <div class="create-practice__railed">
          <VTextarea
            v-model="form.description"
            placeholder="Расскажите подробее о вашей практике"
            :rows="4"
            autogrow
          />
        </div>

        <!-- 1-row start (rows=1) = the VInput height these were before; auto-grow
             past one line per the «Новая практика» SVG (operator Q1=А). -->
        <div class="create-practice__railed">
          <VTextarea
            v-model="form.contraindications"
            placeholder="Противопоказания"
            :rows="1"
            autogrow
          />
        </div>

        <div class="create-practice__railed">
          <VTextarea
            v-model="form.what_to_prepare"
            placeholder="Что подготовить"
            :rows="1"
            autogrow
          />
        </div>
      </div>

      <!-- ================================================================
           Подключение (T21-1, ПРОМТ №541, owner decision D1): the backend
           ALWAYS creates a real Zoom meeting automatically on publish -- this
           field is now an EMERGENCY fallback only (Zoom's daily creation quota
           can fail it), not the primary link. Kept because a master must
           never be left with no way to run the session; the honest label
           says what using it costs.
           ================================================================ -->
      <div class="create-practice__section">
        <h2 class="velo-section-title">Подключение</h2>
        <p class="create-practice__hint">
          Ссылка на Zoom создаётся автоматически. Указывайте свою только как запасной вариант —
          посещение по ней не засчитается автоматически.
        </p>

        <div class="create-practice__railed">
          <VInput
            v-model="form.zoom_link"
            placeholder="Запасная ссылка на Zoom"
            @focus="onFieldFocus"
          />
        </div>
      </div>

      <!-- Submit -->
      <VButton variant="primary" block size="lg" :loading="submitting" @click="submit">
        Создать практику
      </VButton>

      <!-- Picker sheets (teleport to body; open on field tap). -->
      <DatePickerSheet
        :open="showDate"
        :model-value="form.date"
        :min="todayDate"
        @update:model-value="form.date = $event"
        @close="showDate = false"
      />
      <!-- Дата окончания серии (#10): тот же пикер, минимум — дата старта. -->
      <DatePickerSheet
        :open="showEndDate"
        :model-value="form.recurrence_end_date"
        :min="form.date || todayDate"
        title="Дата окончания"
        @update:model-value="form.recurrence_end_date = $event"
        @close="showEndDate = false"
      />
      <TimePickerSheet
        :open="showTime"
        :model-value="form.time"
        @update:model-value="form.time = $event"
        @close="showTime = false"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch, nextTick } from 'vue'
import { DateTime } from 'luxon'
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import {
  VButton,
  VInput,
  VTextarea,
  VSelect,
  VCard,
  VCheckbox,
  VRadioGroup,
  VDayPicker,
  VChip,
} from '@/components/ui'
import { IconRequired, IconRequiredDone } from '@/components/icons'
import { useToast } from '@/composables/useToast'
import { useAuthStore } from '@/stores/auth'
import { useMasterStore } from '@/stores/master'
import { createPractice, updatePractice } from '@/api/practices'
import { getGroups } from '@/api/groups'
import type { GroupListItem } from '@/api/groups'
import { formatShortDate, todayLocalISO } from '@/utils/format'
import DatePickerSheet from '@/components/shared/DatePickerSheet.vue'
import TimePickerSheet from '@/components/shared/TimePickerSheet.vue'
import UseTemplateBlock from '@/components/shared/UseTemplateBlock.vue'
import Banner from '@/components/shared/Banner.vue'
import { ApiResponseError } from '@/api/client'
import { extractApiError } from '@/composables/useApiError'
import {
  DURATION_OPTIONS,
  catalogDirectionOptions,
  catalogStylesForDirection,
} from '@/utils/practiceOptions'
import { ensureTaxonomyCatalog, parseMethods } from '@/utils/methodTaxonomy'
import { useKeyboardFieldScroll } from '@/composables/useKeyboardFieldScroll'
import type { TaxonomyListResponse } from '@/api/taxonomy'
import type { RecurrenceSpec, PracticeResponse, PracticeDirection } from '@/api/types'

const router = useRouter()
const toast = useToast()

// Lift the focused field above the soft keyboard once it settles (shared M5
// composable — replaces the bespoke 300ms scrollFieldIntoView, K3).
const { onFieldFocus } = useKeyboardFieldScroll()

// Back/cancel: return to the real origin. Create opens from BOTH the dashboard
// empty-state CTA and Практики's «+» (goNew) — router.back() lands on whichever
// pushed us here (fixes «back always went to Практики», operator 2026-06-23).
// Deep-link / no history → fall back to the practices list. Submit-success
// navigation (→ master-practices) is unchanged; only this Back button differs.
function onBack(): void {
  if (window.history.state?.back) router.back()
  else router.push({ name: 'master-practices' })
}

const authStore = useAuthStore()
const masterStore = useMasterStore()

// Load the master's practices so «Использовать шаблон» can offer them as
// templates (no-op if already loaded from the practices list / dashboard).
// T2 stage 2 (2026-07-15): prime the taxonomy catalog IN PARALLEL, on entry --
// "close the flash, not just shrink it" (operator). Rides the shared cache
// (ensureTaxonomyCatalog(): zero network call if another screen already
// warmed it this session); if cold, fetched here before the master is likely
// to have opened the Направление select.
const catalog = ref<TaxonomyListResponse | null>(null)
// P5 (ПРОМТ №594): the master's own custom groups (loaded in onMounted below).
const customGroups = ref<GroupListItem[]>([])
onMounted(() => {
  void masterStore.fetchMyPractices()
  void ensureTaxonomyCatalog().then((c) => {
    catalog.value = c
  })
  // T21-6 (ПРОМТ №546): needed to filter the direction/style pickers down to
  // this master's OWN confirmed methods (see directionOptions/
  // styleOptionsForForm below). No-op if already loaded elsewhere this
  // session (fetchMyProfile's own cache, same as fetchMyPractices above).
  void masterStore.fetchMyProfile()
  // P5 (ПРОМТ №594): the master's own custom groups, for «Конкретные
  // группы»'s multi-select. «Удалённые» is a system slug (never a real
  // MasterGroup row) and «Ученики» isn't a target-able group either --
  // getGroups() already returns both alongside custom ones, so filter here.
  void getGroups().then((res) => {
    customGroups.value = res.items.filter((g) => g.kind === 'custom')
  })
})

const submitting = ref(false)

// Date/time picker sheets.
const showDate = ref(false)
const showTime = ref(false)
const showEndDate = ref(false) // «Завершить → Выбрать дату» (#10)

// Friendly date for a trigger field, e.g. "25 янв. 2026".
function friendlyDate(iso: string): string {
  return iso ? `${formatShortDate(`${iso}T12:00:00`)} ${iso.slice(0, 4)}` : ''
}
const dateDisplay = computed((): string => friendlyDate(form.date))
const endDateDisplay = computed((): string => friendlyDate(form.recurrence_end_date))

// -- Recurrence period options (Повторение). The on/off toggle drives
// practice_type (series/live); when on, period/days/end build a RecurrenceSpec
// sent to the series engine (E3). --
const RECURRENCE_OPTIONS = [
  { label: 'Каждый день', value: 'daily' },
  { label: 'Каждую неделю', value: 'weekly' },
  { label: 'Раз в две недели', value: 'biweekly' },
]

// Завершение серии: never / until_date / after_count → RecurrenceSpec.end.
const RECURRENCE_END_OPTIONS = [
  { label: 'Никогда', value: 'never' },
  { label: 'Выбрать дату', value: 'until_date' },
  { label: 'После числа повторений', value: 'after_count' },
]

// «Платно» убрано (operator 2026-06-18 Q2=А) — пока только бесплатные практики.
const PAYMENT_OPTIONS = [{ value: 'free', label: 'Бесплатно' }]

// P5 (ПРОМТ №594): «Для кого практика» -- no SVG mock exists for this
// control, MINIMAL DS-language design (VRadioGroup, same recipe as
// RECURRENCE_OPTIONS/PAYMENT_OPTIONS above -- no new visual component).
const AUDIENCE_OPTIONS = [
  { value: 'public', label: 'Публичная' },
  { value: 'students', label: 'Все ученики' },
  { value: 'groups', label: 'Конкретные группы' },
]

// Named wrapper (B7-hook edge: an inline multi-statement @click handler can
// be reformatted across lines by the pre-commit hook's prettier pass and
// lose its semicolon, breaking the Vue template compiler).
function onAudienceGroupChipClick(groupId: string): void {
  const idx = form.audience_group_ids.indexOf(groupId)
  if (idx === -1) form.audience_group_ids.push(groupId)
  else form.audience_group_ids.splice(idx, 1)
}

// Уровень сложности — локальные мужские лейблы под слово «уровень» (Q1=Б);
// глобальный DIFFICULTY_LABEL (женский род, под «практика») не трогаем.
const DIFFICULTY_OPTIONS_CREATE = [
  { value: 'beginner', label: 'Начальный' },
  { value: 'medium', label: 'Средний' },
  { value: 'high', label: 'Высокий' },
]

// W-7: computed so todayDate is never stale after midnight. Local-time date floor
// (not UTC) so it doesn't drift a day near midnight for east/west-of-UTC users.
const todayDate = computed(() => todayLocalISO())

// -- Form state --
const form = reactive({
  title: '',
  // Selects start empty so the field name shows as the in-field placeholder (#6).
  direction: '',
  difficulty: '',
  style: '',
  // Повторение: is_recurring drives practice_type (series/live); when on,
  // period/days/end-condition/count are sent as a RecurrenceSpec (E3 series
  // engine). recurrence_days holds VDayPicker codes ('mon'..'sun').
  is_recurring: false,
  recurrence: 'weekly' as RecurrenceSpec['period'],
  recurrence_days: [] as string[],
  recurrence_end: 'never' as RecurrenceSpec['end'],
  // Empty until the master types a count (NP-11) — no auto-filled 40.
  recurrence_count: null as number | null,
  recurrence_end_date: '', // ISO 'YYYY-MM-DD' when recurrence_end === 'until_date' (#10)
  date: '',
  time: '',
  duration_minutes: '',
  // Timezone is taken from the master's profile (field removed from the form).
  timezone: authStore.user?.timezone ?? 'Europe/Moscow',
  max_participants_raw: '', // string input, parsed to int|null on submit
  is_free: true, // «Платно» removed — practices are free for now (Q2=А)
  // P5 (ПРОМТ №594): «Для кого практика» — single-select kind, + a
  // multi-select of the master's OWN custom groups when kind='groups'.
  // Default 'public' -- matches every practice's behavior before this
  // feature existed.
  audience_kind: 'public' as 'public' | 'students' | 'groups',
  audience_group_ids: [] as string[],
  description: '',
  what_to_prepare: '',
  contraindications: '',
  // «Подключение» — ручной ввод Zoom-ссылки (Q3=А); пусто → null на submit.
  zoom_link: '',
})

// -- Validation errors --
const errors = reactive({
  title: '',
  direction: '',
  difficulty: '',
  date: '',
  time: '',
  duration_minutes: '',
  max_participants: '',
  // Recurrence end-condition errors (surfaced as field errors, mirroring the
  // weekday-required check): days required, until-date needs a date, after-count
  // needs a positive count. Reset by the Object.keys(errors) loop in validate().
  recurrence_days: '',
  recurrence_end_date: '',
  recurrence_count: '',
  audience_group_ids: '',
})

// «Использовать шаблон» source: all the master's practices, newest-created
// first (operator Q2=А — backend list order isn't guaranteed, so sort here).
//
// T23-3 (ПРОМТ №565): a published SERIES must offer ONE entry, not one per
// generated occurrence -- masterStore.practices carries every child
// individually (each is its own Practice row), so an unrelated series
// otherwise floods this list with N near-identical cards ("Свист" three
// times for three July dates in the owner's report).
//
// Grouped by parent_practice_id (a series child's own group key) falling
// back to the row's own id (a root or a non-series practice is its own
// group of one). Within a group the ROOT (parent_practice_id === null) is
// preferred when present. MEASURED, not assumed: series_service.py's
// _build_child_occurrence copies title, description, what_to_prepare,
// contraindications, duration_minutes, max_participants, zoom_link,
// is_free, price_cents, currency and the full taxonomy (direction,
// difficulty, style) VERBATIM from the root to every child at generation
// time (no per-child override of any of these anywhere in that function) --
// exactly the field set applyTemplate() below actually copies. So which
// occurrence in a group gets offered does not change what a master
// receives; the root is still the deliberate pick because it is guaranteed
// to exist for as long as the series does (a child can be individually
// cancelled/deleted without touching the root) and is the series' own
// canonical definition (the recurrence spec itself lives only on the root,
// series_service.py). Only WHICH entries are offered changes here --
// applyTemplate's copy list is untouched.
const templatePractices = computed((): PracticeResponse[] => {
  const bestForGroup = new Map<string, PracticeResponse>()
  for (const p of masterStore.practices) {
    const groupKey = p.parent_practice_id ?? p.id
    const existing = bestForGroup.get(groupKey)
    if (!existing || (existing.parent_practice_id !== null && p.parent_practice_id === null)) {
      bestForGroup.set(groupKey, p)
    }
  }
  return [...bestForGroup.values()].sort((a, b) => b.created_at.localeCompare(a.created_at))
})

// T21-6 (ПРОМТ №546): this master's OWN CONFIRMED methods (MasterProfile.
// methods -- the live field, only overwritten on admin approval), parsed
// into direction/style VALUES via the same resolver every other screen
// uses. Deliberately reads masterStore.profile?.methods, NEVER
// method_change_request.proposed_methods -- a pending, unapproved request
// must not unlock a direction before the "up to 3 working days" review the
// profile screen itself advertises. null while the profile hasn't loaded.
const confirmedMethods = computed(() => {
  const methods = masterStore.profile?.methods
  if (!methods) return null
  return parseMethods(methods)
})

// ПРОМТ №556 (OWNER-2, MEASURED): this route (master-practice-new) has
// masterStatusGuard on it (router/index.ts), which AWAITS fetchMyProfile()
// before this component ever mounts -- so masterStore.profileLoaded is
// already true on first render in the normal navigation case, and the
// "not loaded yet" branch below is a defensive fallback for an abnormal
// state, not the master line of defense. It must still fail toward
// showing NOTHING, never the full catalogue: the previous version
// returned the FULL unfiltered catalog for both "profile not loaded" and
// "loaded with zero confirmed methods", which is exactly backwards --
// an unknown or empty confirmed-set must never read as "everything is
// allowed". A master with genuinely zero confirmed methods (documented
// elsewhere as unreachable for a real verified master) now sees an empty
// Направление select instead of the full catalogue.
const directionOptions = computed(() => {
  if (!masterStore.profileLoaded) return []
  const confirmed = confirmedMethods.value
  if (!confirmed) return []
  const all = catalogDirectionOptions(catalog.value)
  return all.filter((opt) => confirmed.directions.includes(opt.value))
})

// Direction-conditional style options, same confirmed-methods filter. A
// direction confirmed WITHOUT a specific style (bare "Направление", no " —
// Вид" half) offers NO styles here -- matches the backend's equally strict
// check (practices/service.py's _assert_master_confirmed_taxonomy): picking
// any style under a bare-confirmed direction would be rejected on submit,
// so the picker must not offer it in the first place.
const styleOptionsForForm = computed(() => {
  if (!masterStore.profileLoaded) return []
  const confirmed = confirmedMethods.value
  if (!confirmed) return []
  const all = catalogStylesForDirection(catalog.value, form.direction)
  const confirmedStyleValues = confirmed.styles[form.direction as string] ?? []
  return all.filter((opt) => confirmedStyleValues.includes(opt.value))
})

/** Reset style when direction changes — the previous value is likely
 *  invalid for the new direction. */
function onDirectionChange(): void {
  form.style = ''
}

/**
 * «Использовать шаблон»: prefill the form from one of the master's own past
 * practices. Copies the practice's settings EXCEPT date & time, which stay
 * fresh so a template can't schedule a practice in the past (operator Q1=А).
 * The block collapses itself after selecting.
 */
function applyTemplate(p: PracticeResponse): void {
  // Prefill is NOT itself a user draft (B2): suppress the autosave watch across
  // the assignment, re-enable next tick so the master's own subsequent edits do
  // get saved.
  suppressSave = true
  form.title = p.title
  // ПРОМТ №556 (OWNER-2, MEASURED root cause): a template practice's
  // direction/style were confirmed at the time IT was created -- a master's
  // confirmed methods can have since narrowed (a method-change-request +
  // admin approval overwrites the profile's methods verbatim). Copying the
  // template's direction/style verbatim bypasses directionOptions/
  // styleOptionsForForm entirely (this assignment never goes through those
  // filtered dropdowns), which is exactly how an unconfirmed direction/
  // style could reach submit() and hit the backend's raw rejection. Only
  // copy a value still present in the CURRENT confirmed set; otherwise
  // leave it blank so the master must re-pick from the live, filtered list.
  const confirmed = confirmedMethods.value
  const directionStillConfirmed =
    !!confirmed && !!p.direction && confirmed.directions.includes(p.direction as PracticeDirection)
  const styleStillConfirmed =
    directionStillConfirmed &&
    !!p.style &&
    (confirmed?.styles[p.direction as string] ?? []).includes(p.style)
  form.direction = directionStillConfirmed ? (p.direction ?? '') : ''
  form.style = styleStillConfirmed ? (p.style ?? '') : ''
  form.difficulty = p.difficulty ?? ''
  form.duration_minutes = String(p.duration_minutes)
  form.max_participants_raw = p.max_participants != null ? String(p.max_participants) : ''
  form.description = p.description ?? ''
  form.what_to_prepare = p.what_to_prepare ?? ''
  form.contraindications = p.contraindications ?? ''
  // date & time intentionally NOT copied.
  void nextTick(() => {
    suppressSave = false
  })
}

// -- Draft autosave (L1 / B2) ------------------------------------------------
// Debounced localStorage draft so a half-filled «Новая практика» survives an
// accidental navigation-away. Scoped per user. NOT auto-restored: on mount a
// meaningful draft surfaces a «Продолжить черновик?» banner (restore / start
// fresh). Cleared on successful submit + on «Начать заново».
const DRAFT_KEY = computed(() => `velo:create-practice-draft:${authStore.user?.id ?? 'anon'}`)

type DraftShape = Record<string, unknown>

// A draft is worth restoring only when the master actually started composing
// (some field beyond the empty defaults) — a bare open shouldn't nag next visit.
function isMeaningfulDraft(d: DraftShape | null): boolean {
  if (!d) return false
  const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  return Boolean(
    s(d.title) ||
    d.direction ||
    d.difficulty ||
    d.style ||
    d.date ||
    d.time ||
    d.duration_minutes ||
    s(d.max_participants_raw) ||
    s(d.description) ||
    s(d.what_to_prepare) ||
    s(d.contraindications) ||
    s(d.zoom_link) ||
    d.is_recurring,
  )
}

const showDraftBanner = ref(false)
let pendingDraft: DraftShape | null = null

// Gates the autosave watch so a template prefill / restore isn't re-persisted as
// a fresh draft — only genuine user edits are.
let suppressSave = false
let saveTimer: ReturnType<typeof setTimeout> | undefined

function scheduleSave(): void {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(DRAFT_KEY.value, JSON.stringify(form))
    } catch {
      // storage full / disabled — a lost draft is non-fatal.
    }
  }, 500)
}

function clearDraft(): void {
  clearTimeout(saveTimer)
  try {
    localStorage.removeItem(DRAFT_KEY.value)
  } catch {
    // ignore
  }
}

watch(
  form,
  () => {
    if (suppressSave) return
    scheduleSave()
  },
  { deep: true },
)

function restoreDraft(): void {
  if (pendingDraft) {
    suppressSave = true
    Object.assign(form, pendingDraft)
    void nextTick(() => {
      suppressSave = false
    })
  }
  showDraftBanner.value = false
  pendingDraft = null
}

function discardDraft(): void {
  clearDraft()
  showDraftBanner.value = false
  pendingDraft = null
}

onMounted(() => {
  try {
    const raw = localStorage.getItem(DRAFT_KEY.value)
    if (!raw) return
    const parsed = JSON.parse(raw) as DraftShape
    if (isMeaningfulDraft(parsed)) {
      pendingDraft = parsed
      showDraftBanner.value = true
    } else {
      clearDraft()
    }
  } catch {
    // malformed draft — drop it.
    clearDraft()
  }
})

// -- Validation --
function validate(): boolean {
  let ok = true

  // Reset all errors
  Object.keys(errors).forEach((k) => {
    errors[k as keyof typeof errors] = ''
  })

  if (!form.title.trim()) {
    errors.title = 'Введите название'
    ok = false
  }
  if (!form.direction) {
    errors.direction = 'Выберите направление'
    ok = false
  }
  if (!form.difficulty) {
    errors.difficulty = 'Выберите сложность'
    ok = false
  }
  if (!form.date) {
    errors.date = 'Выберите дату'
    ok = false
  }
  if (!form.time) {
    errors.time = 'Выберите время'
    ok = false
  }
  // Ensure scheduled_at is in the future, interpreted in the SELECTED
  // timezone (not the browser's): a master in one tz scheduling for another
  // must be validated against the wall-clock time they actually picked.
  if (form.date && form.time) {
    const dt = DateTime.fromISO(`${form.date}T${form.time}`, {
      zone: form.timezone,
    })
    if (!dt.isValid || dt.toMillis() <= Date.now()) {
      errors.date = 'Дата должна быть в будущем'
      ok = false
    }
  }
  if (!form.duration_minutes) {
    errors.duration_minutes = 'Выберите длительность'
    ok = false
  }
  if (form.max_participants_raw) {
    const n = parseInt(form.max_participants_raw, 10)
    if (isNaN(n) || n < 1) {
      errors.max_participants = 'Введите положительное число или оставьте пустым'
      ok = false
    }
  }
  // Weekly / biweekly series require at least one weekday (the day picker shows
  // a required-seal when empty). Daily ignores days. Block an invalid spec.
  if (form.is_recurring && form.recurrence !== 'daily' && form.recurrence_days.length === 0) {
    errors.recurrence_days = 'Выберите хотя бы один день недели'
    ok = false
  }
  // End = «выбрать дату» needs a chosen date, else until_date submits null → 422
  // with no field feedback.
  if (form.is_recurring && form.recurrence_end === 'until_date' && !form.recurrence_end_date) {
    errors.recurrence_end_date = 'Выберите дату окончания'
    ok = false
  }
  // End = «после числа повторений» needs a positive count; a cleared input binds
  // to '' (HTML min doesn't block submit) → count '' → 422 with no feedback.
  if (
    form.is_recurring &&
    form.recurrence_end === 'after_count' &&
    (!form.recurrence_count || form.recurrence_count < 1)
  ) {
    errors.recurrence_count = 'Укажите число повторений (не меньше 1)'
    ok = false
  }
  // P5 (ПРОМТ №594): «Конкретные группы» needs at least one group chosen --
  // matches the backend's own group_ids-non-empty-when-groups check.
  if (form.audience_kind === 'groups' && form.audience_group_ids.length === 0) {
    errors.audience_group_ids = 'Выберите хотя бы одну группу'
    ok = false
  }
  return ok
}

// VDayPicker emits day codes ('mon'..'sun'); RecurrenceSpec.days needs ISO
// weekday ints (1=Mon..7=Sun). VDayPicker already emits in Mon→Sun order.
const WEEKDAY_ISO: Record<string, number> = {
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  sun: 7,
}

/** Build the RecurrenceSpec from the captured form (only when is_recurring). */
function buildRecurrence(): RecurrenceSpec {
  const spec: RecurrenceSpec = {
    period: form.recurrence,
    end: form.recurrence_end,
  }
  // Daily ignores days; weekly/biweekly send the selected ISO weekdays.
  if (form.recurrence !== 'daily') {
    spec.days = form.recurrence_days.map((d) => WEEKDAY_ISO[d]).filter((n) => n != null)
  }
  if (form.recurrence_end === 'after_count') {
    if (form.recurrence_count != null) spec.count = form.recurrence_count
  } else if (form.recurrence_end === 'until_date') {
    spec.until_date = form.recurrence_end_date || null
  }
  return spec
}

// -- Submit --
// FP-04: double-submit guard must come before validate() --
// parallel clicks both pass validate() before guard fires.
async function submit(): Promise<void> {
  if (submitting.value) return
  if (!validate()) return
  submitting.value = true

  try {
    // Build the UTC instant from the wall-clock date + time, interpreted in
    // the timezone the master selected (form.timezone). luxon handles DST and
    // offsets; the stored scheduled_at is then correct for every viewer's tz.
    const scheduledDt = DateTime.fromISO(`${form.date}T${form.time}`, {
      zone: form.timezone,
    })
    const scheduledAt = scheduledDt.toUTC().toISO()
    if (!scheduledAt) {
      // Should not happen (validate() already checked date/time), but toISO()
      // is typed string | null, so guard instead of sending a bad value.
      toast.error('Некорректные дата или время')
      submitting.value = false
      return
    }

    const created = await createPractice({
      // Q2=А: practice_type derived from the recurrence toggle (series/live);
      // one_on_one/replay are not creatable from this form (roadmap: advanced mode).
      practice_type: form.is_recurring ? 'series' : 'live',
      direction: form.direction,
      difficulty: form.difficulty,
      style: form.style.trim() || null,
      title: form.title.trim(),
      description: form.description.trim() || null,
      what_to_prepare: form.what_to_prepare.trim() || null,
      contraindications: form.contraindications.trim() || null,
      scheduled_at: scheduledAt,
      duration_minutes: parseInt(form.duration_minutes, 10),
      timezone: form.timezone,
      max_participants: form.max_participants_raw ? parseInt(form.max_participants_raw, 10) : null,
      // «Подключение» — ручная Zoom-ссылка; пусто → null (бэк сгенерит, → Зоду).
      zoom_link: form.zoom_link.trim() || null,
      is_free: form.is_free,
      price_cents: 0,
      currency: 'eur',
      // E3: when recurring, send the series spec; non-recurring → null.
      recurrence: form.is_recurring ? buildRecurrence() : null,
      // P5 (ПРОМТ №594): audience_kind + group_ids (only meaningful --
      // and only sent -- for 'groups').
      audience_kind: form.audience_kind,
      group_ids: form.audience_kind === 'groups' ? form.audience_group_ids : [],
    })

    // A4 V6 (ПРОМТ №572): `deduplicated` is the EXPLICIT backend signal that
    // `created` is the master's own EARLIER submission (the window-scoped
    // retry-after-timeout check, ПРОМТ №559, or the losing side of a
    // genuine concurrent double-tap, A4 V7) -- not a new practice. Before
    // this field existed, the form said "Практика создана!" and navigated
    // to the list regardless, so a master who double-tapped had no way to
    // learn that only ONE practice/series exists, not two. Skips the
    // publish PATCH entirely (the existing practice's own status is
    // whatever it already is -- forcing 'scheduled' on it here would be
    // this form silently changing a practice it did not create) and takes
    // the master straight to that existing practice instead of the list.
    // Draft cleared here too (this exact submission already exists, so
    // there is nothing left for it to resurrect into) -- same drop as the
    // normal path below, just earlier, since there is no publish step
    // left that could still fail and need the draft preserved for a retry.
    if (created.deduplicated) {
      suppressSave = true
      clearDraft()
      toast.info('Вы уже создавали эту практику — открываем существующую')
      router.replace({ name: 'master-practice-detail', params: { id: created.id } })
      void masterStore.refreshMyPractices().catch(() => {})
      return
    }

    // Publish immediately: a freshly created practice must be live & bookable,
    // not a draft that needs a second edit→«Опубликовать» step (operator
    // 2026-06-17). The backend create defaults to 'draft'; we run the same
    // draft→scheduled PATCH the edit screen uses, so the practice appears on the
    // dashboard «Ближайшая практика» (scheduled/live only) right away.
    if (created.status !== 'scheduled') {
      await updatePractice(created.id, { status: 'scheduled' })
    }

    // Draft fulfilled — drop it (and block any late debounced save) so it can't
    // resurrect on the next create. Runs only AFTER a successful publish: if
    // the PATCH above throws, control never reaches here and the draft
    // survives for a retry (see the catch block's failed-publish test).
    suppressSave = true
    clearDraft()

    toast.success('Практика создана!')
    // Redirect to the master's practices list — it defaults to the «Предстоящие»
    // (upcoming) tab, and the practice we just published is status='scheduled', so
    // it lands there. replace() (not push) so «назад» returns to the origin
    // (practices / dashboard), not back onto this filled form (#1). Navigate
    // BEFORE the refresh so a failing refresh can never divert to catch and strand
    // the user on the form still showing «Практика создана!» (G1).
    router.replace({ name: 'master-practices' })
    // Invalidate the cached list so it reloads with the new practice. Fire-and-
    // forget + swallow: master-practices loads its own list on mount, so a missed
    // refresh is harmless and must not turn a successful create into an error path.
    void masterStore.refreshMyPractices().catch(() => {})
  } catch (e) {
    // ПРОМТ №556 (OWNER-2): _assert_master_confirmed_taxonomy's rejection is a
    // raw, English, API-shaped message (e.detail) -- must never reach a human
    // directly. Same pattern as MasterInviteClaimView's invite_invalid: switch
    // on the machine-readable code, not the message text.
    if (e instanceof ApiResponseError && e.code === 'direction_not_confirmed') {
      toast.error('Это направление ещё не подтверждено в вашем профиле')
    } else if (e instanceof ApiResponseError && e.code === 'style_not_confirmed') {
      toast.error('Этот вид практики ещё не подтверждён в вашем профиле')
    } else {
      toast.error(extractApiError(e, 'Не удалось создать практику'))
    }
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.create-practice {
  min-height: 100%;
  background: transparent;
  display: flex;
  flex-direction: column;
  /* Seal-gutter = the reserved right column that VInput/VSelect `required`, the
     date/time pickers and the recurrence seal-rows already inset their field by
     (gap --space-2 + the 22px IconRequired). No-seal blocks reserve the SAME
     gutter (.create-practice__railed) so every form block aligns to one rail
     width — sealed and no-seal identical (NP-12/NP-3b). */
  --cp-seal-gutter: calc(var(--space-2) + 22px);
}

/* No-seal blocks (use-template / make-recurring / participants / payment /
   description / contraindications / what-to-prepare / connection / вид практики)
   inset their right edge by the seal gutter so their width matches the sealed
   fields above (operator NP-12/NP-3b: seal & no-seal blocks identical width). */
.create-practice__railed {
  margin-right: var(--cp-seal-gutter);
}

.create-practice__content {
  flex: 1;
  /* F-5 rail sync: ride MobileLayout's 24px rail (no local h-padding). Top
     trimmed so the floating header sits closer to the first field (#1, port
     from the edit form). */
  padding: var(--space-2) 0 var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

/* -- Section -- */
.create-practice__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* «Описание» section: the textareas are spaced by the section gap alone — drop
   their own margin-bottom so Описание / Противопоказания / Что подготовить sit
   tight (one step, not the doubled gap + margin) (operator CP-A1). */
.create-practice__section--desc :deep(.v-textarea) {
  margin-bottom: 0;
}

/* T21-1 (ПРОМТ №541): honest caption for the now-fallback Zoom field. */
.create-practice__hint {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  line-height: 1.4;
}

/* Required-fields legend banner (DS, Phase-3) — pink glass plate, rose seal. */
.create-practice__legend {
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

.create-practice__legend-seal {
  flex-shrink: 0;
  color: var(--velo-rating-good);
}

/* -- Draft-restore banner (B2) -- */
.create-practice__draft-text {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  line-height: 1.4;
}

.create-practice__draft-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

/* Повторение cards (white plates). */
.create-practice__repeat {
  padding: var(--space-3) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.create-practice__repeat-title {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}

/* -- Date/time picker trigger field (mirrors the white VInput plate) -- */
.create-practice__field {
  margin-bottom: var(--space-4);
}

.create-practice__field-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.create-practice__picker {
  flex: 1;
  min-width: 0;
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

.create-practice__picker--empty {
  color: var(--velo-text-muted);
}

.create-practice__picker--error {
  border-color: var(--velo-error);
}

.create-practice__seal {
  flex-shrink: 0;
  display: flex;
  color: var(--velo-error);
}

.create-practice__seal--done {
  color: var(--velo-required-done);
}

.create-practice__field-error {
  display: block;
  font-size: var(--text-xs);
  color: var(--velo-error);
  margin-top: var(--space-1);
}

/* -- Для кого практика (P5, ПРОМТ №594): group multi-select chips, same
   token recipe as AddToGroupSheet's .add-to-group__chips/__empty. -- */
.create-practice__audience-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.create-practice__audience-empty {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-muted);
  margin: var(--space-3) 0 0;
}

/* -- Повторение: карточка повтора (grow) + печать обязательности справа (Q2=В). -- */
.create-practice__seal-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}

.create-practice__grow {
  flex: 1;
  min-width: 0;
}

.create-practice__seal-card {
  flex-shrink: 0;
  display: flex;
  color: var(--velo-error);
  margin-top: var(--space-2);
}

.create-practice__seal-card--done {
  color: var(--velo-required-done);
}

/* -- Дни недели: карточка-обёртка для DS-примитива VDayPicker. -- */
.create-practice__days {
  background: var(--velo-bg-card-solid);
  border-radius: var(--radius-md);
  padding: var(--velo-card-padding-y) var(--space-3);
}

/* -- «После числа повторений»: счётчик-пилюля (captured-only). -- */
/* «Завершить» sub-control (end date button / repeat-count input) — sits below
   the radios; needs a visible edge on the white card. */
.create-practice__end-control {
  margin-top: var(--space-3);
  /* This trigger reuses .create-practice__picker (flex: 1), but here it sits in a
     flex-COLUMN card, where flex-basis:0% would collapse its height:40px to the
     text line («Дата окончания» squished). flex:0 0 auto restores the 40px; the
     date/time row keeps flex:1 (correct there — grows width in a flex row). */
  flex: 0 0 auto;
}

.create-practice__end-control.create-practice__picker {
  border-color: var(--velo-border);
}

.create-practice__count-input {
  width: 160px;
  height: var(--velo-size-40);
  padding: 0 var(--space-4);
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  background: var(--velo-bg-card-solid);
  border: 2px solid var(--velo-border);
  border-radius: var(--velo-radius-badge);
}

.create-practice__count-input:focus {
  outline: none;
  border-color: var(--velo-border-input-focus);
}

.create-practice__count-input::placeholder {
  color: var(--velo-text-muted);
}
</style>
