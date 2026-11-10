<!--
  VELO Frontend -- AdminMasterReviewView (Admin DS rebuild 2026-06-14, operator SVGs
  "2 Master's request" ×5)

  Master-application review (admin). Reached by tapping a card in the Masters tab
  (i18n:adminScreens.adminMasters.masters) (admin-master-review); the master is
  handed via router state, with getMasterById as fallback. Rebuilt to the operator
  design, replacing the F8.2 layout:
    profile (avatar photo / IconIdCard glyph) →
    i18n:adminScreens.adminMasterReview.information →
    i18n:adminScreens.adminMasterReview.documents →
    i18n:adminScreens.adminMasterReview.historyTitle
    (accordion) → sticky footer i18n:adminScreens.adminMasterReview.rejectAction /
    i18n:adminScreens.adminMasterReview.approve.

  DATA. Real: name · avatar · status · verify (verifyMaster) / reject (rejectMaster —
  reason collected in a DS bottom-sheet, operator fork p.1=A 2026-06-14).

  Footer only for master_status==='pending'; processed applications show a note. After
  verify/reject → router.push({ name: 'admin-masters' }) (S-1/S-2: fresh list mount).

  PROMOTE-ON-VERIFY (PROMPT №505): a custom/unmatched method in the applicant's own
  methods pauses i18n:adminScreens.adminMasterReview.approve on a confirm dialog --
  mirrors AdminMethodRequestsView's identical promote-on-approve dialog verbatim
  (same VConfirmDialog, same copy).
  Confirming (i18n:adminScreens.adminMasterReview.addToCatalog) or
  dismissing/cancelling (i18n:adminScreens.adminMasterReview.thisMasterOnly)
  both still verify -- never blocks. Closes the loop: verify_master (backend, PROMPT
  №503 commit 3) already accepted `promote`, but nothing on any screen could ever
  send it -- this is the first and only caller.
-->

