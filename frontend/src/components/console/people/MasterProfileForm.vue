<!--
  VELO Frontend -- MasterProfileForm (FE-262)

  The "Profile" card of the web master card: every master-authored field as
  a row you can edit in place, one editor open at a time. Eight fields go
  through PATCH /admin/masters/{id}/profile (each save sends only its own
  keys); the practice directions have their own endpoint
  (PATCH /admin/masters/{id}/methods) and the two-level taxonomy picker.

  A save writes the answer into the held detail at once (patchAdminMaster)
  and the mutation row refetches the lists that name the master. The mobile
  twin is the field editor of AdminMasterReviewView.

  DEBT (FE-272): the field editor is a copy of the one in AdminMasterReviewView
  (startField, cancelField, saveField, the methods editor) and its patch rules
  are masterProfilePatch.ts, a copy of the old buildPatch. Both live until the
  mobile /admin is removed; then the copy here is the only one.
-->

<template>
  <ConsoleCard :title="t('console.masters.detail.profile')">
    <div class="profile-form" data-testid="master-profile-form">
      <ConsoleFieldRow
        :label="t('adminScreens.adminMasterReview.displayNameTitle')"
        :edit-label="t('adminScreens.adminMasterReview.edit.displayName')"
        :error="fieldError"
        v-bind="rowBind('display_name')"
        @start="startField('display_name')"
        @cancel="cancelField"
        @save="saveField"
      >
        <template #edit>
          <VInput
            v-model="draftText"
            :placeholder="t('adminScreens.adminMasterReview.fields.displayName')"
          />
        </template>
        {{ master.display_name || DASH }}
      </ConsoleFieldRow>

      <ConsoleFieldRow
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
        {{ masterDisplayName(master) }}
      </ConsoleFieldRow>

      <ConsoleFieldRow
        :label="t('adminScreens.adminMasterReview.fields.about')"
        :edit-label="t('adminScreens.adminMasterReview.edit.about')"
        :error="fieldError"
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
        {{ master.bio || DASH }}
      </ConsoleFieldRow>

      <ConsoleFieldRow
        :label="t('console.masters.detail.email')"
        :edit-label="t('adminScreens.adminMasterReview.edit.email')"
        :error="fieldError"
        v-bind="rowBind('email')"
        @start="startField('email')"
        @cancel="cancelField"
        @save="saveField"
      >
        <template #edit>
          <VInput
            v-model="draftText"
            type="email"
            kind="email"
            autocomplete="off"
            placeholder="you@example.com"
          />
        </template>
        {{ master.email || DASH }}
      </ConsoleFieldRow>

      <ConsoleFieldRow
        :label="t('adminScreens.adminMasterReview.phone')"
        :edit-label="t('adminScreens.adminMasterReview.edit.phone')"
        :error="fieldError"
        v-bind="rowBind('phone')"
        @start="startField('phone')"
        @cancel="cancelField"
        @save="saveField"
      >
        <template #edit>
          <VInput v-model="draftText" kind="tel" autocomplete="off" placeholder="+7…" />
        </template>
        {{ master.phone || DASH }}
      </ConsoleFieldRow>

      <ConsoleFieldRow
        :label="t('adminScreens.adminMasterReview.experience')"
        :edit-label="t('adminScreens.adminMasterReview.edit.experience')"
        :error="fieldError"
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
          />
        </template>
        {{
          t('adminScreens.adminMasterReview.experienceYears', { n: master.experience_years ?? 0 })
        }}
      </ConsoleFieldRow>

      <ConsoleFieldRow
        :label="t('adminScreens.adminMasterReview.fields.languages')"
        :edit-label="t('adminScreens.adminMasterReview.edit.languages')"
        :error="fieldError"
        v-bind="rowBind('languages')"
        @start="startField('languages')"
        @cancel="cancelField"
        @save="saveField"
      >
        <template #edit>
          <div class="profile-form__chips">
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
        <div v-if="languages.length" class="profile-form__chips">
          <ConsoleBadge v-for="l in languages" :key="l">{{ l }}</ConsoleBadge>
        </div>
        <span v-else class="profile-form__muted">{{ DASH }}</span>
      </ConsoleFieldRow>

      <ConsoleFieldRow
        :label="t('adminScreens.adminMasterReview.fields.directions')"
        :edit-label="t('adminScreens.adminMasterReview.edit.directions')"
        :editing="editingMethods"
        :saving="savingMethods"
        :error="methodsError"
        @start="startMethods"
        @cancel="cancelMethods"
        @save="saveMethods"
      >
        <template #edit>
          <MethodTaxonomyPicker v-model="methodsDraft" />
        </template>
        <MethodTaxonomyPicker
          v-if="hasParsedMethods"
          class="profile-form__picker"
          :model-value="methods"
          readonly
        />
        <div v-else-if="methods.length" class="profile-form__chips">
          <ConsoleBadge v-for="m in methods" :key="m">{{ m }}</ConsoleBadge>
        </div>
        <span v-else class="profile-form__muted">{{ DASH }}</span>
      </ConsoleFieldRow>

      <ConsoleFieldRow
        :label="t('adminScreens.adminMasterReview.certificates')"
        :edit-label="t('adminScreens.adminMasterReview.edit.certificates')"
        :error="fieldError"
        v-bind="rowBind('certifications')"
        @start="startField('certifications')"
        @cancel="cancelField"
        @save="saveField"
      >
        <template #edit>
          <div v-if="draftCerts.length" class="profile-form__chips">
            <VChip
              v-for="(c, i) in draftCerts"
              :key="`${c}-${i}`"
              size="md"
              clickable
              :aria-label="t('console.masters.detail.removeCertificate', { name: c })"
              @click="draftCerts.splice(i, 1)"
            >
              {{ c }}
              <IconClose :size="12" aria-hidden="true" />
            </VChip>
          </div>
          <div class="profile-form__cert-add">
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
        <div v-if="certifications.length" class="profile-form__chips">
          <ConsoleBadge v-for="(c, i) in certifications" :key="`${c}-${i}`">{{ c }}</ConsoleBadge>
        </div>
        <span v-else class="profile-form__muted">{{ DASH }}</span>
      </ConsoleFieldRow>
    </div>
  </ConsoleCard>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, ref } from 'vue'
