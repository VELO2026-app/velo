<!--
  VELO Frontend -- CreatePracticeView (Phase F6.2, fixed W-2, W-6, W-7, W-9)

  Create a new practice. Protected by masterStatusGuard.
  Standalone within MasterShell (back button -> origin via router.back(); see onBack).

  Sections (matching mockup screen-practice-create):
    BASICS      -- title (required), practice_type (required)
    SCHEDULE    -- date, time (combined -> scheduled_at UTC), duration, timezone
    PARTICIPANTS -- max_participants (null = unlimited)
    PRICE       -- is_free toggle; if paid: price_cents
    DESCRIPTION -- description, what_to_prepare, contraindications (optional)

  T-35: the CONNECTION section is GONE. There is no manual Zoom link to
  enter any more -- attendance was never recorded for anyone who joined
  through one, so it was a second way past the very thing the Zoom
  integration exists to measure. If meeting creation fails, the answer is the
  retry (master dashboard / practice screen), not a link that breaks
  attendance.

  Submit: POST /api/v1/practices (status defaults to 'draft' in backend).
  On success -> show toast + navigate to master-practices + refreshMyPractices().

  Fixes:
    W-2: DURATION_OPTIONS / TIMEZONE_OPTIONS imported from @/utils/practiceOptions
    W-9: commission calc uses COMMISSION_RATE from @/utils/commission

  FE-157 (stage 4, 4A): the form model, its validation and the POST body
  live in composables/usePracticeForm.ts (shared with EditPracticeView); the
  direction/style pickers in usePracticeTaxonomyOptions.ts; the draft in
  useFormDraft.ts; the date/time plates are PracticeSchedulePicker.

  Timezone handling:
    The date + time inputs are wall-clock values in the timezone the master
    selects (form.timezone). They are converted to a UTC instant with luxon
    in the form's zone (usePracticeForm toScheduledAt), so the stored
    scheduled_at is the correct moment regardless of the master's browser
    timezone. Each viewer later sees it rendered in their own timezone.
    (Closes the earlier "F10" simplification that used browser-local time.)
-->