<template>
  <div class="mreview">
    <header class="mreview__top">
      <VBackButton @click="router.back()" />
      <h1 class="mreview__title">{{ t('adminScreens.adminMasterReview.applicationTitle') }}</h1>
    </header>

    <div v-if="loading" class="mreview__loader"><VLoader size="lg" /></div>

    <!-- Error (SW7): distinct from "not found" -- retry, not a dead end. -->
    <VEmptyState
      v-else-if="error"
      icon="warning"
      :title="t('common.loadError')"
      :description="error"
    >
      <VButton size="sm" variant="outline" @click="loadMaster">{{ t('common.retry') }}</VButton>
    </VEmptyState>

    <template v-else-if="master">
      <!-- Profile -->
      <VCard class="mreview__profile" padding="none">
        <img
          v-if="master.avatar_url"
          :src="master.avatar_url"
          :alt="displayName"
          class="mreview__photo"
        />
        <span v-else class="mreview__glyph"><IconIdCard :size="104" /></span>
        <div class="mreview__name">{{ displayName }}</div>
        <div class="mreview__email">{{ email }}</div>
      </VCard>

      <!-- Information (i18n:adminScreens.adminMasterReview.information) — every
           master-authored field is admin-editable (batch H). TWO distinct names:
           display name (i18n:adminScreens.adminMasterReview.displayNameTitle =
           data.profile.display_name, shown to users) vs account name
           (i18n:adminScreens.adminMasterReview.accountNameTitle =
           User.first/last, shown in admin lists). -->
      <div class="mreview__seclabel">{{ t('adminScreens.adminMasterReview.information') }}</div>
      <VCard class="mreview__info" padding="none">
        <!-- Display name (i18n:adminScreens.adminMasterReview.displayNameTitle) = data.profile.display_name (text) -->
        <EditableFieldRow
          :label="t('adminScreens.adminMasterReview.displayNameTitle')"
          :edit-label="t('adminScreens.adminMasterReview.edit.displayName')"
          v-bind="rowBind('display_name')"
          @start="startField('display_name')"
          @cancel="cancelField"
          @save="saveField"
        >
          <template #edit>
            <VInput
              v-model="draftText"
              :placeholder="t('adminScreens.adminMasterReview.fields.displayName')"
              :error="fieldError"
            />
          </template>
          {{ displayNameField }}
        </EditableFieldRow>

        <!-- Account name (i18n:adminScreens.adminMasterReview.accountNameTitle) = User.first_name / last_name (two-part text) -->
        <EditableFieldRow
          :label="t('adminScreens.adminMasterReview.accountNameTitle')"
          :edit-label="t('adminScreens.adminMasterReview.edit.accountName')"
          :error="fieldError"
          v-bind="rowBind('account_name')"
          @start="startField('account_name')"
          @cancel="cancelField"
          @save="saveField"
        >
          <template #edit>
            <VInput
              v-model="draftFirst"
              :placeholder="t('adminScreens.adminMasterReview.fields.firstNamePlaceholder')"
            />
            <VInput
              v-model="draftLast"
              :placeholder="t('adminScreens.adminMasterReview.fields.lastNamePlaceholder')"
            />
          </template>
          {{ accountName }}
        </EditableFieldRow>

        <!-- About (i18n:adminScreens.adminMasterReview.fields.about) = bio (textarea) -->
        <EditableFieldRow
          :label="t('adminScreens.adminMasterReview.fields.about')"
          :edit-label="t('adminScreens.adminMasterReview.edit.about')"
          :error="fieldError"
          value-class="mreview__v--bio"
          v-bind="rowBind('bio')"
          @start="startField('bio')"
          @cancel="cancelField"
          @save="saveField"
        >
          <template #edit>
            <VTextarea
              v-model="draftText"
              :placeholder="t('adminScreens.adminMasterReview.fields.aboutPlaceholder')"
              :rows="3"
            />
          </template>
          {{ bio }}
        </EditableFieldRow>

        <!-- Email (text) -->
        <EditableFieldRow
          label="Email"
          :edit-label="t('adminScreens.adminMasterReview.edit.email')"
          v-bind="rowBind('email')"
          @start="startField('email')"
          @cancel="cancelField"
          @save="saveField"
        >
          <template #edit>
            <VInput
              v-model="draftText"
              type="email"
              placeholder="you@example.com"
              :error="fieldError"
            />
          </template>
          {{ email }}
        </EditableFieldRow>

        <!-- Phone (i18n:adminScreens.adminMasterReview.phone) = text input -->
        <EditableFieldRow
          :label="t('adminScreens.adminMasterReview.phone')"
          :edit-label="t('adminScreens.adminMasterReview.edit.phone')"
          v-bind="rowBind('phone')"
          @start="startField('phone')"
          @cancel="cancelField"
          @save="saveField"
        >
          <template #edit>
            <VInput v-model="draftText" placeholder="+7…" :error="fieldError" />
          </template>
          {{ phone }}
        </EditableFieldRow>

        <!-- Experience (i18n:adminScreens.adminMasterReview.experience) = experience_years (number) -->
        <EditableFieldRow
          :label="t('adminScreens.adminMasterReview.experience')"
          :edit-label="t('adminScreens.adminMasterReview.edit.experience')"
          v-bind="rowBind('experience_years')"
          @start="startField('experience_years')"
          @cancel="cancelField"
          @save="saveField"
        >
          <template #edit>
            <VInput
              v-model="draftText"
              type="number"
              :placeholder="t('adminScreens.adminMasterReview.fields.experienceYears')"
              :error="fieldError"
            />
          </template>
          {{ experience }}
        </EditableFieldRow>

        <!-- Practice languages (i18n:adminScreens.adminMasterReview.fields.languages) = languages (chip toggle, fixed set + custom) -->
        <EditableFieldRow
          :label="t('adminScreens.adminMasterReview.fields.languages')"
          :edit-label="t('adminScreens.adminMasterReview.edit.languages')"
          :error="fieldError"
          value-class="mreview__chips"
          v-bind="rowBind('languages')"
          @start="startField('languages')"
          @cancel="cancelField"
          @save="saveField"
        >
          <template #edit>
            <div class="mreview__chips">
              <VChip
                v-for="l in languageOptions"
                :key="l"
                size="md"
                clickable
                :active="draftLangs.includes(l)"
                @click="toggleDraft(draftLangs, l)"
              >
                {{ l }}
              </VChip>
            </div>
          </template>
          <VChip v-for="l in languages" :key="l" size="md">{{ l }}</VChip>
          <span v-if="!languages.length" class="mreview__muted">—</span>
        </EditableFieldRow>

        <!-- Practice directions (i18n:adminScreens.adminMasterReview.fields.directions) = methods (chip toggle, own endpoint, unchanged) -->
        <EditableFieldRow
          :label="t('adminScreens.adminMasterReview.fields.directions')"
          :edit-label="t('adminScreens.adminMasterReview.edit.directions')"
          variant="methods"
          :editing="editingMethods"
          :saving="savingMethods"
          :error="methodsError"
          :save-label="t('adminScreens.adminMasterReview.save')"
          @start="startMethods"
          @cancel="cancelMethods"
          @save="saveMethods"
        >
          <template #edit>
            <!-- T4/F2-F6 (PROMPT №409): swapped the flat legacy AVAILABLE_METHODS
                 toggle for the writable two-level picker, mirroring the swap
                 already done in EditProfileView.vue -- an admin can now pick a
                 fresh direction→style pair from the R5 DB catalog, not just
                 toggle among pre-existing flat strings. -->
            <MethodTaxonomyPicker v-model="methodsDraft" />
          </template>
          <!-- Q2: render the flat direction — style methods as the batch-L
               two-level readonly picker (direction heading + style chips) so both
               direction AND style show. Fully-legacy methods that don't map to
               the taxonomy fall back to verbatim chips; empty → «—». -->
          <MethodTaxonomyPicker v-if="hasParsedMethods" :model-value="methods" readonly />
          <div v-else-if="methods.length" class="mreview__chips">
            <VChip v-for="m in methods" :key="m" size="md">{{ m }}</VChip>
          </div>
          <span v-else class="mreview__muted">—</span>
        </EditableFieldRow>

        <!-- Certificates (i18n:adminScreens.adminMasterReview.certificates) = certifications (free-text add/remove chips). -->
        <EditableFieldRow
          :label="t('adminScreens.adminMasterReview.certificates')"
          :edit-label="t('adminScreens.adminMasterReview.edit.certificates')"
          :error="fieldError"
          value-class="mreview__chips"
          v-bind="rowBind('certifications')"
          @start="startField('certifications')"
          @cancel="cancelField"
          @save="saveField"
        >
          <template #edit>
            <div v-if="draftCerts.length" class="mreview__chips">
              <VChip
                v-for="(c, i) in draftCerts"
                :key="`${c}-${i}`"
                size="md"
                clickable
                @click="draftCerts.splice(i, 1)"
              >
                {{ c }} ✕
              </VChip>
            </div>
            <div class="mreview__cert-add">
              <VInput
                v-model="certInput"
                :placeholder="t('adminScreens.adminMasterReview.certificateEnter')"
                @keydown.enter.prevent="addCert"
              />
              <VButton variant="ghost" size="sm" :disabled="!certInput.trim()" @click="addCert">{{
                t('ui.add')
              }}</VButton>
            </div>
          </template>
          <VChip v-for="(c, i) in certifications" :key="`${c}-${i}`" size="md">{{ c }}</VChip>
          <span v-if="!certifications.length" class="mreview__muted">—</span>
        </EditableFieldRow>
      </VCard>

      <!-- Documents (i18n:adminScreens.adminMasterReview.documents) -->
      <div class="mreview__seclabel">{{ t('adminScreens.adminMasterReview.documents') }}</div>
      <VCard v-if="documents.length" class="mreview__docs" padding="none">
        <div v-for="d in documents" :key="d.name" class="mreview__doc">
          <span class="mreview__doc-chk">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.9" />
              <path
                d="M7.5 12.5l3 3L17 9"
                stroke="currentColor"
                stroke-width="1.9"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </span>
          <span class="mreview__doc-name">{{ d.name }}</span>
          <button
            type="button"
            class="mreview__doc-eye"
            :aria-label="t('adminScreens.adminMasterReview.viewDocument')"
            @click="viewDoc"
          >
            <IconView :size="22" />
          </button>
        </div>
      </VCard>
      <VCard v-else
        ><p class="mreview__empty">
          {{ t('adminScreens.adminMasterReview.noDocuments') }}
        </p></VCard
      >

      <!-- Application history (i18n:adminScreens.adminMasterReview.historyTitle) -->
      <VCard class="mreview__hist" padding="none">
        <VAccordion :title="t('adminScreens.adminMasterReview.historyTitle')">
          <template #icon><IconClock :size="20" /></template>
          <template #chevron="{ open }">
            <svg
              class="mreview__acc-ch"
              :class="{ 'mreview__acc-ch--open': open }"
              width="20"
              height="12"
              viewBox="0 0 24 14"
              fill="none"
            >
              <path
                d="M2 2l10 10L22 2"
                stroke="currentColor"
                stroke-width="3"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </template>
          <div v-for="(h, i) in history" :key="i" class="mreview__hist-entry">
            <div class="mreview__hist-when">{{ h.when }}</div>
            <div class="mreview__hist-title">{{ h.title }}</div>
            <div v-if="h.comment" class="mreview__hist-q">«{{ h.comment }}»</div>
          </div>
          <p v-if="!history.length" class="mreview__first">
            {{ t('adminScreens.adminMasterReview.firstApplication') }}
          </p>
        </VAccordion>
      </VCard>

      <!-- Actions -->
      <div v-if="isPending" class="mreview__foot">
        <!-- BE-18: verification and the school-founding right are TWO
             decisions in one dialog -- the checkbox defaults to no, and an
             absent/false tick writes nothing at all. The right can be granted
             or taken back later on the verified screen, without a second
             verification. -->
        <VCheckbox
          v-model="grantSchools"
          class="mreview__grant-check"
          :label="t('adminScreens.adminMasterReview.allowSchoolCreation')"
        />
        <VButton variant="ghost" :disabled="anyLoading" @click="openReject">{{
          t('adminScreens.adminMasterReview.rejectAction')
        }}</VButton>
        <VButton variant="primary" :loading="verifying" :disabled="anyLoading" @click="onVerify">
          {{ t('adminScreens.adminMasterReview.approve') }}
        </VButton>
      </div>
      <template v-else>
        <VCard class="mreview__processed">
          {{ t('adminScreens.adminMasterReview.alreadyProcessed') }}
          <strong>{{ statusLabel }}</strong>
        </VCard>
        <!-- A1: revoke a verified master (soft-freeze, data preserved) -->
        <div v-if="isVerified" class="mreview__foot">
          <!-- BE-18: the right toggle for an ALREADY-verified master --
               verify only admits pending applications, so this is the only
               lever for the master verified yesterday. Idempotent both ways;
               revoking closes NEW schools only, everything already owned
               keeps living (that lever is the revoke-master button below,
               i18n:adminScreens.adminMasterReview.revokeMaster). -->
          <div class="mreview__right">
            <div>
              <div class="mreview__k">
                {{ t('adminScreens.adminMasterReview.schoolCreationRight') }}
              </div>
              <div class="mreview__v">
                {{
                  master.can_create_schools
                    ? t('adminScreens.adminMasterReview.granted')
                    : t('adminScreens.adminMasterReview.notGranted')
                }}
              </div>
            </div>
            <VButton
              variant="outline"
              size="sm"
              :loading="togglingRight"
              :disabled="anyLoading"
              @click="onToggleRight"
            >
              {{
                master.can_create_schools
                  ? t('adminScreens.adminMasterReview.revokeGrant')
                  : t('adminScreens.adminMasterReview.grantAction')
              }}
            </VButton>
          </div>
          <p class="mreview__grant-note">
            {{ t('adminScreens.adminMasterReview.grantNote') }}
          </p>
          <VButton variant="danger" :loading="revoking" :disabled="anyLoading" @click="openRevoke">
            {{ t('adminScreens.adminMasterReview.revokeMaster') }}
          </VButton>
        </div>
      </template>
    </template>

    <!-- Not found -->
    <VEmptyState
      v-else
      icon="notfound"
      :title="t('adminScreens.adminMasterReview.notFound')"
      :description="t('adminScreens.adminMasterReview.notFoundHint')"
    />

    <!-- Reject reason (bottom-sheet, fork p.1=A) -->
    <VBottomSheet
      :open="showReject"
      :title="t('adminScreens.adminMasterReview.rejectionReason')"
      :save-label="t('adminScreens.adminMasterReview.rejectCta')"
      @save="onReject"
      @close="closeReject"
    >
      <VTextarea
        v-model="rejectReason"
        :placeholder="t('adminScreens.adminMasterReview.rejectionReasonPlaceholder')"
        :rows="3"
        :error="rejectError"
      />
    </VBottomSheet>

    <!-- Revoke confirm (A1): advisory surfaced, never blocks -->
    <VConfirmDialog
      :open="showRevoke"
      :message="revokeMessage"
      :confirm-label="t('adminScreens.adminMasterReview.revoke')"
      danger
      :loading="revoking"
      @confirm="onRevoke"
      @cancel="showRevoke = false"
    />

    <!-- Custom method not in the catalog (PROMPT №505, mirrors
         AdminMethodRequestsView's identical dialog verbatim -- same copy,
         same never-blocks contract). -->
    <VConfirmDialog
      :open="showPromote"
      :message="promoteMessage"
      :confirm-label="t('adminScreens.adminMasterReview.addToCatalog')"
      :cancel-label="t('adminScreens.adminMasterReview.thisMasterOnly')"
      :loading="verifying"
      @confirm="onPromoteConfirm"
      @cancel="onPromoteCancel"
    />
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { host } from '@/platform/host'
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  VBackButton,
  VCard,
  VChip,
  VCheckbox,
  VInput,
  VTextarea,
  VButton,
  VLoader,
  VEmptyState,
  VBottomSheet,
  VConfirmDialog,
  VAccordion,
} from '@/components/ui'
import { IconIdCard, IconView, IconClock } from '@/components/icons'
import { useToast } from '@/composables/useToast'
import {
  getMasterById,
  verifyMaster,
  rejectMaster,
  editMasterMethods,
  editMasterProfile,
  getRevokePreview,
  revokeMaster,
  setMasterSchoolRight,
} from '@/api/admin'
import type {
  AdminMasterListItem,
  AdminMasterDetail,
  AdminMasterProfileUpdate,
  RevokeMasterAdvisory,
} from '@/api/admin'
import { extractApiError } from '@/composables/useApiError'
import { masterDisplayName, masterStatusLabel } from '@/utils/adminHelpers'
import { LANGUAGES } from '@/utils/languages'
import EditableFieldRow from '@/components/admin/EditableFieldRow.vue'
import MethodTaxonomyPicker from '@/components/shared/MethodTaxonomyPicker.vue'
import { parseMethods, flattenMethods, primeMethodTaxonomyCatalog } from '@/utils/methodTaxonomy'

