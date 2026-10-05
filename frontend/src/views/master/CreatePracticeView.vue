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

  T-35: the ПОДКЛЮЧЕНИЕ section is GONE. There is no manual Zoom link to
  enter any more -- attendance was never recorded for anyone who joined
  through one, so it was a second way past the very thing the Zoom
  integration exists to measure. If meeting creation fails, the answer is the
  retry (master dashboard / practice screen), not a link that breaks
  attendance.

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

      <!-- Required-fields legend: HIDDEN for now (owner 2026-10-01) -- the
           section-title asterisk reads without an explanation. Restore the
           block below when an explanation is needed again. -->
      <!--
      <div class="create-practice__legend">
        <span class="cp-req">*</span>
        <span>— разделы с обязательными полями</span>
      </div>
      -->

      <!-- ================================================================
           Мастер (§1.6 delegation, FE-92): whose practice this is. The
           master-card entry preselects one master; the school-page entry
           picks among that school's visible masters, «Я» first. Both need
           the school (?groupId=): the backend creates for another master
           only IN a school, for a master of that school (BE-102). No school
           -> the caller owns the practice and this section does not render.
           ================================================================ -->
      <div v-if="delegatedMaster || masterOptions.length > 1" class="create-practice__section">
        <h2 class="velo-section-title">Мастер</h2>
        <div>
          <VCard class="create-practice__repeat" padding="none">
            <div v-if="delegatedMaster" class="create-practice__repeat-title">
              {{ delegatedMaster.name }}
            </div>
            <VRadioGroup v-else v-model="selectedMasterId" :options="masterOptions" />
          </VCard>
        </div>
      </div>

      <!-- ================================================================
           FE-92 follow-up: hidden while a curator targets ANOTHER master --
           the templates are the CALLER's practices (masterStore.myPractices),
           and the curator has no list of the master's. Fields a template
           filled before the switch stay: they are the curator's input now.
           Использовать шаблон — prefill from one of the master's own past
           practices (newest-first). Reuses PracticeListCard rows. Date/time
           are NOT copied (a template must not schedule in the past).
           ================================================================ -->
      <div v-if="!targetsForeignMaster" class="create-practice__section">
        <h2 class="velo-section-title">Использовать шаблон</h2>
        <!-- Full-width block: no required-seal of its own, so it spans the
             whole rail like every field (owner 2026-10-01 seal canon). -->
        <UseTemplateBlock :practices="templatePractices" @select="applyTemplate" />
      </div>

      <!-- ================================================================
           Основное  (Q2=А: 3 поля — Направление / Вид=style / Уровень=difficulty;
           practice_type не показываем, выводим из «Повторения»)
           ================================================================ -->
      <div class="create-practice__section">
        <h2 class="velo-section-title">Основное <span class="cp-req">*</span></h2>

        <VInput v-model="form.title" placeholder="Название" :error="errors.title" />
        <span
          class="create-practice__field-error"
          :class="{ 'create-practice__field-error--show': !!errors.title }"
          >{{ errors.title }}</span
        >

        <!-- Направление = дисциплина (meditation/yoga/…). Подпись = плейсхолдер.
             Options catalog-first (T2 stage 2) -- see directionOptions. -->
        <VSelect
          v-model="form.direction"
          placeholder="Направление практики"
          :options="directionOptions"
          :error="errors.direction"
          @update:modelValue="onDirectionChange"
        />
        <span
          class="create-practice__field-error"
          :class="{ 'create-practice__field-error--show': !!errors.direction }"
          >{{ errors.direction }}</span
        >

        <!-- Вид практики = style. Показываем только если у направления есть виды
             (Q4=А: без явного «Без вида», не выбрано = null, необязательное). -->
        <div v-if="styleOptionsForForm.length > 0">
          <VSelect v-model="form.style" placeholder="Вид практики" :options="styleOptionsForForm" />
          <!-- Rhythm reserve (owner 2026-10-05): style never errors (optional),
               but every other plate in a section is followed by the constant
               17px error slot — without it «Вид практики» sat 2px off
               «Уровень сложности» while all other input-to-input gaps were
               slot + 2px. -->
          <span class="create-practice__field-error" aria-hidden="true"></span>
        </div>

        <!-- Уровень сложности = difficulty (локальные мужские лейблы, Q1=Б). -->
        <VSelect
          v-model="form.difficulty"
          placeholder="Уровень сложности"
          :options="DIFFICULTY_OPTIONS_CREATE"
          :error="errors.difficulty"
        />
        <span
          class="create-practice__field-error"
          :class="{ 'create-practice__field-error--show': !!errors.difficulty }"
          >{{ errors.difficulty }}</span
        >
      </div>

      <!-- ================================================================
           Расписание
           ================================================================ -->
      <div class="create-practice__section">
        <h2 class="velo-section-title">Расписание <span class="cp-req">*</span></h2>

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
          </div>
          <span
            class="create-practice__field-error"
            :class="{ 'create-practice__field-error--show': !!errors.date }"
            >{{ errors.date }}</span
          >
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
          </div>
          <span
            class="create-practice__field-error"
            :class="{ 'create-practice__field-error--show': !!errors.time }"
            >{{ errors.time }}</span
          >
        </div>

        <VSelect
          v-model="form.duration_minutes"
          placeholder="Длительность"
          :options="DURATION_OPTIONS"
          :error="errors.duration_minutes"
        />
        <span
          class="create-practice__field-error"
          :class="{ 'create-practice__field-error--show': !!errors.duration_minutes }"
          >{{ errors.duration_minutes }}</span
        >
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

        <div>
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
          </div>

          <!-- Дни недели — ТОЛЬКО для weekly/biweekly. «Каждый день» (daily) не
               использует дни недели, поэтому пикер не рендерится вовсе
               (operator NP-10). Валидация уже пропускает daily. -->
          <template v-if="form.recurrence !== 'daily'">
            <div class="create-practice__seal-row">
              <div class="create-practice__days create-practice__grow">
                <VDayPicker v-model="form.recurrence_days" aria-label="Дни недели для повтора" />
              </div>
            </div>
            <span
              class="create-practice__field-error"
              :class="{ 'create-practice__field-error--show': !!errors.recurrence_days }"
              >{{ errors.recurrence_days }}</span
            >
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
                aria-label="Число повторений"
                @focus="onFieldFocus"
              />
            </VCard>
          </div>
          <!-- Only the ACTIVE completion mode reserves an error line. -->
          <span
            v-if="form.recurrence_end === 'until_date'"
            class="create-practice__field-error"
            :class="{ 'create-practice__field-error--show': !!errors.recurrence_end_date }"
            >{{ errors.recurrence_end_date }}</span
          >
          <span
            v-else-if="form.recurrence_end === 'after_count'"
            class="create-practice__field-error"
            :class="{ 'create-practice__field-error--show': !!errors.recurrence_count }"
            >{{ errors.recurrence_count }}</span
          >
        </template>
      </div>

      <!-- ================================================================
           Участники  (опционально → без печати; имя поля = плейсхолдер)
           ================================================================ -->
      <div class="create-practice__section">
        <h2 class="velo-section-title">Участники</h2>

        <div>
          <VInput
            v-model="form.max_participants_raw"
            type="number"
            placeholder="Максимум мест"
            :error="errors.max_participants"
          />
          <span
            class="create-practice__field-error"
            :class="{ 'create-practice__field-error--show': !!errors.max_participants }"
            >{{ errors.max_participants }}</span
          >
        </div>
      </div>

      <!-- ================================================================
           Для кого практика  (P5, PROMPT №594; FE-24: the shared
           PracticeAudiencePicker -- kinds radio + target chips for BOTH
           targeted kinds): student groups and schools. No SVG mock exists --
           MINIMAL DS-language design.
           ================================================================ -->
      <div class="create-practice__section">
        <h2 class="velo-section-title">Для кого практика</h2>

        <div>
          <VCard class="create-practice__repeat" padding="none">
            <PracticeAudiencePicker
              v-model:kind="form.audience_kind"
              v-model:group-ids="form.audience_group_ids"
              v-model:curator-group-id="form.audience_curator_group_id"
              :groups="customGroups"
              :schools="audienceSchools"
              :allowed-kinds="contextGroupId ? SCHOOL_AUDIENCE_KINDS : undefined"
              :error="errors.audience_group_ids"
              students-label="Все мои ученики"
            />
          </VCard>
        </div>
      </div>

      <!-- ================================================================
           Оплата  (платная опция убрана — пока только «Бесплатно», operator
           2026-06-18 Q2=А; «Платно» + цену вернём одной строкой при надобности)
           ================================================================ -->
      <div class="create-practice__section">
        <h2 class="velo-section-title">Оплата</h2>

        <div>
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

        <div>
          <VTextarea
            v-model="form.description"
            placeholder="Расскажите подробее о вашей практике"
            :rows="4"
            autogrow
          />
        </div>

        <!-- 1-row start (rows=1) = the VInput height these were before; auto-grow
             past one line per the «Новая практика» SVG (operator Q1=А). -->
        <div>
          <VTextarea
            v-model="form.contraindications"
            placeholder="Противопоказания"
            :rows="1"
            autogrow
          />
        </div>

        <div>
          <VTextarea
            v-model="form.what_to_prepare"
            placeholder="Что подготовить"
            :rows="1"
            autogrow
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
import { historyHasBack } from '@/platform/history'
import { queryDocument } from '@/platform/dom'
import { ref, reactive, computed, onMounted, watch, nextTick } from 'vue'
import { DateTime } from 'luxon'
import { useRouter, useRoute } from 'vue-router'
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
} from '@/components/ui'
import { useToast } from '@/composables/useToast'
import { useAuthStore } from '@/stores/auth'
import { useMasterStore } from '@/stores/master'
import { createPractice, updatePractice } from '@/api/practices'
import { getGroups } from '@/api/groups'
import { getMyCuratorGroups, getCuratorGroupMembers } from '@/api/curatorGroups'
import { getPublicMaster } from '@/api/masters'
import type { GroupListItem } from '@/api/groups'
import type { CuratorGroupMemberItem } from '@/api/types'
import PracticeAudiencePicker from '@/components/shared/PracticeAudiencePicker.vue'
import type { AudienceSchoolOption } from '@/components/shared/practiceAudience'
import { formatShortDate, todayLocalISO } from '@/utils/format'
import DatePickerSheet from '@/components/shared/DatePickerSheet.vue'
import TimePickerSheet from '@/components/shared/TimePickerSheet.vue'
import UseTemplateBlock from '@/components/shared/UseTemplateBlock.vue'
import Banner from '@/components/shared/Banner.vue'
import { ApiResponseError } from '@/api/client'
import { errorMessage, extractApiError } from '@/composables/useApiError'
import {
  DURATION_OPTIONS,
  catalogDirectionOptions,
  catalogStylesForDirection,
} from '@/utils/practiceOptions'
import { ensureTaxonomyCatalog, parseMethods } from '@/utils/methodTaxonomy'
import { useKeyboardFieldScroll } from '@/composables/useKeyboardFieldScroll'
import type { TaxonomyListResponse } from '@/api/taxonomy'
import type {
  RecurrenceSpec,
  PracticeResponse,
  PracticeDirection,
  PracticeAudienceKind,
} from '@/api/types'

