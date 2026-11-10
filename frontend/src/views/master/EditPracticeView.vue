<!--
  VELO Frontend -- EditPracticeView (Phase F6.2 + F6.3, fixed W-2..W-9)

  Edit an existing practice and trigger state machine transitions.
  Protected by masterStatusGuard. Rendered inside MasterShell.

  Load order:
    1. Try masterStore.practices cache (instant if already loaded)
    2. Fallback: GET /api/v1/practices/:id

  Editable fields (draft / scheduled only -- completed/cancelled are readonly):
    title, description, what_to_prepare, contraindications,
    scheduled_at (date+time), duration_minutes,
    timezone, max_participants, is_free, price_cents

  T-35: zoom_link is gone -- the column no longer exists. A meeting that
  failed to create is fixed with the retry action, not with a hand-typed link
  that silently breaks attendance.

  State machine action buttons (below form):
    draft      -> publish (i18n:masterScreens.editPractice.actions.publish)
                  -- PATCH status=scheduled
                  delete draft (i18n:masterScreens.editPractice.actions.deleteDraft)
                  -- DELETE (soft-delete, draft only)
    scheduled  -> cancel (i18n:masterScreens.editPractice.actions.cancelPractice)
                  -- POST /cancel (+ confirm dialog)
    live       -> cancel (same key) -- POST /cancel (+ confirm dialog)
                  (no manual scheduled->live nor live->finalize here: going live
                   and completion are auto-by-schedule/duration, pending backend.
                   The Go-live button was removed — operator 2026-06-24.)
    completed / cancelled / deleted -> readonly info banner

  After any successful mutation:
    - refreshMyPractices() to invalidate cache
    - navigate back to master-practices

  Fixes:
    W-2: DURATION_OPTIONS / TIMEZONE_OPTIONS imported from @/utils/practiceOptions
    W-3: anyLoading computed = saving || transitioning || cancelling || deleting
         || refreshing (the server copy still loading behind a cached placeholder).
         All action buttons and Save use :disabled="anyLoading" -- prevents
         concurrent save + publish / save + cancel / etc.
    W-5: confirm dialog overlay click blocked while confirmDialog.loading is true
    W-6: price cents <-> euro string without float arithmetic (usePracticeForm).
    W-8: the date picker never offers a day before today (PracticeSchedulePicker).
    W-9: commission calc uses COMMISSION_RATE from @/utils/commission
    A4 V3 (PROMPT №571): direction/style options filtered to the master's own
        CONFIRMED methods, and the taxonomy rejection codes
        (direction_not_confirmed/style_not_confirmed) get the same translated
        toast as CreatePracticeView's -- both through the shared composables.

  FE-157 (stage 4, 4A): the form model, its validation and the PATCH body
  live in composables/usePracticeForm.ts, shared with CreatePracticeView --
  one validation for both screens (a moved start must lie in the future).
-->