import { useQueryCache } from '@pinia/colada'
import { VButton, VChip, VInput, VTextarea } from '@/components/ui'
import { IconClose } from '@/components/icons'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import ConsoleFieldRow from '@/components/console/people/ConsoleFieldRow.vue'
import ConsoleBadge from '@/components/console/ConsoleBadge.vue'
import { DASH } from '@/components/console/people/peopleTable'
import {
  buildProfilePatch,
  type PatchProblem,
  type ProfileField,
} from '@/components/console/people/masterProfilePatch'
import MethodTaxonomyPicker from '@/components/shared/MethodTaxonomyPicker.vue'
import { editMasterMethods, editMasterProfile } from '@/api/admin'
import type { AdminMasterDetail, AdminMasterProfileUpdate } from '@/api/admin'
import { patchAdminMaster, useAdminMutation } from '@/composables/queries/admin'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { masterDisplayName } from '@/utils/adminHelpers'
import { LANGUAGES } from '@/utils/languages'
import { flattenMethods, parseMethods } from '@/utils/methodTaxonomy'

const props = defineProps<{
  /** The master as the detail endpoint answered. */
  master: AdminMasterDetail
}>()

const toast = useToast()
const queryCache = useQueryCache()

const languages = computed<string[]>(() => props.master.languages ?? [])
const certifications = computed<string[]>(() => props.master.certifications ?? [])
const methods = computed<string[]>(() => props.master.methods ?? [])
// True when a method maps to the direction/style taxonomy: then the two-level
// readonly picker has something to show; otherwise verbatim chips.
const hasParsedMethods = computed<boolean>(
  () => flattenMethods(parseMethods(methods.value)).length > 0,
)
// Language chips: the fixed set plus any custom the master already has, so a
// non-standard entry can be kept or removed.
const languageOptions = computed<string[]>(() => [
  ...new Set<string>([...LANGUAGES, ...languages.value]),
])