const router = useRouter()
const route = useRoute()
const toast = useToast()

// §1.6 delegation: whose practice is being created. `masterId` in the query
// (the master's public page CTA) names the master; `groupId` (the school
// page CTA) offers that school's visible masters with «Я» first. No query
// context -> the caller owns the practice, the historical behavior.
//
// FE-92 (BE-102): a curator creates a practice FOR a master of a school --
// POST /practices with master_id AND curator_group_id; the backend accepts
// it only in that school, for a verified master of it, from its curator,
// and the practice is born PUBLISHED there (owner, 3 October) -- one
// «created and published» notice to the master, no second publish step.
// Without the school in the context (?groupId=) another master is
// never offered: the request would be refused (master_id_requires_school).
// The audience kinds are the school's two (public / curator_groups --
// check_school_audience) for the WHOLE school entry, «Я» included (owner
// 2026-10-05) — the personal kinds («Все мои ученики» / «Конкретные
// группы») are offered only by a no-context create.
const contextGroupId = computed(() => queryParam('groupId'))
const delegatedMaster = ref<{ id: string; name: string } | null>(null)
const schoolMasterOptions = ref<{ label: string; value: string }[]>([])
const selectedMasterId = ref('')

// The TARGET master's confirmed methods (BE-102): the direction/style pickers
// must offer what the MASTER holds, not the caller's -- the backend validates
// direction/style against the practice's master (_assert_master_confirmed_
// taxonomy, own=False), so offering a method the caller holds but the master
// does not is exactly the late 400 (direction_not_confirmed) this delegation
// used to produce. Source: GET /masters/{id}'s public methods. The fixed
// delegation (?masterId) rides the name lookup this screen already makes; the
// school-picker flow fetches on selection. null = not loaded (or the load
// failed) -- confirmedMethods then fails CLOSED (no options), never the full
// catalogue: the same posture as a not-yet-loaded own profile.
const delegatedMethods = ref<string[] | null>(null)
const delegatedMethodsLoadId = ref(0)