<template>
  <div class="edit-practice">
    <!-- Back returns to the practice screen; that screen decides where to go next
         (dashboard or practices, depending on origin) — operator 2026-06-17.
         Deep-link-safe: pop the existing detail entry (router.back) instead of
         PUSHing a new one — pushing grew history and ping-ponged edit<->detail
         (the back-loop, operator 2026-06-24). Mirror of CreatePracticeView.onBack. -->
    <VHeader :title="t('masterScreens.editPractice.title')" show-back @back="onBack" />

    <!-- Loading -->
    <div v-if="loading" class="edit-practice__loader">
      <VLoader size="lg" />
    </div>

    <!-- Error / not found -->
    <div v-else-if="!practice" class="edit-practice__content">
      <VEmptyState icon="warning" :title="t('masterScreens.editPractice.notFound')">
        <VButton size="sm" variant="outline" @click="router.push({ name: 'master-practices' })">
          {{ t('ui.back') }}
        </VButton>
      </VEmptyState>
    </div>

    <template v-else>
      <!-- ================================================================
           READONLY BANNER for terminal statuses
           ================================================================ -->
      <div v-if="isTerminal" class="edit-practice__readonly-banner">
        <VBadge
          v-if="masterPracticeBadge(practice.status)"
          :variant="masterPracticeBadge(practice.status)!.variant"
        >
          {{ masterPracticeBadge(practice.status)!.label }}
        </VBadge>
        <span class="edit-practice__readonly-text">{{
          t('masterScreens.editPractice.editLocked')
        }}</span>
      </div>

      <div class="edit-practice__content">
        <!-- ================================================================
             FORM (editable for draft / scheduled only)
             ================================================================ -->
        <fieldset :disabled="isTerminal || saving" class="edit-practice__fieldset">
          <!-- Decision V (2026-06-12): fields per the Edit SVG (label-above,
               white plate), WITHOUT section headings. Difficulty/timezone/price
               stay omitted — they are set at creation and locked afterwards
               (parked in form, shipped unchanged on submit, no data lost).
               Direction/style were ADDED (operator, T2, 2026-07-15 — an
               override of the navigator's plan: not in a separate later
               batch, but right in this one). Date and Zoom were returned
               by logic (see the comments below). -->
          <VInput
            v-model="form.title"
            :label="t('masterScreens.editPractice.fields.name')"
            :error="errors.title"
          />

          <!-- Direction — options catalog-first (T2 stage 2), see CreatePracticeView. -->
          <VSelect
            v-model="form.direction"
            :label="t('masterScreens.editPractice.fields.direction')"
            :options="directionOptions"
            :error="errors.direction"
            @update:modelValue="onDirectionChange"
          />

          <!-- Practice style — shown only when the direction has styles
               (Q4=A, mirrors CreatePracticeView: no explicit "no style" option). -->
          <div v-if="styleOptions.length > 0">
            <VSelect
              v-model="form.style"
              :label="t('masterScreens.editPractice.fields.style')"
              :options="styleOptions"
            />
          </div>

          <!-- Date — DS picker (decision V: returned by logic — rescheduling a
               practice is a normal operation; the native type=date was
               replaced with the branded picker). Time — 24h, 5-minute step.
               A moved start must lie in the future (the shared validation). -->
          <PracticeSchedulePicker
            v-model="form.date"
            kind="date"
            class="edit-practice__field"
            :label="t('masterScreens.editPractice.fields.date')"
            :placeholder="t('ui.pickerChooseDate')"
            :error="errors.date"
            error-id="err-date"
          />
          <PracticeSchedulePicker
            v-model="form.time"
            kind="time"
            class="edit-practice__field"
            :label="t('masterScreens.editPractice.fields.time')"
            :placeholder="t('masterScreens.editPractice.pickers.time')"
            :error="errors.time"
            error-id="err-time"
          />

          <VSelect
            v-model="form.duration_minutes"
            :label="t('masterScreens.editPractice.fields.duration')"
            :options="DURATION_OPTIONS"
            :error="errors.duration_minutes"
          />

          <VInput
            v-model="form.max_participants_raw"
            :label="t('masterScreens.editPractice.fields.maxParticipants')"
            type="number"
            :error="errors.max_participants"
          />

          <!-- ================================================================
               Audience (P5 port, PROMPT №606; FE-24: the shared
               PracticeAudiencePicker, the same component Create uses --
               the local copy of the chips block is gone). Edit's FLAT
               layout keeps its own field label (no velo-section-title
               sections here, decision V above).
               ================================================================ -->
          <div class="edit-practice__field edit-practice__audience">
            <label class="edit-practice__field-label">{{
              t('masterScreens.editPractice.fields.audience')
            }}</label>
            <!-- BE-74: a practice of a school keeps its school for good
                 (practice_school_immutable), and the backend allows such a
                 practice only the 'public'/'schools' pair
                 (check_school_audience). FE-92 put that pair into the create
                 UI (curator-on-behalf), so Edit offers the same two radios:
                 the KIND is editable, the SCHOOL is not -- schoolLocked
                 suppresses the chips; the owning school is not shown at all
                 (owner 2026-10-05). -->
            <template v-if="practice?.school_id">
              <PracticeAudiencePicker
                v-model:kind="form.audience_kind"
                v-model:group-ids="form.audience_group_ids"
                :school-id="practice.school_id"
                :groups="customGroups"
                :schools="practiceSchool"
                :allowed-kinds="SCHOOL_AUDIENCE_KINDS"
                school-locked
                :error="errors.audience_group_ids"
              />
            </template>
            <!-- A practice without a school: the classic three kinds. No
                 schools are offered -- a school cannot be given to an
                 existing practice -- so the picker's school model is a
                 constant null that never changes. -->
            <PracticeAudiencePicker
              v-else
              v-model:kind="form.audience_kind"
              v-model:group-ids="form.audience_group_ids"
              :school-id="null"
              :groups="customGroups"
              :schools="[]"
              :error="errors.audience_group_ids"
            />
          </div>

          <VTextarea
            v-model="form.description"
            :label="t('masterScreens.editPractice.fields.description')"
            :rows="4"
            autogrow
          />

          <VTextarea
            v-model="form.contraindications"
            :label="t('masterScreens.editPractice.fields.contraindications')"
            :placeholder="t('masterScreens.editPractice.placeholder.healthConditions')"
            :rows="2"
            autogrow
          />

          <VTextarea
            v-model="form.what_to_prepare"
            :label="t('masterScreens.editPractice.fields.whatToBring')"
            :placeholder="t('masterScreens.editPractice.placeholder.whatToBring')"
            :rows="3"
            autogrow
          />

          <!-- W-3: :disabled="anyLoading" prevents Save while an action runs. -->
          <VButton
            v-if="!isTerminal"
            variant="primary"
            block
            :loading="saving"
            :disabled="anyLoading"
            @click="save"
          >
            {{ t('ui.save') }}
          </VButton>
        </fieldset>

        <!-- ================================================================
             STATE MACHINE ACTIONS
             Q2=A (2026-06-12): the lifecycle transitions are KEPT TEMPORARILY
             (the Edit SVG has none) — until the Practice-detail hub (WI-B)
             takes them over. Dropping them now = leaving the master with no
             publish/complete action at all (the hub mockup has none either).
             When WI-B is built, this block migrates there.
             W-3: all buttons :disabled="anyLoading" -- prevents concurrent
             save + publish / save + cancel / save + delete etc.
             ================================================================ -->
        <div v-if="!isTerminal" class="edit-practice__actions">
          <!-- draft -> scheduled -->
          <VButton
            v-if="practice.status === 'draft'"
            variant="primary"
            block
            :loading="transitioning"
            :disabled="anyLoading"
            @click="publish"
          >
            {{ t('masterScreens.editPractice.actions.publish') }}
          </VButton>

          <!-- The Go-live button (scheduled->live) was removed (operator
               2026-06-24): it
               surfaced only because Create now auto-publishes to `scheduled`, and
               it must not live on the edit screen. Going live is auto-by-schedule
               (Zod) / lives on the practice hub, not here. -->

          <!-- The "Complete practice" and "Attendance" buttons were removed
               (operator 2026-06-17):
               finalize is non-obvious behind the edit form; a practice is meant to
               complete automatically by its duration (unless cancelled) once the
               backend implements it — see the Zod note. Attendance/check-ins stay
               reachable from the dashboard Check-ins header and the practice screen. -->

          <!-- draft -> deleted -->
          <VButton
            v-if="practice.status === 'draft'"
            variant="danger"
            block
            :loading="deleting"
            :disabled="anyLoading"
            @click="confirmDelete"
          >
            {{ t('masterScreens.editPractice.actions.deleteDraft') }}
          </VButton>

          <!-- scheduled / live -> cancelled -->
          <VButton
            v-if="practice.status === 'scheduled' || practice.status === 'live'"
            variant="danger"
            block
            :loading="cancelling"
            :disabled="anyLoading"
            @click="confirmCancel"
          >
            {{ t('masterScreens.editPractice.actions.cancelPractice') }}
          </VButton>
        </div>
      </div>

      <!-- W-5: cancel/overlay blocked while confirmDialog.loading is true (VConfirmDialog) -->
      <VConfirmDialog
        :open="confirmDialog.visible"
        :message="confirmDialog.message"
        :confirm-label="confirmDialog.confirmLabel"
        :danger="confirmDialog.danger"
        :loading="confirmDialog.loading"
        @confirm="confirmDialog.onConfirm"
        @cancel="confirmDialog.visible = false"
      />

      <!-- Branded cancel-practice modal (replaces the generic confirm for cancel;
           operator SVG «Abolish the practice»). cancelPractice = real refund;
           series-scope radio inside is captured-only (→ Zod). -->
      <CancelPracticeDialog
        :open="cancelModalOpen"
        :practice="practice"
        :loading="cancelling"
        @confirm="cancel"
        @cancel="cancelModalOpen = false"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { historyHasBack } from '@/platform/history'
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import {
  VButton,
  VInput,
  VTextarea,
  VSelect,
  VBadge,
  VLoader,
  VEmptyState,
  VConfirmDialog,
} from '@/components/ui'
import CancelPracticeDialog from '@/components/shared/CancelPracticeDialog.vue'
import PracticeAudiencePicker from '@/components/shared/PracticeAudiencePicker.vue'
import PracticeSchedulePicker from '@/components/shared/PracticeSchedulePicker.vue'
import type { AudienceSchoolOption } from '@/components/shared/practiceAudience'
import { useToast } from '@/composables/useToast'
import { useMasterStore } from '@/stores/master'
import {
  getPractice,
  updatePractice,
  deletePractice,
  cancelPractice,
  previewAudienceChange,
} from '@/api/practices'
import { masterPracticeBadge } from '@/utils/practiceStatus'
import { extractApiError } from '@/composables/useApiError'
import { DURATION_OPTIONS } from '@/utils/practiceOptions'
import { usePracticeTaxonomyOptions } from '@/composables/usePracticeTaxonomyOptions'
import {
  SCHOOL_AUDIENCE_KINDS,
  emptyPracticeForm,
  invalidScheduleText,
  practiceSaveErrorText,
  practiceToForm,
  revealFirstFieldError,
  scheduleChanged,
  snapshotPracticeForm,
  toPracticePatch,
  usePracticeCustomGroups,
  usePracticeForm,
  type PracticeFormValues,
} from '@/composables/usePracticeForm'
import type { PracticeResponse } from '@/api/types'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const masterStore = useMasterStore()