<template>
  <div class="create-practice">
    <!-- Header -->
    <VHeader :title="t('masterScreens.createPractice.title')" show-back @back="onBack" />

    <div class="create-practice__content">
      <!-- Draft restore prompt (B2): a stored draft is NOT auto-filled — the
           master chooses to restore it or start fresh. -->
      <Banner
        v-if="showDraftBanner"
        variant="info"
        :title="t('masterScreens.createPractice.draft.resumeConfirm')"
        class="create-practice__draft-banner"
      >
        <template #body>
          <p class="create-practice__draft-text">
            {{ t('masterScreens.createPractice.draft.resumeText') }}
          </p>
          <div class="create-practice__draft-actions">
            <VButton variant="secondary" size="sm" @click="restoreDraft">{{
              t('masterScreens.createPractice.draft.restore')
            }}</VButton>
            <VButton variant="ghost" size="sm" @click="discardDraft">{{
              t('masterScreens.createPractice.draft.startOver')
            }}</VButton>
          </div>
        </template>
      </Banner>

      <!-- Required-fields legend: HIDDEN for now (owner 2026-10-01) -- the
           section-title asterisk reads without an explanation. Restore the
           block below when an explanation is needed again. -->
      <!--
      <div class="create-practice__legend">
        <span class="cp-req">*</span>
        <span>— {{ t('masterScreens.createPractice.legendSections') }}</span>
      </div>
      -->

      <!-- ================================================================
           Master (§1.6 delegation, FE-92): whose practice this is. The
           master-card entry preselects one master; the school-page entry
           picks among that school's visible masters, the self option
           (i18n:masterScreens.createPractice.audience.me) first. Both need
           the school (?schoolId=): the backend creates for another master
           only IN a school, for a master of that school (BE-102). No school
           -> the caller owns the practice and this section does not render.
           ================================================================ -->
      <div v-if="delegatedMaster || masterOptions.length > 1" class="create-practice__section">
        <h2 class="velo-section-title">{{ t('masterScreens.createPractice.fields.master') }}</h2>
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
           Use template (i18n:masterScreens.createPractice.useTemplate) —
           prefill from one of the master's own past practices (newest-first).
           Reuses PracticeListCard rows. Date/time
           are NOT copied (a template must not schedule in the past).
           ================================================================ -->
      <div v-if="!targetsForeignMaster" class="create-practice__section">
        <h2 class="velo-section-title">{{ t('masterScreens.createPractice.useTemplate') }}</h2>
        <!-- Full-width block: no required-seal of its own, so it spans the
             whole rail like every field (owner 2026-10-01 seal canon). -->
        <UseTemplateBlock :practices="templatePractices" @select="applyTemplate" />
      </div>

      <!-- ================================================================
           Basics (Q2=A: 3 fields — direction / style / difficulty;
           practice_type is not shown, it is derived from the recurrence
           toggle)
           ================================================================ -->
      <div class="create-practice__section">
        <h2 class="velo-section-title">
          {{ t('masterScreens.createPractice.sections.basics') }}<span class="cp-req">*</span>
        </h2>

        <VInput
          v-model="form.title"
          :placeholder="t('masterScreens.createPractice.titlePlaceholder')"
          :error="errors.title"
        />

        <!-- Direction = discipline (meditation/yoga/…). The field label is
             the in-field placeholder.
             Options catalog-first (T2 stage 2) -- see directionOptions. -->
        <VSelect
          v-model="form.direction"
          :placeholder="t('masterScreens.createPractice.fields.direction')"
          :options="directionOptions"
          :error="errors.direction"
          @update:modelValue="onDirectionChange"
        />

        <!-- Practice style = style. Shown only when the direction has styles
             (Q4=A: no explicit "no style" option, unselected = null, optional). -->
        <div v-if="styleOptions.length > 0">
          <VSelect
            v-model="form.style"
            :placeholder="t('masterScreens.createPractice.stylePlaceholder')"
            :options="styleOptions"
          />
        </div>

        <!-- Difficulty = difficulty (local masculine-gender labels, Q1=B). -->
        <VSelect
          v-model="form.difficulty"
          :placeholder="t('masterScreens.createPractice.fields.difficulty')"
          :options="DIFFICULTY_OPTIONS_CREATE"
          :error="errors.difficulty"
        />
      </div>

      <!-- ================================================================
           Schedule
           ================================================================ -->
      <div class="create-practice__section">
        <h2 class="velo-section-title">
          {{ t('masterScreens.createPractice.sections.schedule') }}<span class="cp-req">*</span>
        </h2>

        <!-- Date (i18n:ui.pickerDate) and time (i18n:ui.pickerTime, 24h):
             the field name is the in-field placeholder. -->
        <PracticeSchedulePicker
          v-model="form.date"
          kind="date"
          :placeholder="t('ui.pickerDate')"
          :error="errors.date"
          error-id="err-date"
        />
        <PracticeSchedulePicker
          v-model="form.time"
          kind="time"
          :placeholder="t('ui.pickerTime')"
          :error="errors.time"
          error-id="err-time"
        />

        <VSelect
          v-model="form.duration_minutes"
          :placeholder="t('masterScreens.createPractice.fields.duration')"
          :options="DURATION_OPTIONS"
          :error="errors.duration_minutes"
        />
        <!-- Timezone removed: taken from the master's profile (form.timezone),
             the schedule is set in the master's own timezone (operator
             2026-06-18). -->
      </div>

      <!-- ================================================================
           Recurrence (Q1=A: the full section — period + weekdays + finish
           + count. Only the series/live checkbox gate is REAL; period/days/
           end-condition/count are captured-only (no backend yet), see
           master-ds-zod-roadmap. Required seals — Q2=V: on the recurrence
           fields while the recurring toggle (i18n:masterScreens.createPractice.recurring.toggle)
           is on.)
           ================================================================ -->
      <div class="create-practice__section">
        <h2 class="velo-section-title">
          {{ t('masterScreens.createPractice.sections.recurrence') }}
        </h2>

        <div>
          <VCard class="create-practice__repeat" padding="none">
            <VCheckbox
              v-model="form.is_recurring"
              :label="t('masterScreens.createPractice.recurring.toggle')"
            />
          </VCard>
        </div>

        <template v-if="form.is_recurring">
          <!-- Repeat period (always selected → no required seal). -->
          <div class="create-practice__seal-row">
            <VCard class="create-practice__repeat create-practice__grow" padding="none">
              <div class="create-practice__repeat-title">
                {{ t('masterScreens.createPractice.labels.repeat') }}
              </div>
              <VRadioGroup v-model="form.recurrence" :options="RECURRENCE_OPTIONS" />
            </VCard>
          </div>

          <!-- Weekdays — ONLY for weekly/biweekly. The every-day (daily)
               option uses no weekdays, so the picker is not rendered at all
               (operator NP-10). Validation already lets daily through. -->
          <template v-if="form.recurrence !== 'daily'">
            <div class="create-practice__seal-row">
              <div class="create-practice__days create-practice__grow">
                <VDayPicker
                  v-model="form.recurrence_days"
                  :aria-label="t('masterScreens.createPractice.recurring.daysAria')"
                />
              </div>
            </div>
            <VFieldError id="err-days" :message="errors.recurrence_days" />
          </template>

          <!-- Finish -->
          <div class="create-practice__seal-row">
            <VCard class="create-practice__repeat create-practice__grow" padding="none">
              <div class="create-practice__repeat-title">
                {{ t('masterScreens.createPractice.labels.finish') }}
              </div>
              <VRadioGroup v-model="form.recurrence_end" :options="RECURRENCE_END_OPTIONS" />

              <!-- Pick a date: the series end date (#10), never before the
                   start date (today while no start is picked). -->
              <PracticeSchedulePicker
                v-if="form.recurrence_end === 'until_date'"
                v-model="form.recurrence_end_date"
                kind="date"
                class="create-practice__end-control"
                outlined
                :min="form.date"
                :placeholder="t('masterScreens.createPractice.pickers.endDate')"
                :title="t('masterScreens.createPractice.fields.endDate')"
              />

              <!-- After N repeats: manual count input (#11). -->
              <input
                v-else-if="form.recurrence_end === 'after_count'"
                v-model.number="form.recurrence_count"
                type="number"
                inputmode="numeric"
                min="1"
                class="create-practice__end-control create-practice__count-input"
                :placeholder="t('masterScreens.createPractice.fields.repeatCount')"
                :aria-label="t('masterScreens.createPractice.fields.repeatCount')"
                @focus="onFieldFocus"
              />
            </VCard>
          </div>
          <!-- Both completion modes keep a (0px-closed) VFieldError row: the
               inactive one simply never opens (owner TZ 2026-11-01). -->
          <VFieldError id="err-end-date" :message="errors.recurrence_end_date" />
          <VFieldError id="err-count" :message="errors.recurrence_count" />
        </template>
      </div>

      <!-- ================================================================
           Participants (optional → no seal; the field name is the placeholder)
           ================================================================ -->
      <div class="create-practice__section">
        <h2 class="velo-section-title">
          {{ t('masterScreens.createPractice.sections.participants') }}
        </h2>

        <div>
          <VInput
            v-model="form.max_participants_raw"
            type="number"
            :placeholder="t('masterScreens.createPractice.fields.maxParticipants')"
            :error="errors.max_participants"
          />
        </div>
      </div>

      <!-- ================================================================
           Audience (P5, PROMPT №594; FE-24: the shared
           PracticeAudiencePicker -- kinds radio + target chips for BOTH
           targeted kinds): student groups and schools. No SVG mock exists --
           MINIMAL DS-language design.
           ================================================================ -->
      <div class="create-practice__section">
        <h2 class="velo-section-title">{{ t('masterScreens.createPractice.fields.audience') }}</h2>

        <div>
          <VCard class="create-practice__repeat" padding="none">
            <PracticeAudiencePicker
              v-model:kind="form.audience_kind"
              v-model:group-ids="form.audience_group_ids"
              v-model:school-id="form.audience_school_id"
              :groups="customGroups"
              :schools="audienceSchools"
              :allowed-kinds="contextSchoolId ? SCHOOL_AUDIENCE_KINDS : undefined"
              :error="errors.audience_group_ids"
              :students-label="t('masterScreens.createPractice.audience.allMyStudents')"
            />
          </VCard>
        </div>
      </div>

      <!-- ================================================================
           Payment (the paid option was removed — free only
           (i18n:common.free) for now, operator 2026-06-18 Q2=A; the paid
           option + price return as one line if ever needed)
           ================================================================ -->
      <div class="create-practice__section">
        <h2 class="velo-section-title">{{ t('masterScreens.createPractice.sections.payment') }}</h2>

        <div>
          <VCard class="create-practice__repeat" padding="none">
            <VRadioGroup :model-value="'free'" :options="PAYMENT_OPTIONS" />
          </VCard>
        </div>
      </div>

      <!-- ================================================================
           Description (textarea + 2 single-line ones; optional → no seal)
           ================================================================ -->
      <div class="create-practice__section create-practice__section--desc">
        <h2 class="velo-section-title">
          {{ t('masterScreens.createPractice.fields.description') }}
        </h2>

        <div>
          <VTextarea
            v-model="form.description"
            :placeholder="t('masterScreens.createPractice.fields.about')"
            :rows="4"
            autogrow
          />
        </div>

        <!-- 1-row start (rows=1) = the VInput height these were before; auto-grow
             past one line per the create-screen SVG (operator Q1=A). -->
        <div>
          <VTextarea
            v-model="form.contraindications"
            :placeholder="t('masterScreens.createPractice.fields.contraindications')"
            :rows="1"
            autogrow
          />
        </div>

        <div>
          <VTextarea
            v-model="form.what_to_prepare"
            :placeholder="t('masterScreens.createPractice.fields.whatToBring')"
            :rows="1"
            autogrow
          />
        </div>
      </div>

      <!-- Submit -->
      <VButton variant="primary" block size="lg" :loading="submitting" @click="submit">
        {{ t('masterScreens.createPractice.submit') }}
      </VButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { historyHasBack } from '@/platform/history'
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { VHeader } from '@/components/layout'
import {
  VButton,
  VFieldError,
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
import { getMySchools, getSchoolMembers } from '@/api/schools'
import { getPublicMaster } from '@/api/masters'
import type { SchoolMemberItem } from '@/api/types'
import PracticeAudiencePicker from '@/components/shared/PracticeAudiencePicker.vue'
import PracticeSchedulePicker from '@/components/shared/PracticeSchedulePicker.vue'
import type { AudienceSchoolOption } from '@/components/shared/practiceAudience'
import UseTemplateBlock from '@/components/shared/UseTemplateBlock.vue'
import Banner from '@/components/shared/Banner.vue'
import { DURATION_OPTIONS } from '@/utils/practiceOptions'
import { useKeyboardFieldScroll } from '@/composables/useKeyboardFieldScroll'
import { useFormDraft } from '@/composables/useFormDraft'
import {
  keepConfirmedPick,
  usePracticeTaxonomyOptions,
} from '@/composables/usePracticeTaxonomyOptions'
import {
  SCHOOL_AUDIENCE_KINDS,
  emptyPracticeForm,
  invalidScheduleText,
  isMeaningfulPracticeDraft,
  practiceSaveErrorText,
  practiceToForm,
  revealFirstFieldError,
  toCreatePayload,
  usePracticeCustomGroups,
  usePracticeForm,
} from '@/composables/usePracticeForm'
import type { PracticeResponse } from '@/api/types'
import { isOptionEnabled } from '@/platform/instance'

const router = useRouter()
const route = useRoute()
const toast = useToast()
const authStore = useAuthStore()
const masterStore = useMasterStore()

// -- Form state, validation, request body: the shared practice-form model
// (usePracticeForm). The timezone is the master's profile zone (the field
// was removed from the form, operator 2026-06-18); create always requires a
// start in the future.
const { form, errors, validate } = usePracticeForm(
  emptyPracticeForm(authStore.user?.timezone),
  () => ({ checkFuture: true }),
)

// §1.6 delegation: whose practice is being created. `masterId` in the query
// (the master's public page CTA) names the master; `schoolId` (the school
// page CTA) offers that school's visible masters with the self option
// (i18n:masterScreens.createPractice.audience.me) first. No query
// context -> the caller owns the practice, the historical behavior.
//
// FE-92 (BE-102): a curator creates a practice FOR a master of a school --
// POST /practices with master_id AND school_id; the backend accepts
// it only in that school, for a verified master of it, from its curator,
// and the practice is born PUBLISHED there (owner, 3 October) -- one
// "created and published" notice to the master, no second publish step.
// Without the school in the context (?schoolId=) another master is
// never offered: the request would be refused (master_id_requires_school).
// The audience kinds are the school's two (public / schools --
// check_school_audience) for the WHOLE school entry, the self option
// included (owner 2026-10-05) — the personal kinds (all my students
// (i18n:masterScreens.createPractice.audience.allMyStudents) / specific
// groups (i18n:practice.audience.groups)) are offered only by a no-context
// create.
const contextSchoolId = computed(() => queryParam('schoolId'))
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
// failed) -- the pickers then fail CLOSED (no options), never the full
// catalogue: the same posture as a not-yet-loaded own profile.
const delegatedMethods = ref<string[] | null>(null)
const delegatedMethodsLoadId = ref(0)

const targetMasterId = computed(() => delegatedMaster.value?.id ?? (selectedMasterId.value || null))
const targetsForeignMaster = computed(
  () => contextSchoolId.value !== '' && targetMasterId.value !== null,
)

// The school list the picker offers: while targeting a foreign master, ONLY
// the context school (the practice belongs to it); otherwise every eligible.
const audienceSchools = computed((): AudienceSchoolOption[] => {
  if (!targetsForeignMaster.value) return eligibleSchools.value
  const own = eligibleSchools.value.find((s) => s.id === contextSchoolId.value)
  return [
    own ?? { id: contextSchoolId.value, name: t('masterScreens.createPractice.fields.school') },
  ]
})

watch(targetsForeignMaster, (foreign) => {
  if (!foreign) return
  if (!SCHOOL_AUDIENCE_KINDS.includes(form.audience_kind)) form.audience_kind = 'public'
  if (form.audience_kind === 'schools') {
    form.audience_school_id = contextSchoolId.value
  }
})

const masterOptions = computed(() => [
  { label: t('masterScreens.createPractice.audience.me'), value: '' },
  ...schoolMasterOptions.value,
])

function queryParam(key: string): string {
  const value = route.query[key]
  return typeof value === 'string' ? value : ''
}

async function loadPracticeMasterContext(): Promise<void> {
  const masterId = queryParam('masterId')
  const schoolId = queryParam('schoolId')
  // FE-92: a master named without the school cannot be created for -- no
  // Master section (i18n:masterScreens.createPractice.fields.master),
  // the practice is the caller's own.
  if (masterId && schoolId) {
    try {
      const profile = await getPublicMaster(masterId)
      delegatedMaster.value = {
        id: masterId,
        name: profile.display_name ?? t('masterScreens.createPractice.fields.master'),
      }
      // The same lookup feeds the pickers: without it they would filter by
      // the CALLER's confirmed set while the backend validates the master's.
      delegatedMethods.value = profile.methods ?? null
    } catch {
      // Keep the id: the backend re-validates the delegation on submit, so
      // a cosmetic name lookup failure must not silently drop the target.
      delegatedMaster.value = {
        id: masterId,
        name: t('masterScreens.createPractice.fields.master'),
      }
      // The methods half is not cosmetic: without it the direction picker
      // stays empty (fail-closed), so say why instead of a silent dead form.
      toast.error(t('masterScreens.createPractice.error.loadMethods'))
    }
    return
  }
  if (schoolId) {
    try {
      const page = await getSchoolMembers(schoolId, { kind: 'master' })
      schoolMasterOptions.value = page.items
        .filter((m: SchoolMemberItem) => m.is_visible && m.user_id !== authStore.user?.id)
        .map((m: SchoolMemberItem) => ({
          label: m.name,
          value: m.user_id,
        }))
    } catch {
      // Picker falls back to the self option alone -- the caller can still
      // create.
      schoolMasterOptions.value = []
    }
  }
}

// The school-picker flow: a foreign master's methods arrive when he is
// picked, drop when the caller returns to the self option. The loadId makes an
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
      toast.error(t('masterScreens.createPractice.error.loadMethods'))
    }
  }
}