const route = useRoute()
const router = useRouter()
const toast = useToast()

const masterId = route.params.id as string

const master = ref<AdminMasterDetail | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const verifying = ref(false)
const rejecting = ref(false)

// Methods editor (T3 — real, admin-editable via PATCH /admin/masters/:id/methods).
const editingMethods = ref(false)
const methodsDraft = ref<string[]>([])
const savingMethods = ref(false)
const methodsError = ref('')

// Reject reason sheet.
const showReject = ref(false)
const rejectReason = ref('')
const rejectError = ref('')

// Honest skeleton (operator V): rich fields are not on AdminMasterListItem → «—» /
// empty until Zod extends the endpoint. Sample data lives in the design preview only.
// Honest skeleton (operator V): email / language / documents / history are not
// on the detail endpoint yet → «—» / empty. methods / experience / bio are REAL
// (T3 — pulled from data.profile via GET /admin/masters/:id).
const PLACEHOLDER = '—'
// Account name (i18n:adminScreens.adminMasterReview.accountNameTitle) = User first/last (also the profile-card header + revoke message).
const displayName = computed<string>(() => (master.value ? masterDisplayName(master.value) : ''))
const accountName = displayName
// Display name (i18n:adminScreens.adminMasterReview.displayNameTitle) = data.profile.display_name (shown to users on the public page).
const displayNameField = computed<string>(() => master.value?.display_name || PLACEHOLDER)
// Batch H: real fields now returned by the detail endpoint.
const email = computed<string>(() => master.value?.email || PLACEHOLDER)
const phone = computed<string>(() => master.value?.phone || PLACEHOLDER)
const languages = computed<string[]>(() => master.value?.languages ?? [])
const certifications = computed<string[]>(() => master.value?.certifications ?? [])
const methods = computed<string[]>(() => master.value?.methods ?? [])
// Q2: true when at least one method maps to the direction/style taxonomy — then the
// two-level readonly picker has something to render; otherwise (fully-legacy flat
// methods) we fall back to verbatim chips so nothing vanishes.
const hasParsedMethods = computed<boolean>(
  () => flattenMethods(parseMethods(methods.value)).length > 0,
)
const experience = computed<string>(() =>
  master.value
    ? t('adminScreens.adminMasterReview.experienceYears', { n: master.value.experience_years ?? 0 })
    : PLACEHOLDER,
)
const bio = computed<string>(() => master.value?.bio || PLACEHOLDER)