const practiceId = route.params.id as string

// Back to the practice screen. Deep-link-safe: if there's history, pop to the
// detail entry that pushed us here (avoids the edit<->detail back-loop); else
// (cold deep-link) push the detail route. Mirror of CreatePracticeView.onBack.
function onBack(): void {
  if (historyHasBack()) router.back()
  else void router.push({ name: 'master-practice-detail', params: { id: practiceId } })
}

// -- Practice data --
const practice = ref<PracticeResponse | null>(null)
const loading = ref(false)
/** True while the authoritative `getPractice` runs behind a cached placeholder. */
const refreshing = ref(false)

// -- Action loading states --
const saving = ref(false)
const transitioning = ref(false)
const cancelling = ref(false)
const deleting = ref(false)

// Branded cancel modal (Q3=A, 2026-06-12).
const cancelModalOpen = ref(false)

// W-3: single guard covering all mutually exclusive actions.
// Every action button and the Save button use :disabled="anyLoading".
// Prevents concurrent save + publish, save + cancel, etc.
const anyLoading = computed(
  () =>
    saving.value || transitioning.value || cancelling.value || deleting.value || refreshing.value,
)

// -- Confirm dialog state --
const confirmDialog = reactive({
  visible: false,
  message: '',
  confirmLabel: t('ui.confirm'),
  danger: false,
  loading: false,
  onConfirm: (): void => {
    /* filled per use */
  },
})