// Owner 2026-10-05 (renamed from FOREIGN_AUDIENCE_KINDS): the set is the
// SCHOOL's, offered on the school entry regardless of the master picked.
const SCHOOL_AUDIENCE_KINDS: PracticeAudienceKind[] = ['public', 'curator_groups']

const targetMasterId = computed(() => delegatedMaster.value?.id ?? (selectedMasterId.value || null))
const targetsForeignMaster = computed(
  () => contextGroupId.value !== '' && targetMasterId.value !== null,
)

// The school list the picker offers: while targeting a foreign master, ONLY
// the context school (the practice belongs to it); otherwise every eligible.
const audienceSchools = computed((): AudienceSchoolOption[] => {
  if (!targetsForeignMaster.value) return eligibleSchools.value
  const own = eligibleSchools.value.find((s) => s.id === contextGroupId.value)
  return [own ?? { id: contextGroupId.value, name: 'Школа' }]
})

watch(targetsForeignMaster, (foreign) => {
  if (!foreign) return
  if (!SCHOOL_AUDIENCE_KINDS.includes(form.audience_kind)) form.audience_kind = 'public'
  if (form.audience_kind === 'curator_groups') {
    form.audience_curator_group_id = contextGroupId.value
  }
})

const masterOptions = computed(() => [{ label: 'Я', value: '' }, ...schoolMasterOptions.value])