// Language chip options = the fixed set + any custom the master already has, so a
// non-standard entry can be kept/removed (mirrors methodOptions).
const languageOptions = computed<string[]>(() => {
  const set = new Set<string>(LANGUAGES)
  for (const l of languages.value) set.add(l)
  return [...set]
})

const documents = ref<{ name: string }[]>([])
const history = ref<{ when: string; title: string; comment?: string }[]>([])

const isPending = computed<boolean>(() => master.value?.master_status === 'pending')
const isVerified = computed<boolean>(() => master.value?.master_status === 'verified')
const statusLabel = computed<string>(() =>
  master.value ? masterStatusLabel(master.value.master_status) : '',
)
const anyLoading = computed<boolean>(() => verifying.value || rejecting.value || revoking.value)

// -- Revoke master (A1): confirm dialog surfaces the advisory (WARN-not-block) --
const showRevoke = ref(false)
const revoking = ref(false)
const revokeAdvisory = ref<RevokeMasterAdvisory | null>(null)

const revokeMessage = computed<string>(() => {
  const base = t('adminScreens.adminMasterReview.revokeMessage', { name: displayName.value })
  const a = revokeAdvisory.value
  if (!a || !a.has_warnings) return base
  const warns: string[] = []
  if (a.scheduled_or_live_practices > 0) {
    warns.push(
      t('adminScreens.adminMasterReview.warnSchedule', { n: a.scheduled_or_live_practices }),
    )
  }
  if (a.available_cents > 0 || a.frozen_cents > 0)
    warns.push(t('adminScreens.adminMasterReview.nonZeroBalance'))
  if (a.pending_withdrawals > 0) {
    warns.push(t('adminScreens.adminMasterReview.warnWithdrawals', { n: a.pending_withdrawals }))
  }
  return t('adminScreens.adminMasterReview.revokeWarning', { base, warns: warns.join(', ') })
})