watch(selectedMasterId, (id) => {
  delegatedMethods.value = null
  if (id) void loadDelegatedMethods(id)
  else delegatedMethodsLoadId.value += 1 // drop any in-flight reply
})

// T21-6 (PROMPT №546) / FE-92: the pickers offer the confirmed methods of
// WHOEVER the practice is for -- the caller's own profile methods, or, while
// a foreign master is targeted, HIS (delegatedMethods; null until loaded ->
// no options). Offering the caller's set for another master is the
// submit-time 400 (direction_not_confirmed / style_not_confirmed) the
// filter exists to prevent, and hiding a direction the master himself holds
// would block a create the backend would accept.
const { confirmedMethods, directionOptions, styleOptions, onDirectionChange } =
  usePracticeTaxonomyOptions(form, () =>
    targetsForeignMaster.value ? delegatedMethods.value : masterStore.profile?.methods,
  )

// A change of whose methods the pickers offer must not silently keep a pick
// the new set refuses -- the backend would reject exactly that on submit.
// Same rule as applyTemplate's template copy (PROMPT №556): a still-confirmed
// pick survives, anything else is cleared so the caller re-picks from the
// live, filtered list. Also fires on the caller's own profile load, where
// the form is still empty and this is a no-op.
watch(confirmedMethods, (confirmed) => {
  if (confirmed) Object.assign(form, keepConfirmedPick(confirmed, form.direction, form.style))
})