function queryParam(key: string): string {
  const value = route.query[key]
  return typeof value === 'string' ? value : ''
}

async function loadPracticeMasterContext(): Promise<void> {
  const masterId = queryParam('masterId')
  const groupId = queryParam('groupId')
  // FE-92: a master named without the school cannot be created for -- no
  // «Мастер» section, the practice is the caller's own.
  if (masterId && groupId) {
    try {
      const profile = await getPublicMaster(masterId)
      delegatedMaster.value = {
        id: masterId,
        name: profile.display_name ?? 'Мастер',
      }
      // The same lookup feeds the pickers: without it they would filter by
      // the CALLER's confirmed set while the backend validates the master's.
      delegatedMethods.value = profile.methods ?? null
    } catch {
      // Keep the id: the backend re-validates the delegation on submit, so
      // a cosmetic name lookup failure must not silently drop the target.
      delegatedMaster.value = { id: masterId, name: 'Мастер' }
      // The methods half is not cosmetic: without it the direction picker
      // stays empty (fail-closed), so say why instead of a silent dead form.
      toast.error('Не удалось загрузить методы мастера')
    }
    return
  }
  if (groupId) {
    try {
      const page = await getCuratorGroupMembers(groupId, { kind: 'master' })
      schoolMasterOptions.value = page.items
        .filter((m: CuratorGroupMemberItem) => m.is_visible && m.user_id !== authStore.user?.id)
        .map((m: CuratorGroupMemberItem) => ({
          label: m.name,
          value: m.user_id,
        }))
    } catch {
      // Picker falls back to «Я» alone -- the caller can still create.
      schoolMasterOptions.value = []
    }
  }
}