async function openRevoke(): Promise<void> {
  revokeAdvisory.value = null
  showRevoke.value = true
  // Best-effort: fill the advisory numbers into the dialog (WARN-not-block).
  try {
    revokeAdvisory.value = await getRevokePreview(masterId)
  } catch {
    // Leave the base message; the revoke itself does not depend on the preview.
  }
}

async function onRevoke(): Promise<void> {
  if (anyLoading.value) return
  revoking.value = true
  try {
    await revokeMaster(masterId)
    if (master.value) master.value.master_status = 'suspended'
    showRevoke.value = false
    toast.success(t('adminScreens.adminMasterReview.revokedToUser'))
  } catch (e) {
    toast.error(extractApiError(e, t('adminScreens.adminMasterReview.toast.revokeFailed')))
  } finally {
    revoking.value = false
  }
}

async function loadMaster(): Promise<void> {
  // The list hands a subset (AdminMasterListItem) via router state for an
  // instant paint (our `history` ref shadows the global History, so reach it
  // through window.history.state). Always fetch the detail afterwards to fill
  // the real methods / experience / bio (T3).
  const handed = (host.history.state as { master?: AdminMasterListItem }).master
  if (handed && handed.id === masterId) master.value = handed
  if (!master.value) loading.value = true
  error.value = null
  try {
    // Bug 2 fix (PROMPT №405): prime the taxonomy catalog cache alongside the
    // detail fetch so a promoted custom method already resolves to a plain
    // chip. Note: the `handed` instant-paint above can still render one frame
    // of stale (pre-catalog) chips before this resolves -- that flash predates
    // this fix and is a property of the instant-paint design, not this bug.
    const [detail] = await Promise.all([getMasterById(masterId), primeMethodTaxonomyCatalog()])
    master.value = detail
  } catch (e) {
    const msg = extractApiError(e, t('adminScreens.adminMasterReview.dataLoadError'))
    // SW7: a cold deep-link (no handed router-state, nothing on screen yet)
    // gets its own error rung with a retry, distinct from "not found" -- a
    // refresh failing on top of already-handed data stays toast-only
    // (matches AdminPracticeDetailView's T21-1 "don't blank a working page
    // over a secondary failure" convention).
    if (!master.value) {
      error.value = msg
    } else {
      toast.error(msg)
    }
  } finally {
    loading.value = false
  }
}

// -- Methods editor (T3) -- keeps its own endpoint (editMasterMethods). --
function startMethods(): void {
  editing.value = null // close any generic-field editor first
  methodsDraft.value = [...methods.value]
  methodsError.value = ''
  editingMethods.value = true
}

function cancelMethods(): void {
  if (savingMethods.value) return
  editingMethods.value = false
}