// T24-24 (PROMPT №639): the students audience reads
// t('masterScreens.createPractice.audience.allMyStudents') on THIS screen
// ONLY -- passed to the shared PracticeAudiencePicker as `students-label`.

// Lift the focused field above the soft keyboard once it settles (shared M5
// composable — replaces the bespoke 300ms scrollFieldIntoView, K3).
const { onFieldFocus } = useKeyboardFieldScroll()

// Back/cancel: return to the real origin. Create opens from BOTH the dashboard
// empty-state CTA and the practices screen's "+" (goNew) — router.back() lands
// on whichever pushed us here (fixes "back always went to the practices
// screen", operator 2026-06-23).
// Deep-link / no history → fall back to the practices list. Submit-success
// navigation (→ master-practices) is unchanged; only this Back button differs.
function onBack(): void {
  if (historyHasBack()) router.back()
  else void router.push({ name: 'master-practices' })
}

// P5 (PROMPT №594): the master's own custom groups, for the specific-groups
// (i18n:practice.audience.groups) multi-select.
const customGroups = usePracticeCustomGroups()
// FE-24 (GT P5): schools this master may target (relation curator or master
// -- the two the backend validates school_id against). Loaded from
// /schools/mine; empty for a master in no school, which simply keeps
// the fourth audience option out of the radio.
const eligibleSchools = ref<AudienceSchoolOption[]>([])
onMounted(() => {
  // The use-template block (i18n:masterScreens.createPractice.useTemplate)
  // offers the master's practices (no-op if already loaded from the
  // practices list / dashboard).
  void masterStore.fetchMyPractices()
  void loadPracticeMasterContext()
  // T21-6 (PROMPT №546): the direction/style pickers filter by this
  // master's OWN confirmed methods. No-op if already loaded this session.
  void masterStore.fetchMyProfile()
  // FE-24 (GT P5): the eligible schools. A failure here degrades to "no
  // schools" (the fourth option stays hidden) -- quieter than the groups
  // failure: there is no screen to point at from a practice form, and the
  // toast would claim a list the user never opened. FE-151: with the
  // schools option off there is no probe -- the option stays hidden.
  if (!isOptionEnabled('schools')) return
  void getMySchools()
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

// -- Recurrence period options. The on/off toggle drives
// practice_type (series/live); when on, period/days/end build a RecurrenceSpec
// sent to the series engine (E3). --
const RECURRENCE_OPTIONS = [
  { label: t('masterScreens.createPractice.recurrence.daily'), value: 'daily' },
  { label: t('masterScreens.createPractice.recurrence.weekly'), value: 'weekly' },
  { label: t('masterScreens.createPractice.recurrence.biweekly'), value: 'biweekly' },
]

// Series end condition: never / until_date / after_count → RecurrenceSpec.end.
const RECURRENCE_END_OPTIONS = [
  { label: t('masterScreens.createPractice.recurrence.never'), value: 'never' },
  { label: t('masterScreens.createPractice.picker.date'), value: 'until_date' },
  { label: t('masterScreens.createPractice.recurrence.afterCount'), value: 'after_count' },
]

// The paid option was removed (operator 2026-06-18 Q2=A) — free practices only for now.
const PAYMENT_OPTIONS = [{ value: 'free', label: t('common.free') }]

// Difficulty — local masculine-gender labels agreeing with the word "level"
// (Q1=B); the global DIFFICULTY_LABEL (feminine, agreeing with "practice")
// stays untouched.
const DIFFICULTY_OPTIONS_CREATE = [
  { value: 'beginner', label: t('masterScreens.createPractice.difficulty.beginner') },
  { value: 'medium', label: t('masterScreens.createPractice.difficulty.medium') },
  { value: 'high', label: t('masterScreens.createPractice.difficulty.high') },
]

// Use-template (i18n:masterScreens.createPractice.useTemplate) source: all
// the master's practices, newest-created
// first (operator Q2=A — backend list order isn't guaranteed, so sort here).
//
// T23-3 (PROMPT №565): a published SERIES must offer ONE entry, not one per
// generated occurrence -- masterStore.practices carries every child
// individually (each is its own Practice row), so an unrelated series
// otherwise floods this list with N near-identical cards (the same title
// three times for three July dates in the owner's report).
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

// -- Draft autosave (L1 / B2, useFormDraft) -----------------------------------
// A half-filled create form (i18n:masterScreens.createPractice.title)
// survives an accidental navigation-away. Scoped per user. NOT auto-restored:
// a meaningful draft surfaces the resume banner
// (i18n:masterScreens.createPractice.draft.resumeConfirm) (restore / start
// fresh). Dropped on a successful submit and on start-over
// (i18n:masterScreens.createPractice.draft.startOver).
const {
  offered: showDraftBanner,
  restore: restoreDraft,
  discard: discardDraft,
  finish: finishDraft,
  withoutAutosave,
} = useFormDraft(form, {
  key: () => `velo:create-practice-draft:${authStore.user?.id ?? 'anon'}`,
  isMeaningful: isMeaningfulPracticeDraft,
})

// The settings a template copies; date & time intentionally NOT (a template
// must not schedule a practice in the past, operator Q1=A). Direction and
// style are copied separately, through the confirmed-methods filter.
const TEMPLATE_FIELDS = [
  'title',
  'difficulty',
  'duration_minutes',
  'max_participants_raw',
  'description',
  'what_to_prepare',
  'contraindications',
] as const

/**
 * Use template (i18n:masterScreens.createPractice.useTemplate): prefill the
 * form from one of the master's own past practices. The block collapses
 * itself after selecting.
 */
function applyTemplate(p: PracticeResponse): void {
  const values = practiceToForm(p)
  // A prefill is NOT itself a user draft (B2): only the master's own
  // subsequent edits are autosaved.
  withoutAutosave(() => {
    for (const key of TEMPLATE_FIELDS) form[key] = values[key]
    // PROMPT №556 (OWNER-2, MEASURED root cause): a template's direction/style
    // were confirmed when IT was created, and the master's confirmed methods
    // may have narrowed since. This assignment bypasses the filtered pickers,
    // so only a value still in the CURRENT confirmed set is copied; otherwise
    // the master re-picks from the live, filtered list.
    Object.assign(form, keepConfirmedPick(confirmedMethods.value, p.direction, p.style))
  })
}

// -- Submit --
// FP-04: double-submit guard must come before validate() --
// parallel clicks both pass validate() before guard fires.
async function submit(): Promise<void> {
  if (submitting.value) return
  if (!validate()) {
    await revealFirstFieldError()
    return
  }
  const payload = toCreatePayload(form)
  if (!payload) {
    // validate() already checked the date and time; toISO() is still typed
    // string | null, so guard instead of sending a bad value.
    toast.error(invalidScheduleText())
    return
  }
  submitting.value = true

  try {
    // FE-92: for another master the school is ALWAYS sent (the practice
    // belongs to it, with either of its two audiences), plus master_id.
    const created = await createPractice(
      targetsForeignMaster.value
        ? { ...payload, school_id: contextSchoolId.value, master_id: targetMasterId.value }
        : payload,
    )

    // A4 V6 (PROMPT №572): `deduplicated` is the EXPLICIT backend signal that
    // `created` is the master's own EARLIER submission (the window-scoped
    // retry-after-timeout check, PROMPT №559, or the losing side of a
    // genuine concurrent double-tap, A4 V7) -- not a new practice. Before
    // this field existed, the form said t('masterScreens.createPractice.toast.created') and navigated
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
      finishDraft()
      if (created.deduplicated) toast.info(t('masterScreens.createPractice.toast.duplicate'))
      else toast.success(t('masterScreens.createPractice.toast.published'))
      void router.replace({ name: 'master-school', params: { id: contextSchoolId.value } })
      return
    }

    if (created.deduplicated) {
      finishDraft()
      toast.info(t('masterScreens.createPractice.toast.openExisting'))
      void router.replace({ name: 'master-practice-detail', params: { id: created.id } })
      void masterStore.refreshMyPractices().catch(() => {})
      return
    }

    // Publish immediately: a freshly created practice must be live & bookable,
    // not a draft that needs a second edit→publish step (operator
    // 2026-06-17). The backend create defaults to 'draft'; we run the same
    // draft→scheduled PATCH the edit screen uses, so the practice appears on the
    // dashboard's nearest-practice card
    // (i18n:masterScreens.masterDashboard.nearestOne; scheduled/live only)
    // right away.
    if (created.status !== 'scheduled') {
      await updatePractice(created.id, { status: 'scheduled' })
    }

    // Draft fulfilled — drop it (and block any late debounced save) so it can't
    // resurrect on the next create. Runs only AFTER a successful publish: if
    // the PATCH above throws, control never reaches here and the draft
    // survives for a retry (see the catch block's failed-publish test).
    finishDraft()

    toast.success(t('masterScreens.createPractice.toast.created'))
    // Redirect to the master's practices list — it defaults to the upcoming tab
    // (i18n:masterScreens.masterPractices.tab.upcoming), and the practice we
    // just published is status='scheduled', so
    // it lands there. replace() (not push) so Back returns to the origin
    // (practices / dashboard), not back onto this filled form (#1). Navigate
    // BEFORE the refresh so a failing refresh can never divert to catch and strand
    // the user on the form still showing the created toast copy
    // (i18n:masterScreens.createPractice.toast.created) (G1).
    void router.replace({ name: 'master-practices' })
    // Invalidate the cached list so it reloads with the new practice. Fire-and-
    // forget + swallow: master-practices loads its own list on mount, so a missed
    // refresh is harmless and must not turn a successful create into an error path.
    void masterStore.refreshMyPractices().catch(() => {})
  } catch (e) {
    toast.error(practiceSaveErrorText(e, t('masterScreens.createPractice.toast.createFailed')))
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
   (the "screen jitters" owner report). Keep the column at its AT-REST height instead:
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
  /* Minimal acceptable section rhythm (owner 2026-10-01: the gaps were
     huge) -- 16px between sections. */
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
  gap: var(--velo-gap-2);
}

.create-practice__section > .velo-section-title {
  margin-bottom: var(--velo-gap-6);
}

/* Description section: the textareas are spaced by the section gap alone — drop
   their own margin-bottom so the description / contraindications /
   what-to-bring fields sit
   tight (one step, not the doubled gap + margin) (operator CP-A1). */
.create-practice__section--desc :deep(.v-textarea) {
  margin-bottom: var(--space-2);
}

/* Required-fields legend banner (DS, Phase-3) — pink glass plate, rose seal. */
.create-practice__legend {
  display: flex;
  align-items: center;
  gap: var(--velo-banner-gap-icon-text);
  background: var(--velo-glass-pink-40);
  border: 1px solid var(--velo-pink-300);
  border-radius: var(--velo-radius-12);
  padding: var(--velo-gap-11) var(--space-4);
  font-family: var(--font-body);
  font-size: var(--velo-fs-14);
  color: var(--velo-pink-700);
}

/* -- Draft-restore banner (B2) -- */
.create-practice__draft-text {
  margin: 0;
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
  line-height: 1.4;
}

.create-practice__draft-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

/* Recurrence cards (white plates). */
.create-practice__repeat {
  padding: var(--space-3) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.create-practice__repeat-title {
  font-family: var(--font-body);
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
}

/* Error lines are VFieldError rows (owner TZ 2026-11-01): 0px while closed,
   expanding smoothly on appear; VInput/VSelect keep their red borders via
   their own :error props. The date/time plates are PracticeSchedulePicker. */

/* -- Recurrence: rows of cards (the card/days take the full width). -- */
.create-practice__seal-row {
  display: flex;
  align-items: flex-start;
}

/* Stacked plates (repeat card / days / end) need breathing the 2px section
   gap cannot give them. */
.create-practice__seal-row + .create-practice__seal-row {
  margin-top: var(--velo-gap-6);
}

.create-practice__grow {
  flex: 1;
  min-width: 0;
}

/* -- Weekdays: a wrapper card for the DS primitive VDayPicker. -- */
.create-practice__days {
  background: var(--velo-bg-card-solid);
  border-radius: var(--radius-md);
  padding: var(--velo-card-padding-y) var(--space-3);
}

/* The finish sub-control (end-date picker / repeat-count input) — sits below
   the radios in the flex-COLUMN card; flex:0 0 auto keeps its natural height
   (the outlined end-date plate gives it a visible edge on the white card). */
.create-practice__end-control {
  margin-top: var(--space-3);
  flex: 0 0 auto;
}

.create-practice__count-input {
  width: 160px;
  height: var(--velo-size-40);
  padding: 0 var(--space-4);
  font-family: var(--font-body);
  font-size: var(--velo-fs-18);
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