// The school-picker flow: a foreign master's methods arrive when he is
// picked, drop when the caller returns to «Я». The loadId makes an
// out-of-order pair of replies land only if they belong to the CURRENTLY
// selected master (the same race discipline as the screen's list fetches).
async function loadDelegatedMethods(masterId: string): Promise<void> {
  const loadId = ++delegatedMethodsLoadId.value
  try {
    const profile = await getPublicMaster(masterId)
    if (loadId === delegatedMethodsLoadId.value) delegatedMethods.value = profile.methods ?? null
  } catch {
    if (loadId === delegatedMethodsLoadId.value) {
      delegatedMethods.value = null
      // Fail-closed: the direction picker stays empty until a re-pick
      // reloads it.
      toast.error('Не удалось загрузить методы мастера')
    }
  }
}

watch(selectedMasterId, (id) => {
  delegatedMethods.value = null
  if (id) void loadDelegatedMethods(id)
  else delegatedMethodsLoadId.value += 1 // drop any in-flight reply
})

// T24-24 (PROMPT №639): "Все ученики" -> "Все мои ученики", on THIS screen
// ONLY -- passed to the shared PracticeAudiencePicker as `students-label`.
// practiceOptions.ts's shared label stays byte-identical for Edit (the
// mapped copy that used to live here is the picker's concern now).

// Lift the focused field above the soft keyboard once it settles (shared M5
// composable — replaces the bespoke 300ms scrollFieldIntoView, K3).
const { onFieldFocus } = useKeyboardFieldScroll()