/**
 * What the form held right after the last populate from the server. `save`
 * diffs against it, so a PATCH carries only what the master changed and
 * cannot overwrite a field somebody else edited meanwhile with a stale value.
 */
let baseline: PracticeFormValues | null = null

// -- Form state (populated from the practice on load) and validation: the
// shared practice-form model (usePracticeForm), the same rules as create.
// The start must lie in the future only when the schedule itself changed:
// that is exactly when the PATCH carries scheduled_at, the one case the
// backend refuses a past start (see usePracticeForm's header). A practice
// that has already started stays editable in every other field.
const { form, errors, validate } = usePracticeForm(emptyPracticeForm(), (v) => ({
  checkFuture: scheduleChanged(v, baseline),
}))

// P5 port (PROMPT №606): this master's own custom groups, for the
// specific-groups (i18n:practice.audience.groups) multi-select. Re-resolves
// the name->id selection once they land, in case populateForm() already ran
// against an empty list.
const customGroups = usePracticeCustomGroups(() => resolveAudienceGroupIds())

// BE-74 + FE-92: a school practice's KIND is editable, but only within the
// pair the backend accepts (SCHOOL_AUDIENCE_KINDS) -- the same pair the
// curator-on-behalf create flow offers. The SCHOOL itself never changes, so
// the picker gets exactly the practice's own school (which makes
// audienceOptions() offer the pair) with schoolLocked on: no chips.
const practiceSchool = computed<AudienceSchoolOption[]>(() => {
  const p = practice.value
  if (!p?.school_id) return []
  return [{ id: p.school_id, name: p.school_name ?? '' }]
})