// -- The writes: patch the held detail at once, then the lists refetch. --
const saveProfileMutation = useAdminMutation(
  'editMasterFields',
  (patch: AdminMasterProfileUpdate) => editMasterProfile(props.master.id, patch),
  {
    write: (_res, patch) => patchAdminMaster(queryCache, props.master.id, patch),
    waitForRefetch: false,
  },
)
const saveMethodsMutation = useAdminMutation(
  'editMasterFields',
  (next: string[]) => editMasterMethods(props.master.id, next),
  {
    write: (_res, next) => patchAdminMaster(queryCache, props.master.id, { methods: [...next] }),
    waitForRefetch: false,
  },
)

// -- The directions editor (its own endpoint) --
const editingMethods = ref(false)
const methodsDraft = ref<string[]>([])
const savingMethods = ref(false)
const methodsError = ref('')

function startMethods(): void {
  editing.value = null // one editor at a time
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
    await saveMethodsMutation.mutateAsync(methodsDraft.value)
    editingMethods.value = false
    toast.success(t('adminScreens.adminMasterReview.toast.directionsUpdated'))
  } catch (e) {
    toast.error(extractApiError(e, t('adminScreens.adminMasterReview.toast.directionsSaveFailed')))
  } finally {
    savingMethods.value = false
  }
}

// -- The generic field editor: one field open, one save for every row --
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
  editingMethods.value = false // one editor at a time
  fieldError.value = ''
  editing.value = field
  const m = props.master
  switch (field) {
    case 'display_name':
      draftText.value = m.display_name ?? ''
      break
    case 'bio':
      draftText.value = m.bio ?? ''
      break
    case 'email':
      draftText.value = m.email ?? ''
      break
    case 'phone':
      draftText.value = m.phone ?? ''
      break
    case 'experience_years':
      draftText.value = String(m.experience_years ?? 0)
      break
    case 'account_name':
      draftFirst.value = m.first_name ?? ''
      draftLast.value = m.last_name ?? ''
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

/** Whether a row's editor is open, and the save state every row shares. */
function rowBind(field: ProfileField): { editing: boolean; saving: boolean } {
  return { editing: editing.value === field, saving: savingField.value }
}

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

function problemText(problem: PatchProblem): string {
  return problem === 'displayNameRequired'
    ? t('adminScreens.adminMasterReview.validation.enterDisplayName')
    : t('adminScreens.adminMasterReview.validation.experienceRange')
}

/** Save the field whose editor is open: the one handler of every row's save. */
async function saveField(): Promise<void> {
  if (!editing.value || savingField.value) return
  const built = buildProfilePatch(editing.value, {
    text: draftText.value,
    first: draftFirst.value,
    last: draftLast.value,
    languages: draftLangs.value,
    certifications: draftCerts.value,
  })
  if ('problem' in built) {
    fieldError.value = problemText(built.problem)
    return
  }
  savingField.value = true
  fieldError.value = ''
  try {
    await saveProfileMutation.mutateAsync(built.patch)
    editing.value = null
    toast.success(t('ui.saved'))
  } catch (e) {
    fieldError.value = extractApiError(e, t('adminScreens.adminMasterReview.saveFailed'))
  } finally {
    savingField.value = false
  }
}
</script>

<style scoped>
.profile-form {
  display: flex;
  flex-direction: column;
}

.profile-form__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.profile-form__cert-add {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.profile-form__muted {
  color: var(--velo-text-secondary);
}

/* The read-only summary sits in the value column like the other rows: the
   picker's own card backdrop and padding would push it off the column. */
.profile-form__picker :deep(.mtp__chip-card) {
  padding: 0;
  background: none;
  box-shadow: none;
}
</style>