// Back/cancel: return to the real origin. Create opens from BOTH the dashboard
// empty-state CTA and Практики's «+» (goNew) — router.back() lands on whichever
// pushed us here (fixes «back always went to Практики», operator 2026-06-23).
// Deep-link / no history → fall back to the practices list. Submit-success
// navigation (→ master-practices) is unchanged; only this Back button differs.
function onBack(): void {
  if (historyHasBack()) router.back()
  else void router.push({ name: 'master-practices' })
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
// P5 (PROMPT №594): the master's own custom groups (loaded in onMounted below).
const customGroups = ref<GroupListItem[]>([])
// FE-24 (GT P5): schools this master may target (relation curator or master
// -- the two the backend validates curator_group_id against). Loaded from
// /curator-groups/mine; empty for a master in no school, which simply keeps
// the fourth audience option out of the radio.
const eligibleSchools = ref<AudienceSchoolOption[]>([])
onMounted(() => {
  void masterStore.fetchMyPractices()
  void loadPracticeMasterContext()
  void ensureTaxonomyCatalog().then((c) => {
    catalog.value = c
  })
  // T21-6 (PROMPT №546): needed to filter the direction/style pickers down to
  // this master's OWN confirmed methods (see directionOptions/
  // styleOptionsForForm below). No-op if already loaded elsewhere this
  // session (fetchMyProfile's own cache, same as fetchMyPractices above).
  void masterStore.fetchMyProfile()
  // P5 (PROMPT №594): the master's own custom groups, for «Конкретные
  // группы»'s multi-select. «Удалённые» is a system slug (never a real
  // MasterGroup row) and «Ученики» isn't a target-able group either --
  // getGroups() already returns both alongside custom ones, so filter here.
  void getGroups()
    .then((res) => {
      customGroups.value = res.items.filter((g) => g.kind === 'custom')
    })
    .catch(() => {
      // Surface the failure instead of leaving customGroups empty, which
      // renders as "you have no groups yet" and blocks the groups-audience
      // path for a master who actually has groups. (Also avoids an
      // unhandled promise rejection.)
      toast.error('Не удалось загрузить группы')
    })
  // FE-24 (GT P5): the eligible schools. A failure here degrades to "no
  // schools" (the fourth option stays hidden) -- honest, same discipline as
  // the groups catch above but quieter: there is no screen to point at from
  // a practice form, and the toast would claim a list the user never opened.
  void getMyCuratorGroups()
    .then((res) => {
      eligibleSchools.value = res.items
        .filter((g) => g.relation === 'curator' || g.relation === 'master')
        .map((g) => ({ id: g.id, name: g.name }))
    })
    .catch(() => {
      eligibleSchools.value = []
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
  // Load-bearing assertions: without them reactive widens the literals to
  // string and the typed consumers below (payload/guards) stop compiling.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  recurrence: 'weekly' as RecurrenceSpec['period'],
  recurrence_days: [],
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
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
  // P5 (PROMPT №594): «Для кого практика» — single-select kind, + a
  // multi-select of the master's OWN custom groups when kind='groups'.
  // Default 'public' -- matches every practice's behavior before this
  // feature existed.
  // GT-11: the union comes from the CONTRACT (PracticeAudienceKind is a
  // re-export of generated.ts's AudienceKind), never hand-typed here. The
  // hand-typed triple this replaced is exactly what broke EditPracticeView's
  // build the day the backend added the fourth value ('curator_groups') --
  // AUDIENCE_OPTIONS (practiceOptions.ts) still lists three until FE-24
  // ports the selector, but the TYPE no longer lies about what can come back.
  // Load-bearing assertion (see recurrence above).
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  audience_kind: 'public' as PracticeAudienceKind,
  audience_group_ids: [],
  // BE-74: the ONE school the practice will belong to (a practice belongs to
  // exactly one school, and it cannot be changed after creation) -- sent
  // ONLY when audience_kind === 'curator_groups'; null otherwise. The
  // backend refuses a school next to 'students'/'groups' (400), and this
  // screen offers no "public practice of a school" (owner Q2).
  audience_curator_group_id: null as string | null,
  description: '',
  what_to_prepare: '',
  contraindications: '',
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
// T23-3 (PROMPT №565): a published SERIES must offer ONE entry, not one per
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
// contraindications, duration_minutes, max_participants,
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

// T21-6 (PROMPT №546): this master's OWN CONFIRMED methods (MasterProfile.
// methods -- the live field, only overwritten on admin approval), parsed
// into direction/style VALUES via the same resolver every other screen
// uses. Deliberately reads masterStore.profile?.methods, NEVER
// method_change_request.proposed_methods -- a pending, unapproved request
// must not unlock a direction before the "up to 3 working days" review the
// profile screen itself advertises. null while the profile hasn't loaded.
//
// FE-92/BE-102 delegation: while a foreign master is targeted the practice
// is HIS -- the backend validates direction/style against the TARGET
// master's confirmed set (_assert_master_confirmed_taxonomy, own=False), so
// the pickers must offer HIS methods, not the caller's: offering a method
// the caller holds but the master does not is exactly the submit-time 400
// (direction_not_confirmed / style_not_confirmed) this filter exists to
// prevent, and hiding a direction the master himself holds would block a
// create the backend would accept. delegatedMethods null until loaded ->
// confirmedMethods null -> the options below fail CLOSED, never open into
// the full catalogue.
const confirmedMethods = computed(() => {
  const methods = targetsForeignMaster.value ? delegatedMethods.value : masterStore.profile?.methods
  if (!methods) return null
  return parseMethods(methods)
})

// PROMPT №556 (OWNER-2, MEASURED): this route (master-practice-new) has
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
  const confirmedStyleValues = confirmed.styles[form.direction] ?? []
  return all.filter((opt) => confirmedStyleValues.includes(opt.value))
})

// A change of whose methods the pickers offer must not silently keep a pick
// the new set refuses -- the backend would reject exactly that on submit
// (the refusal the filter exists to prevent). Same rule as applyTemplate's
// template copy (PROMPT №556): a still-confirmed pick survives, anything
// else is cleared so the caller re-picks from the live, filtered list. The
// watcher also fires on the curator's own profile load, where the form is
// still empty and this is a no-op.
watch(confirmedMethods, (confirmed) => {
  if (!confirmed) return
  if (form.direction && !confirmed.directions.includes(form.direction as PracticeDirection)) {
    form.direction = ''
    form.style = ''
  } else if (form.style && !(confirmed.styles[form.direction] ?? []).includes(form.style)) {
    form.style = ''
  }
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
  // PROMPT №556 (OWNER-2, MEASURED root cause): a template practice's
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
  // P5 (PROMPT №594): «Конкретные группы» needs at least one group chosen --
  // matches the backend's own group_ids-non-empty-when-groups check.
  if (form.audience_kind === 'groups' && form.audience_group_ids.length === 0) {
    errors.audience_group_ids = 'Выберите хотя бы одну группу'
    ok = false
  }
  // FE-24 (GT P5) / BE-74: the mirror check for schools -- curator_group_id
  // is required when the kind is 'curator_groups' (same backend rule).
  if (form.audience_kind === 'curator_groups' && form.audience_curator_group_id === null) {
    errors.audience_group_ids = 'Выберите школу'
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
  if (!validate()) {
    // The first invalid field may sit far above the submit button on this
    // long form -- bring it into view instead of a silent dead click.
    await nextTick()
    queryDocument(
      '.v-input--error, .v-select--error, .create-practice__picker--error, .create-practice__field-error--show',
    )?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    return
  }
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
      is_free: form.is_free,
      price_cents: 0,
      currency: 'eur',
      // E3: when recurring, send the series spec; non-recurring → null.
      recurrence: form.is_recurring ? buildRecurrence() : null,
      // P5 (PROMPT №594) / FE-24 (GT P5) / BE-74: audience_kind + the target
      // the chosen kind reads. group_ids is sent as an empty array for any
      // other kind; curator_group_id is null for any other kind.
      audience_kind: form.audience_kind,
      group_ids: form.audience_kind === 'groups' ? form.audience_group_ids : [],
      // FE-92: for another master the school is ALWAYS sent (the practice
      // belongs to it, with either of its two audiences), plus master_id.
      curator_group_id: targetsForeignMaster.value
        ? contextGroupId.value
        : form.audience_kind === 'curator_groups'
          ? form.audience_curator_group_id
          : null,
      ...(targetsForeignMaster.value ? { master_id: targetMasterId.value } : {}),
    })

    // A4 V6 (PROMPT №572): `deduplicated` is the EXPLICIT backend signal that
    // `created` is the master's own EARLIER submission (the window-scoped
    // retry-after-timeout check, PROMPT №559, or the losing side of a
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
    // FE-92 / BE-102 publish (owner, 3 October): the backend creates the
    // master's practice ALREADY PUBLISHED, in the same request (Zoom, the
    // school's announcement, one message to the master). The front sends no
    // second request -- nothing left to publish -- and goes back to the
    // school: the curator has no screen of another master's practice. A
    // dedup here is that master's existing practice for the same slot.
    if (targetsForeignMaster.value) {
      suppressSave = true
      clearDraft()
      if (created.deduplicated) toast.info('Такая практика уже есть у мастера')
      else toast.success('Практика опубликована — мастер получит уведомление')
      void router.replace({ name: 'master-curator-group', params: { id: contextGroupId.value } })
      return
    }

    if (created.deduplicated) {
      suppressSave = true
      clearDraft()
      toast.info('Вы уже создавали эту практику — открываем существующую')
      void router.replace({ name: 'master-practice-detail', params: { id: created.id } })
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
    void router.replace({ name: 'master-practices' })
    // Invalidate the cached list so it reloads with the new practice. Fire-and-
    // forget + swallow: master-practices loads its own list on mount, so a missed
    // refresh is harmless and must not turn a successful create into an error path.
    void masterStore.refreshMyPractices().catch(() => {})
  } catch (e) {
    // PROMPT №556 (OWNER-2): _assert_master_confirmed_taxonomy's rejection is a
    // raw, English, API-shaped message (e.detail) -- must never reach a human
    // directly. Same pattern as MasterInviteClaimView's invite_invalid: switch
    // on the machine-readable code, not the message text.
    // B8 (PROMPT №746): both phrases now live in errorMessages.ts.
    if (e instanceof ApiResponseError && e.code === 'direction_not_confirmed') {
      toast.error(errorMessage('direction_not_confirmed'))
    } else if (e instanceof ApiResponseError && e.code === 'style_not_confirmed') {
      toast.error(errorMessage('style_not_confirmed'))
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
  /* Required canon (owner 2026-10-01): fields span the FULL rail width;
     the required marker is the red * on the section headings (.cp-req).
     VInput/VSelect keep their global margin/gutter rhythm disabled on this
     screen via :deep below. */
}

/* [FE-43] Same recipe as MasterGroupCreateView (FE-45 follow-up): while
   typing, the scroll region (.velo-kbd-scroll main) shrinks to the visible
   area -- this form's min-height:100% column used to compress with it, so
   focusing the participants-count field reshuffled the whole layout
   ("экран дёргается"). Keep the column at its AT-REST height instead:
   fields stay exactly where they were, the below-the-fold part waits under
   the keyboard (reachable by scrolling main), and the open -> close -> open
   cycle has nothing to recompute -- no jump in either direction. Inert at
   rest (the class is absent). */
html.is-keyboard-open .create-practice {
  min-height: var(--velo-frozen-vh, 100lvh);
}

/* Section-title required marker (owner 2026-10-01): sections holding
   required fields carry a red * in their heading; the per-field rosettes
   are gone from this screen (the DS components keep them elsewhere). */
.cp-req {
  color: var(--velo-error);
}

/* DS components carry margin-bottom: 16px on their roots (their own form
   rhythm). This screen spaces fields through the 2px section gap + the
   error slot, so the hint sits right under the plate like the date/time
   pickers. The desc section re-adds 8px for its stacked textareas below. */
.create-practice :deep(.v-input),
.create-practice :deep(.v-select),
.create-practice :deep(.v-textarea) {
  margin-bottom: 0;
}

.create-practice__content {
  flex: 1;
  /* F-5 rail sync: ride MobileLayout's 24px rail (no local h-padding). Top
     trimmed so the floating header sits closer to the first field (#1, port
     from the edit form). */
  padding: var(--space-2) 0 var(--space-4);
  display: flex;
  flex-direction: column;
  /* Minimal acceptable section rhythm (owner 2026-10-01: «расстояния
     огромные») -- 16px between sections. */
  gap: var(--space-4);
}

/* -- Section -- */
.create-practice__section {
  display: flex;
  flex-direction: column;
  /* Minimal input-to-input distance (owner 2026-10-01): the error slot
     (17px) + 2px IS the whole gap between consecutive inputs. Everything
     that is not an input (headings, banners, card stacks) compensates with
     its own margin below. */
  gap: 2px;
}

.create-practice__section > .velo-section-title {
  margin-bottom: 6px;
}

/* Non-input blocks after a plate need the breathing the 2px input gap
   cannot give (master-section warning banner, ...). */
.cp-gap-top {
  margin-top: 6px;
}

/* «Описание» section: the textareas are spaced by the section gap alone — drop
   their own margin-bottom so Описание / Противопоказания / Что подготовить sit
   tight (one step, not the doubled gap + margin) (operator CP-A1). */
.create-practice__section--desc :deep(.v-textarea) {
  margin-bottom: 8px;
}

/* T21-1 (PROMPT №541): honest caption for the now-fallback Zoom field. */
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
  gap: var(--space-2);
}

.create-practice__repeat-title {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}

/* -- Date/time picker trigger field (mirrors the white VInput plate) -- */
.create-practice__field {
  margin-bottom: 0;
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

/* Error slots are CONSTANT-height (owner 2026-10-01): the message fades in
   without growing its block -- activating an error must never shift the
   layout below. The DS components' own error lines are hidden (their red
   borders still mark the field); this screen renders the message in the
   reserved slot instead. 14px x 1.2 = 16.8px fits the 17px reserve: the
   shown state is pixel-identical to the empty one. */
.create-practice__field-error {
  display: block;
  min-height: 17px;
  margin-top: 0;
  font-size: var(--text-xs);
  line-height: 1.2;
  color: var(--velo-error);
  opacity: 0;
}

.create-practice__field-error--show {
  opacity: 1;
}

.create-practice :deep(.v-input__error),
.create-practice :deep(.v-select__error) {
  display: none;
}

/* -- Для кого практика (P5, PROMPT №594): group multi-select chips, same
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

/* -- Повторение: ряды карточек (карточка/дни занимают всю ширину). -- */
.create-practice__seal-row {
  display: flex;
  align-items: flex-start;
}

/* Stacked plates (repeat card / days / end) need breathing the 2px section
   gap cannot give them. */
.create-practice__seal-row + .create-practice__seal-row {
  margin-top: 6px;
}

.create-practice__grow {
  flex: 1;
  min-width: 0;
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

/* [FE-25] Readable placeholder token (same contract as VInput/VTextarea). */
.create-practice__count-input::placeholder {
  color: var(--velo-text-placeholder);
}
</style>