// -- Derived --
const isTerminal = computed(
  (): boolean =>
    practice.value?.status === 'completed' ||
    practice.value?.status === 'cancelled' ||
    practice.value?.status === 'deleted',
)

// A4 V3 (PROMPT №571): direction/style options filtered to the confirmed
// methods, same composable and fail-CLOSED posture as CreatePracticeView.
// Before this, Edit offered the WHOLE active catalogue unfiltered and the
// master only learned from the backend's raw rejection on save.
//
// BE-63: the OTHER manager the backend accepts on PATCH is the school's
// curator, and for a foreign practice it validates direction/style against
// the OWNER's confirmed methods (_assert_master_confirmed_taxonomy) -- so
// the pickers must offer the owner's set, not the editor's. The detail
// response carries it directly (practice.master_methods, get_practice()'s
// outer join). The practices-list cache rows carry master_methods [] by
// contract ("list endpoints pass []"), and a cache hit is always the
// CALLER's own practice (GET /masters/me/practices) -- for those the
// profile fallback reads the same set. A curator therefore never reaches
// this filter without the owner's methods on the practice.
const { directionOptions, styleOptions, onDirectionChange } = usePracticeTaxonomyOptions(
  form,
  () =>
    practice.value?.master_methods?.length
      ? practice.value.master_methods
      : masterStore.profile?.methods,
)

// -- Populate form from practice --
function populateForm(p: PracticeResponse): void {
  Object.assign(form, practiceToForm(p), {
    // Older practices created before the Calendar iteration may have null
    // facets -> fall back to defaults so the selects always show a valid
    // option. Difficulty has no field here (set at creation, decision V),
    // so the fallback is also what keeps the shared validation satisfied.
    direction: p.direction ?? 'meditation',
    difficulty: p.difficulty ?? 'beginner',
  })
  // PracticeResponse carries audience_group_NAMES, not ids (see the field's
  // docstring in api/generated.ts) -- CheckinView composes a message from
  // the names directly and never needed ids, so the backend never added an
  // id list to this response. Resolving name -> id against customGroups is
  // safe: create_group() 409s on a duplicate name for the SAME master
  // (groups_service.py:416-424), so a name uniquely identifies one of this
  // master's groups.
  resolveAudienceGroupIds()
  baseline = snapshotPracticeForm(form)
}

// Resolve form.audience_kind === 'groups' names -> ids once customGroups is
// available. A no-op (leaves the selection empty) if either side isn't
// ready yet -- called again once customGroups.value is populated.
function resolveAudienceGroupIds(): void {
  if (form.audience_kind !== 'groups' || !practice.value) return
  const names = new Set(practice.value.audience_group_names ?? [])
  form.audience_group_ids = customGroups.value.filter((g) => names.has(g.name)).map((g) => g.id)
  // Resolving ids is part of loading, not an edit: keep the diff base in step.
  if (baseline) baseline.audience_group_ids = [...form.audience_group_ids]
}

// -- Load practice --
onMounted(async () => {
  // The form is always filled from the server (`getPractice`): the list cache
  // may be stale (another editor, a status change) and a PATCH built from it
  // would write old values back. The cached row is only a placeholder that
  // spares the master a spinner; Save stays disabled until the fetch lands.
  const cached = masterStore.practices.find((p) => p.id === practiceId)
  if (cached) {
    practice.value = cached
    populateForm(cached)
    refreshing.value = true
  } else {
    loading.value = true
  }
  try {
    const fresh = await getPractice(practiceId)
    applyFresh(fresh)
  } catch (e) {
    // A failed refresh keeps the placeholder visible but unsaveable would be
    // a trap: drop it so the master sees the error state, not stale data.
    practice.value = null
    toast.error(extractApiError(e, t('practice.loadFailed')))
  } finally {
    loading.value = false
    refreshing.value = false
  }
})

/**
 * Replace the placeholder with the server record. Fields the master already
 * edited on top of the placeholder keep their edits; everything else takes
 * the fresh value, and the diff base becomes the fresh state.
 */
function applyFresh(fresh: PracticeResponse): void {
  const before = baseline
  const edited = before ? snapshotPracticeForm(form) : null
  practice.value = fresh
  populateForm(fresh)
  if (!before || !edited) return
  const target = form as unknown as Record<string, unknown>
  const typedBefore = before as unknown as Record<string, unknown>
  const typedEdited = edited as unknown as Record<string, unknown>
  for (const key of Object.keys(typedEdited)) {
    if (JSON.stringify(typedEdited[key]) !== JSON.stringify(typedBefore[key])) {
      target[key] = typedEdited[key]
    }
  }
}