async function saveMethods(): Promise<void> {
  if (savingMethods.value) return
  methodsError.value = ''
  if (methodsDraft.value.length === 0) {
    methodsError.value = t('adminScreens.adminMasterReview.validation.chooseDirection')
    return
  }
  savingMethods.value = true
  try {
    await editMasterMethods(masterId, methodsDraft.value)
    if (master.value) master.value.methods = [...methodsDraft.value]
    editingMethods.value = false
    toast.success(t('adminScreens.adminMasterReview.toast.directionsUpdated'))
  } catch (e) {
    toast.error(extractApiError(e, t('adminScreens.adminMasterReview.toast.directionsSaveFailed')))
  } finally {
    savingMethods.value = false
  }
}

// =========================================================================
// Batch H: generic per-field editor for every OTHER master-authored field,
// wired to PATCH /admin/masters/{id}/profile (editMasterProfile). One field is
// edited at a time; each save sends only its own key (partial update).
// =========================================================================
type ProfileField =
  | 'display_name'
  | 'account_name'
  | 'bio'
  | 'email'
  | 'phone'
  | 'experience_years'
  | 'languages'
  | 'certifications'

const editing = ref<ProfileField | null>(null)
const savingField = ref(false)
const fieldError = ref('')
const draftText = ref('') // display_name / bio / email / phone / experience_years
const draftFirst = ref('') // account name
const draftLast = ref('')
const draftLangs = ref<string[]>([])
const draftCerts = ref<string[]>([])
const certInput = ref('')

function startField(field: ProfileField): void {
  editingMethods.value = false // close the methods editor first
  fieldError.value = ''
  editing.value = field
  switch (field) {
    case 'display_name':
      draftText.value = master.value?.display_name ?? ''
      break
    case 'bio':
      draftText.value = master.value?.bio ?? ''
      break
    case 'email':
      draftText.value = master.value?.email ?? ''
      break
    case 'phone':
      draftText.value = master.value?.phone ?? ''
      break
    case 'experience_years':
      draftText.value = String(master.value?.experience_years ?? 0)
      break
    case 'account_name':
      draftFirst.value = master.value?.first_name ?? ''
      draftLast.value = master.value?.last_name ?? ''
      break
    case 'languages':
      draftLangs.value = [...languages.value]
      break
    case 'certifications':
      draftCerts.value = [...certifications.value]
      certInput.value = ''
      break
  }
}

function cancelField(): void {
  if (savingField.value) return
  editing.value = null
  fieldError.value = ''
}

/** Toggle a value in a draft chip list (in-place, reactive). */
function toggleDraft(list: string[], value: string): void {
  const i = list.indexOf(value)
  if (i === -1) list.push(value)
  else list.splice(i, 1)
}

function addCert(): void {
  const v = certInput.value.trim()
  if (v && !draftCerts.value.includes(v)) draftCerts.value.push(v)
  certInput.value = ''
}

/** Send a partial patch; reflect it locally + toast.
 *
 * @returns Resolves on error with the message surfaced inline (fieldError). */
async function saveProfile(patch: AdminMasterProfileUpdate): Promise<void> {
  if (savingField.value) return
  savingField.value = true
  fieldError.value = ''
  try {
    await editMasterProfile(masterId, patch)
    if (master.value) Object.assign(master.value, patch)
    editing.value = null
    toast.success(t('ui.saved'))
  } catch (e) {
    fieldError.value = extractApiError(e, t('adminScreens.adminMasterReview.saveFailed'))
  } finally {
    savingField.value = false
  }
}

/** Props every generic row shares: whether its editor is open and the save state. */
function rowBind(field: ProfileField): { editing: boolean; saving: boolean } {
  return { editing: editing.value === field, saving: savingField.value }
}

/**
 * Build the PATCH body for the open editor from its drafts.
 *
 * @returns The patch, or null after surfacing a validation error in `fieldError`.
 */
function buildPatch(field: ProfileField): AdminMasterProfileUpdate | null {
  const text = draftText.value.trim()
  switch (field) {
    case 'display_name':
      if (!text) {
        fieldError.value = t('adminScreens.adminMasterReview.validation.enterDisplayName')
        return null
      }
      return { display_name: text }
    case 'bio':
      return { bio: text || null }
    case 'email':
      return { email: text || null }
    case 'phone':
      return { phone: text || null }
    case 'experience_years': {
      const n = Number(draftText.value)
      if (!Number.isInteger(n) || n < 0 || n > 50) {
        fieldError.value = t('adminScreens.adminMasterReview.validation.experienceRange')
        return null
      }
      return { experience_years: n }
    }
    case 'account_name':
      return {
        first_name: draftFirst.value.trim() || null,
        last_name: draftLast.value.trim() || null,
      }
    case 'languages':
      return { languages: [...draftLangs.value] }
    case 'certifications':
      return { certifications: [...draftCerts.value] }
  }
}

/** Save the field whose editor is open (the single handler of every row's save). */
async function saveField(): Promise<void> {
  if (!editing.value) return
  const patch = buildPatch(editing.value)
  if (patch) await saveProfile(patch)
}

// Stub: document viewing has no backend yet → Zod (documents are empty until then).
function viewDoc(): void {
  toast.info(t('adminScreens.adminMasterReview.documentViewUnavailable'))
}

function openReject(): void {
  rejectReason.value = ''
  rejectError.value = ''
  showReject.value = true
}

function closeReject(): void {
  showReject.value = false
}

// -- Promote-on-verify (PROMPT №505): mirrors AdminMethodRequestsView's own
// onApprove/doApprove/onPromoteConfirm/onPromoteCancel verbatim, same
// VConfirmDialog component (already imported+used on this screen for
// revoke), same copy. A custom/unmatched method in the applicant's own
// methods (parseMethods, already used for hasParsedMethods above) pauses
// verify on a confirm; dismissing (overlay tap) and the explicit
// this-master-only button (i18n:adminScreens.adminMasterReview.thisMasterOnly)
// fire the SAME `cancel` event (VConfirmDialog wraps
// VModal's @close straight into its own @cancel) -- so an accidental
// dismiss can never fail to verify, by construction, not by a separate
// guard. No custom text -> straight to doVerify(), unchanged from before.
const showPromote = ref(false)
/** FE-89: one entry per unmatched method -- promoted/scoped separately, so
 *  an application with several own methods never becomes one glued label. */
const promoteLabels = ref<string[]>([])
const promoteMessage = computed((): string => {
  const labels = promoteLabels.value
  if (labels.length <= 1) {
    return t('adminScreens.adminCommon.methodSingle', { label: labels[0] ?? '' })
  }
  return t('adminScreens.adminCommon.methodPlural', {
    labels: labels.map((l) => `«${l}»`).join(', '),
  })
})

/** BE-18: the verify-dialog tick for the school-founding right.
 *  Defaults to NO -- absent/false writes nothing on the backend, and the
 *  right stays grantable later on the verified screen. */
const grantSchools = ref(false)
/** The verified screen's right toggle (PATCH can-create-schools). */
const togglingRight = ref(false)

/** BE-18: flip the right and merge the answer into the local master row --
 *  the response carries the flag as written, so an idempotent second call
 *  reads exactly like the first. */
async function onToggleRight(): Promise<void> {
  if (!master.value || togglingRight.value) return
  togglingRight.value = true
  try {
    const res = await setMasterSchoolRight(masterId, !master.value.can_create_schools)
    master.value = { ...master.value, can_create_schools: res.can_create_schools }
    toast.success(
      res.can_create_schools
        ? t('adminScreens.adminMasterReview.toast.schoolRightGranted')
        : t('adminScreens.adminMasterReview.toast.schoolRightRevoked'),
    )
  } catch (e) {
    toast.error(extractApiError(e, t('adminScreens.adminMasterReview.grantChangeFailed')))
  } finally {
    togglingRight.value = false
  }
}

function onVerify(): void {
  if (anyLoading.value) return
  const parsed = parseMethods(methods.value)
  if (parsed.customEnabled && parsed.custom.length) {
    // FE-89: each unmatched method travels as its own label -- the old
    // joined customText scoped ONE direction named «A, B».
    promoteLabels.value = parsed.custom
    showPromote.value = true
    return
  }
  void doVerify()
}

async function doVerify(promote?: string[], masterOnly?: string[]): Promise<void> {
  verifying.value = true
  try {
    await verifyMaster(masterId, promote, masterOnly, grantSchools.value)
    toast.success(t('adminScreens.adminMasterReview.toast.verified'))
    // S-1/S-2: push to the list (fresh mount) instead of back().
    void router.push({ name: 'admin-masters' })
  } catch (e) {
    toast.error(extractApiError(e, t('adminScreens.adminMasterReview.verificationError')))
  } finally {
    verifying.value = false
    showPromote.value = false
  }
}

/** Add-to-catalog confirm (i18n:adminScreens.adminMasterReview.addToCatalog) --
 *  verify AND promote the custom labels (each its own catalog row). */
function onPromoteConfirm(): void {
  void doVerify([...promoteLabels.value])
}

/** This-master-only cancel (i18n:adminScreens.adminMasterReview.thisMasterOnly;
 *  or the dialog dismissed) -- verify, scoped to this
 *  master only (T22-6, PROMPT №561): a real taxonomy row per label, just not
 *  a shared one -- was silently nothing before this. FE-89: per-label. */
function onPromoteCancel(): void {
  void doVerify(undefined, [...promoteLabels.value])
}

async function onReject(): Promise<void> {
  if (anyLoading.value) return
  rejectError.value = ''
  if (!rejectReason.value.trim()) {
    rejectError.value = t('adminScreens.adminMasterReview.rejectionReasonHint')
    return
  }
  rejecting.value = true
  try {
    await rejectMaster(masterId, rejectReason.value.trim())
    toast.success(t('adminScreens.adminMasterReview.toast.requestRejected'))
    showReject.value = false
    // S-1/S-2: push to the list (fresh mount) instead of back().
    void router.push({ name: 'admin-masters' })
  } catch (e) {
    toast.error(extractApiError(e, t('adminScreens.adminMasterReview.toast.rejectFailed')))
  } finally {
    rejecting.value = false
  }
}

onMounted(loadMaster)
</script>

<style scoped>
.mreview {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.mreview__top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: var(--velo-size-44);
}

.mreview__title {
  font-family: var(--font-body);
  font-weight: 400;
  font-size: var(--velo-fs-16);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.mreview__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-8) 0;
}