// -- Audience-narrowing warning (owner Q15, PROMPT №613) --
//
// True iff the FORM's audience differs from what's currently SAVED on
// `practice.value` -- gates the stranded-bookers check below so it only
// ever runs on an actual audience change, never on an unrelated save (e.g.
// title-only). Since FE-157 the PATCH carries the audience pair only when
// it changed (toPracticePatch), but the check stays keyed on the saved practice.
function audienceChanged(): boolean {
  if (!practice.value) return false
  const savedKind = practice.value.audience_kind ?? 'public'
  if (form.audience_kind !== savedKind) return true
  // A school practice's kind is editable within the public/'schools'
  // pair (see the template); either way, with the kind unchanged only a
  // change of groups is left to detect.
  if (form.audience_kind !== 'groups') return false

  // Same name -> id resolution resolveAudienceGroupIds() already uses --
  // recomputed fresh here (not read off `form`, which may have already
  // been edited) so this reflects what's actually SAVED, not the pending edit.
  const savedNames = new Set(practice.value.audience_group_names ?? [])
  const savedIds = new Set(
    customGroups.value.filter((g) => savedNames.has(g.name)).map((g) => g.id),
  )
  if (form.audience_group_ids.length !== savedIds.size) return true
  return form.audience_group_ids.some((id) => !savedIds.has(id))
}

// -- Save --
async function save(): Promise<void> {
  if (!validate()) {
    await revealFirstFieldError()
    return
  }
  if (saving.value) return

  if (audienceChanged()) {
    saving.value = true
    let preview
    try {
      preview = await previewAudienceChange(practiceId, {
        audience_kind: form.audience_kind,
        group_ids: form.audience_kind === 'groups' ? form.audience_group_ids : [],
      })
    } catch (e) {
      saving.value = false
      toast.error(extractApiError(e, t('masterScreens.editPractice.error.checkAudience')))
      return
    }
    saving.value = false

    // Owner Q15: warn ONLY when the count is above zero -- a narrowing
    // that strands nobody saves silently, same as today.
    if (preview.stranded_count > 0) {
      // Owner-picked wording (PROMPT №614, wording B): three facts -- how
      // many, why, and that the booking survives (the fact that stops the
      // master over-panicking). The NOUN's forms come from the CLDR pipe
      // key plural.bookedNoun (a Russian substantivized participle whose
      // 2-4 and 5+ forms are IDENTICAL, so
      // the 3-way split collapses to a binary one there). That same
      // one-vs-rest split also governs the sentence's verb/pronoun
      // agreement in Russian (the singular vs plural verb and pronoun
      // forms), which no noun triple covers --
      // so the SENTENCE branches on count === 1 directly (strandedHeadOne /
      // strandedHeadMany) rather than threading variants through a helper.
      const n = preview.stranded_count
      const noun = t('masterScreens.editPractice.plural.bookedNoun', n)
      confirmDialog.message =
        n === 1
          ? t('masterScreens.editPractice.confirm.strandedHeadOne', { n, noun }) +
            t('masterScreens.editPractice.confirm.single')
          : t('masterScreens.editPractice.confirm.strandedHeadMany', { n, noun }) +
            t('masterScreens.editPractice.confirm.plural')
      confirmDialog.confirmLabel = t('masterScreens.editPractice.saveAnyway')
      confirmDialog.danger = false
      confirmDialog.onConfirm = () => {
        void commitSave()
      }
      confirmDialog.visible = true
      return
    }
  }

  await commitSave()
}

async function commitSave(): Promise<void> {
  if (saving.value) return
  saving.value = true
  confirmDialog.loading = true
  try {
    const body = baseline ? toPracticePatch(form, baseline, audienceChanged()) : null
    if (body === undefined) {
      toast.error(invalidScheduleText())
      return
    }
    if (body === null) {
      // Nothing differs from the server record: no request, no lost-update risk.
      confirmDialog.visible = false
      toast.success(t('ui.saved'))
      return
    }
    // The values this PATCH carries; once it succeeds they are what the
    // server holds, so the next Save diffs against them. Taken BEFORE the
    // request: an edit made while it is in flight stays unsaved.
    const sent = snapshotPracticeForm(form)
    const updated = await updatePractice(practiceId, body)
    practice.value = updated
    baseline = sent
    confirmDialog.visible = false
    toast.success(t('ui.saved'))
    await masterStore.refreshMyPractices()
  } catch (e) {
    toast.error(practiceSaveErrorText(e, t('masterScreens.editPractice.toast.saveFailed')))
  } finally {
    saving.value = false
    confirmDialog.loading = false
  }
}