/* -- Profile -- */
.mreview__profile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-5) var(--space-4);
}

.mreview__photo {
  width: var(--velo-size-104);
  height: var(--velo-size-104);
  border-radius: var(--velo-radius-14);
  object-fit: cover;
  margin-bottom: var(--space-2);
}

.mreview__glyph {
  display: flex;
  color: var(--velo-blue-200);
  margin-bottom: var(--space-2);
}

.mreview__name {
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.mreview__email {
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
}

/* -- Section label -- */
.mreview__seclabel {
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: var(--velo-gap-2) var(--velo-gap-2) calc(-1 * var(--velo-gap-6));
}

/* -- Information -- */
.mreview__info {
  padding: var(--space-1) var(--velo-inset-row);
}

.mreview__k {
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
}

.mreview__v {
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin-top: var(--velo-gap-3);
}

/* -- Methods (practice directions) display + editor (T3) -- */
.mreview__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.mreview__muted {
  color: var(--velo-text-muted);
}

/* -- Batch H: generic per-field inline editor (text / number / chips) -- */
.mreview__cert-add {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

.mreview__cert-add :deep(.v-input) {
  flex: 1;
}

/* -- Documents -- */
.mreview__docs {
  display: flex;
  flex-direction: column;
  gap: var(--velo-gap-11);
  padding: var(--space-3) var(--velo-gap-15);
}

.mreview__doc {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  height: var(--velo-size-44);
  padding: 0 var(--space-3);
  border-radius: var(--velo-radius-9);
  background: var(--velo-glass-teal-30);
  border: var(--velo-border-width) solid var(--velo-teal-400);
  color: var(--velo-teal-700);
}

.mreview__doc-chk {
  display: flex;
  flex-shrink: 0;
}

.mreview__doc-name {
  flex: 1;
  min-width: 0;
  font-size: var(--velo-fs-18);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mreview__doc-eye {
  display: flex;
  flex-shrink: 0;
  padding: 0;
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
}

.mreview__empty {
  margin: 0;
  text-align: center;
  color: var(--velo-text-muted);
  font-size: var(--velo-fs-16);
  padding: var(--space-3) var(--space-2);
}

/* -- Application history (accordion) -- */
.mreview__hist {
  overflow: hidden;
}

/* History uses the shared VAccordion (extended with #icon + #chevron slots).
   These :deep overrides preserve this screen's design (row padding, icon+title
   gap, base-size title, warning-tint body) without touching the DS default. */
:deep(.v-accordion) {
  border-bottom: none;
}

:deep(.v-accordion__header) {
  padding: var(--velo-gap-15) var(--velo-inset-row);
  font-size: var(--velo-fs-18);
}

:deep(.v-accordion__lead) {
  gap: var(--velo-gap-21);
}

:deep(.v-accordion__title) {
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

:deep(.v-accordion__icon),
:deep(.v-accordion__arrow) {
  color: var(--velo-text-primary);
}

:deep(.v-accordion__body) {
  padding: 0 var(--space-4) var(--space-4);
}

/* Slotted chevron (down-caret) — its own 180° open rotation. */
.mreview__acc-ch {
  flex-shrink: 0;
  color: var(--velo-text-primary);
  transition: transform var(--transition-fast);
}

.mreview__acc-ch--open {
  transform: rotate(180deg);
}

.mreview__hist-entry {
  background: var(--velo-warning-bg);
  border-radius: var(--radius-md);
  padding: var(--velo-inset-row) var(--velo-gap-15);
}

.mreview__hist-entry + .mreview__hist-entry {
  margin-top: var(--space-2);
}

.mreview__hist-when {
  font-size: var(--velo-fs-14);
  color: var(--velo-peach-500);
  letter-spacing: 0.02em;
}

.mreview__hist-title {
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin-top: var(--space-2);
}

.mreview__hist-q {
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
  margin-top: var(--velo-gap-6);
  line-height: 1.35;
}

.mreview__first {
  margin: 0;
  font-size: var(--velo-fs-14);
  color: var(--velo-text-muted);
  letter-spacing: 0.02em;
}

/* -- Sticky action footer (pending only) -- */
.mreview__foot {
  position: sticky;
  bottom: 0;
  z-index: var(--z-sticky);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--velo-gap-15);
  margin-top: var(--space-1);
  padding: var(--space-3) 0;
  /* Soft scrim so the content fades under the floating glass buttons. */
  background: linear-gradient(to top, var(--velo-bg-start) 55%, transparent);
}

.mreview__foot :deep(.v-btn) {
  flex: 1;
}

/* Q-GRANT=B note: full-width line above the buttons (they keep their row). */
.mreview__grant-note {
  flex-basis: 100%;
  margin: 0;
  font-size: var(--velo-fs-14);
  line-height: 1.5;
  color: var(--velo-text-muted);
}

/* BE-18: the verify-dialog checkbox -- full width, above the
   reject/approve row, same slot the old grant note occupied. */
.mreview__grant-check {
  flex-basis: 100%;
}

/* BE-18: the verified screen's right row -- label left, toggle right. */
.mreview__right {
  flex-basis: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

/* -- Processed (non-pending) note -- */
.mreview__processed {
  text-align: center;
  font-size: var(--velo-fs-16);
  color: var(--velo-text-muted);
}
</style>