// -- Publish: draft -> scheduled --
async function publish(): Promise<void> {
  if (anyLoading.value) return
  transitioning.value = true
  try {
    const updated = await updatePractice(practiceId, { status: 'scheduled' })
    practice.value = updated
    toast.success(t('masterScreens.editPractice.toast.published'))
    await masterStore.refreshMyPractices()
    void router.push({ name: 'master-practices' })
  } catch (e) {
    toast.error(extractApiError(e, t('masterScreens.editPractice.toast.publishFailed')))
  } finally {
    transitioning.value = false
  }
}

// -- Confirm cancel: open the branded modal (CancelPracticeDialog). --
function confirmCancel(): void {
  cancelModalOpen.value = true
}

// -- Cancel: scheduled/live -> cancelled (full refund). Driven by the branded
//    modal; uses the `cancelling` flag (modal :loading). --
async function cancel(scope: 'this' | 'this_and_future'): Promise<void> {
  if (cancelling.value) return
  cancelling.value = true
  try {
    const updated = await cancelPractice(practiceId, scope)
    practice.value = updated
    cancelModalOpen.value = false
    toast.success(t('masterScreens.editPractice.toast.cancelledRefunded'))
    await masterStore.refreshMyPractices()
    void router.push({ name: 'master-practices' })
  } catch (e) {
    toast.error(extractApiError(e, t('masterScreens.editPractice.toast.cancelFailed')))
  } finally {
    cancelling.value = false
  }
}

// -- Confirm delete --
function confirmDelete(): void {
  confirmDialog.message = t('masterScreens.editPractice.draft.deleteConfirm')
  confirmDialog.confirmLabel = t('ui.delete')
  confirmDialog.danger = true
  confirmDialog.visible = true
  confirmDialog.onConfirm = () => {
    void remove()
  }
}

// -- Delete: draft -> deleted (soft) --
async function remove(): Promise<void> {
  if (confirmDialog.loading) return
  confirmDialog.loading = true
  try {
    await deletePractice(practiceId)
    confirmDialog.visible = false
    toast.success(t('masterScreens.editPractice.toast.draftDeleted'))
    await masterStore.refreshMyPractices()
    void router.push({ name: 'master-practices' })
  } catch (e) {
    toast.error(extractApiError(e, t('masterScreens.editPractice.toast.deleteFailed')))
  } finally {
    confirmDialog.loading = false
  }
}
</script>

<style scoped>
.edit-practice {
  min-height: 100%;
  background: transparent;
  display: flex;
  flex-direction: column;
}

.edit-practice__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-12) 0;
}

/* -- Readonly banner -- */
.edit-practice__readonly-banner {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--velo-glass-blue-15);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}

.edit-practice__readonly-text {
  font-family: var(--font-body);
  font-size: var(--velo-fs-16);
  color: var(--velo-text-muted);
}

/* -- Content -- */
.edit-practice__content {
  flex: 1;
  /* F-5 rail sync: ride MobileLayout's 24px rail (no local h-padding).
     Top trimmed to sit closer to the header (operator 2026-06-17). */
  padding: var(--space-2) 0 var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

/* -- Fieldset reset -- (flat field list; spacing via each field's own
   margin-bottom, so gap is 0 to avoid double spacing). -- */
.edit-practice__fieldset {
  border: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.edit-practice__fieldset:disabled {
  opacity: 0.6;
  pointer-events: none;
}

/* -- A labelled field outside the DS inputs: the date/time pickers
   (PracticeSchedulePicker, which owns the plate) and the audience block. -- */
.edit-practice__field {
  margin-bottom: var(--space-4);
}

.edit-practice__field-label {
  display: block;
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
  margin-bottom: var(--space-2);
}

/* -- Actions section (no "Actions" label/divider — just the buttons; operator
   EP-B2). The --space-5 content gap separates them from Save (i18n:ui.save)
   above. -- */
.edit-practice__actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* (confirm dialog now provided by <VConfirmDialog>) */
</style>
