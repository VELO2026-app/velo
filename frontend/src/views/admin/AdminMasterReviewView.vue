<!--
  VELO Frontend -- AdminMasterReviewView (Admin DS rebuild 2026-06-14, operator SVGs
  "2 Master's request" ×5)

  Master-application review (admin). Reached by tapping a card in the «Мастера» tab
  (admin-master-review); the master is handed via router state, with getMasterById as
  fallback. Rebuilt to the operator design, replacing the F8.2 layout:
    profile (avatar photo / IconIdCard glyph) → «Информация» (Направление/Вид editable,
    Опыт/Язык/О себе read) → «Документы» (verified file rows) → «История заявок»
    (accordion) → sticky footer Отклонить / Одобрить.

  DATA. Real: name · avatar · status · verify (verifyMaster) / reject (rejectMaster —
  reason collected in a DS bottom-sheet, operator fork п.1=А 2026-06-14).
  STUB «—»/empty (honest skeleton, operator В): direction · type · experience · language ·
  bio · documents · history · email are NOT in AdminMasterListItem, so they render «—» /
  empty until Zod extends GET /admin/masters/:id. Editing Направление/Вид has no save
  endpoint → «ОК» toasts «недоступно» (build-full-design-now). Roadmap (Zod): extend the
  master-detail endpoint (profile fields + documents[] + submission history + email) +
  an admin edit-master-fields endpoint.

  Footer only for master_status==='pending'; processed applications show a note. After
  verify/reject → router.push({ name: 'admin-masters' }) (S-1/S-2: fresh list mount).

  PROMOTE-ON-VERIFY (ПРОМТ №505): a custom/unmatched method in the applicant's own
  methods pauses «Одобрить» on a confirm dialog -- mirrors AdminMethodRequestsView's
  identical promote-on-approve dialog verbatim (same VConfirmDialog, same copy).
  Confirming ("Добавить в каталог") or dismissing/cancelling ("Только этому мастеру")
  both still verify -- never blocks. Closes the loop: verify_master (backend, ПРОМТ
  №503 commit 3) already accepted `promote`, but nothing on any screen could ever
  send it -- this is the first and only caller.
-->

<template>
  <div class="mreview">
    <header class="mreview__top">
      <VBackButton @click="router.back()" />
      <span class="mreview__title">Заявка мастера</span>
    </header>

    <div v-if="loading" class="mreview__loader"><VLoader size="lg" /></div>

    <!-- Error (SW7): distinct from "not found" -- retry, not a dead end. -->
    <VEmptyState
      v-else-if="error"
      icon="warning"
      title="Ошибка загрузки"
      :description="error"
    >
      <VButton size="sm" variant="outline" @click="loadMaster">Повторить</VButton>
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

      <!-- Информация — every master-authored field is admin-editable (batch H).
           TWO distinct names: «Имя-визитка» (data.profile.display_name, shown to
           users) vs «Имя аккаунта» (User.first/last, shown in admin lists). -->
      <div class="mreview__seclabel">Информация</div>
      <VCard class="mreview__info" padding="none">
        <!-- Имя-визитка = data.profile.display_name (text) -->
        <div class="mreview__row">
          <div class="mreview__k">Имя-визитка</div>
          <template v-if="editing === 'display_name'">
            <div class="mreview__edit">
              <VInput v-model="draftText" placeholder="Имя, видимое пользователям" :error="fieldError" />
              <div class="mreview__edit-actions">
                <VButton variant="ghost" size="sm" :disabled="savingField" @click="cancelField">Отмена</VButton>
                <VButton variant="primary" size="sm" :loading="savingField" @click="saveDisplayName">Сохранить</VButton>
              </div>
            </div>
          </template>
          <template v-else>
            <div class="mreview__v">{{ displayNameField }}</div>
            <button type="button" class="mreview__pen" aria-label="Изменить имя-визитку" @click="startField('display_name')"><IconEdit :size="22" /></button>
          </template>
        </div>

        <!-- Имя аккаунта = User.first_name / last_name (two-part text) -->
        <div class="mreview__row">
          <div class="mreview__k">Имя аккаунта</div>
          <template v-if="editing === 'account_name'">
            <div class="mreview__edit">
              <VInput v-model="draftFirst" placeholder="Имя" />
              <VInput v-model="draftLast" placeholder="Фамилия" />
              <p v-if="fieldError" class="mreview__edit-err">{{ fieldError }}</p>
              <div class="mreview__edit-actions">
                <VButton variant="ghost" size="sm" :disabled="savingField" @click="cancelField">Отмена</VButton>
                <VButton variant="primary" size="sm" :loading="savingField" @click="saveAccountName">Сохранить</VButton>
              </div>
            </div>
          </template>
          <template v-else>
            <div class="mreview__v">{{ accountName }}</div>
            <button type="button" class="mreview__pen" aria-label="Изменить имя аккаунта" @click="startField('account_name')"><IconEdit :size="22" /></button>
          </template>
        </div>

        <!-- О себе = bio (textarea) -->
        <div class="mreview__row">
          <div class="mreview__k">О себе</div>
          <template v-if="editing === 'bio'">
            <div class="mreview__edit">
              <VTextarea v-model="draftText" placeholder="О себе" :rows="3" />
              <p v-if="fieldError" class="mreview__edit-err">{{ fieldError }}</p>
              <div class="mreview__edit-actions">
                <VButton variant="ghost" size="sm" :disabled="savingField" @click="cancelField">Отмена</VButton>
                <VButton variant="primary" size="sm" :loading="savingField" @click="saveBio">Сохранить</VButton>
              </div>
            </div>
          </template>
          <template v-else>
            <div class="mreview__v mreview__v--bio">{{ bio }}</div>
            <button type="button" class="mreview__pen" aria-label="Изменить о себе" @click="startField('bio')"><IconEdit :size="22" /></button>
          </template>
        </div>

        <!-- Email (text) -->
        <div class="mreview__row">
          <div class="mreview__k">Email</div>
          <template v-if="editing === 'email'">
            <div class="mreview__edit">
              <VInput v-model="draftText" type="email" placeholder="you@example.com" :error="fieldError" />
              <div class="mreview__edit-actions">
                <VButton variant="ghost" size="sm" :disabled="savingField" @click="cancelField">Отмена</VButton>
                <VButton variant="primary" size="sm" :loading="savingField" @click="saveEmail">Сохранить</VButton>
              </div>
            </div>
          </template>
          <template v-else>
            <div class="mreview__v">{{ email }}</div>
            <button type="button" class="mreview__pen" aria-label="Изменить email" @click="startField('email')"><IconEdit :size="22" /></button>
          </template>
        </div>

        <!-- Телефон (text) -->
        <div class="mreview__row">
          <div class="mreview__k">Телефон</div>
          <template v-if="editing === 'phone'">
            <div class="mreview__edit">
              <VInput v-model="draftText" placeholder="+7…" :error="fieldError" />
              <div class="mreview__edit-actions">
                <VButton variant="ghost" size="sm" :disabled="savingField" @click="cancelField">Отмена</VButton>
                <VButton variant="primary" size="sm" :loading="savingField" @click="savePhone">Сохранить</VButton>
              </div>
            </div>
          </template>
          <template v-else>
            <div class="mreview__v">{{ phone }}</div>
            <button type="button" class="mreview__pen" aria-label="Изменить телефон" @click="startField('phone')"><IconEdit :size="22" /></button>
          </template>
        </div>

        <!-- Опыт = experience_years (number) -->
        <div class="mreview__row">
          <div class="mreview__k">Опыт</div>
          <template v-if="editing === 'experience_years'">
            <div class="mreview__edit">
              <VInput v-model="draftText" type="number" placeholder="Лет опыта (0–50)" :error="fieldError" />
              <div class="mreview__edit-actions">
                <VButton variant="ghost" size="sm" :disabled="savingField" @click="cancelField">Отмена</VButton>
                <VButton variant="primary" size="sm" :loading="savingField" @click="saveExperience">Сохранить</VButton>
              </div>
            </div>
          </template>
          <template v-else>
            <div class="mreview__v">{{ experience }}</div>
            <button type="button" class="mreview__pen" aria-label="Изменить опыт" @click="startField('experience_years')"><IconEdit :size="22" /></button>
          </template>
        </div>

        <!-- Язык практик = languages (chip toggle, fixed set + custom) -->
        <div class="mreview__row">
          <div class="mreview__k">Язык практик</div>
          <template v-if="editing === 'languages'">
            <div class="mreview__edit">
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
              <p v-if="fieldError" class="mreview__edit-err">{{ fieldError }}</p>
              <div class="mreview__edit-actions">
                <VButton variant="ghost" size="sm" :disabled="savingField" @click="cancelField">Отмена</VButton>
                <VButton variant="primary" size="sm" :loading="savingField" @click="saveLanguages">Сохранить</VButton>
              </div>
            </div>
          </template>
          <template v-else>
            <div class="mreview__v mreview__chips">
              <VChip v-for="l in languages" :key="l" size="md">{{ l }}</VChip>
              <span v-if="!languages.length" class="mreview__muted">—</span>
            </div>
            <button type="button" class="mreview__pen" aria-label="Изменить языки" @click="startField('languages')"><IconEdit :size="22" /></button>
          </template>
        </div>

        <!-- Направления практик = methods (chip toggle, own endpoint, unchanged) -->
        <div class="mreview__row">
          <div class="mreview__k">Направления практик</div>
          <div v-if="editingMethods" class="mreview__methods-edit">
            <!-- T4/F2-F6 (ПРОМТ №409): swapped the flat legacy AVAILABLE_METHODS
                 toggle for the writable two-level picker, mirroring the swap
                 already done in EditProfileView.vue -- an admin can now pick a
                 fresh Направление→Вид pair from the R5 DB catalog, not just
                 toggle among pre-existing flat strings. -->
            <MethodTaxonomyPicker v-model="methodsDraft" />
            <p v-if="methodsError" class="mreview__methods-err">{{ methodsError }}</p>
            <div class="mreview__methods-actions">
              <VButton variant="ghost" size="sm" :disabled="savingMethods" @click="cancelMethods">
                Отмена
              </VButton>
              <VButton variant="primary" size="sm" :loading="savingMethods" @click="saveMethods">
                Сохранить
              </VButton>
            </div>
          </div>
          <template v-else>
            <div class="mreview__v">
              <!-- Q2: render the flat «Направление — Вид» methods as the batch-L
                   two-level readonly picker (direction heading + вид chips) so both
                   направление AND вид show. Fully-legacy methods that don't map to
                   the taxonomy fall back to verbatim chips; empty → «—». -->
              <MethodTaxonomyPicker v-if="hasParsedMethods" :model-value="methods" readonly />
              <div v-else-if="methods.length" class="mreview__chips">
                <VChip v-for="m in methods" :key="m" size="md">{{ m }}</VChip>
              </div>
              <span v-else class="mreview__muted">—</span>
            </div>
            <button
              type="button"
              class="mreview__pen"
              aria-label="Изменить направления"
              @click="startMethods"
            >
              <IconEdit :size="22" />
            </button>
          </template>
        </div>

        <!-- Сертификаты = certifications (free-text add/remove chips) -->
        <div class="mreview__row">
          <div class="mreview__k">Сертификаты</div>
          <template v-if="editing === 'certifications'">
            <div class="mreview__edit">
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
                <VInput v-model="certInput" placeholder="Добавить сертификат + Enter" @keydown.enter.prevent="addCert" />
                <VButton variant="ghost" size="sm" :disabled="!certInput.trim()" @click="addCert">Добавить</VButton>
              </div>
              <p v-if="fieldError" class="mreview__edit-err">{{ fieldError }}</p>
              <div class="mreview__edit-actions">
                <VButton variant="ghost" size="sm" :disabled="savingField" @click="cancelField">Отмена</VButton>
                <VButton variant="primary" size="sm" :loading="savingField" @click="saveCertifications">Сохранить</VButton>
              </div>
            </div>
          </template>
          <template v-else>
            <div class="mreview__v mreview__chips">
              <VChip v-for="(c, i) in certifications" :key="`${c}-${i}`" size="md">{{ c }}</VChip>
              <span v-if="!certifications.length" class="mreview__muted">—</span>
            </div>
            <button type="button" class="mreview__pen" aria-label="Изменить сертификаты" @click="startField('certifications')"><IconEdit :size="22" /></button>
          </template>
        </div>
      </VCard>

      <!-- Документы -->
      <div class="mreview__seclabel">Документы</div>
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
            aria-label="Посмотреть документ"
            @click="viewDoc"
          >
            <IconView :size="22" />
          </button>
        </div>
      </VCard>
      <VCard v-else><p class="mreview__empty">Документы не приложены</p></VCard>

      <!-- История заявок -->
      <VCard class="mreview__hist" padding="none">
        <VAccordion title="История заявок">
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
          <p v-if="!history.length" class="mreview__first">Заявка подаётся впервые.</p>
        </VAccordion>
      </VCard>

      <!-- Actions -->
      <div v-if="isPending" class="mreview__foot">
        <VButton variant="ghost" :disabled="anyLoading" @click="openReject">Отклонить</VButton>
        <VButton variant="primary" :loading="verifying" :disabled="anyLoading" @click="onVerify">
          Одобрить
        </VButton>
      </div>
      <template v-else>
        <VCard class="mreview__processed">
          Заявка уже обработана — статус: <strong>{{ statusLabel }}</strong>
        </VCard>
        <!-- A1: revoke a verified master (soft-freeze, data preserved) -->
        <div v-if="isVerified" class="mreview__foot">
          <VButton
            variant="danger"
            :loading="revoking"
            :disabled="anyLoading"
            @click="openRevoke"
          >
            Отозвать мастера
          </VButton>
        </div>
      </template>
    </template>

    <!-- Not found -->
    <VEmptyState
      v-else
      icon="notfound"
      title="Заявка не найдена"
      description="Возможно, она была удалена или уже обработана"
    />

    <!-- Reject reason (bottom-sheet, fork п.1=А) -->
    <VBottomSheet
      :open="showReject"
      title="Причина отказа"
      save-label="Отклонить заявку"
      @save="onReject"
      @close="closeReject"
    >
      <VTextarea
        v-model="rejectReason"
        placeholder="Укажите причину отклонения заявки"
        :rows="3"
        :error="rejectError"
      />
    </VBottomSheet>

    <!-- Revoke confirm (A1): advisory surfaced, never blocks -->
    <VConfirmDialog
      :open="showRevoke"
      :message="revokeMessage"
      confirm-label="Отозвать"
      danger
      :loading="revoking"
      @confirm="onRevoke"
      @cancel="showRevoke = false"
    />

    <!-- Custom method not in the catalog (ПРОМТ №505, mirrors
         AdminMethodRequestsView's identical dialog verbatim -- same copy,
         same never-blocks contract). -->
    <VConfirmDialog
      :open="showPromote"
      :message="`Метода «${promoteLabel}» нет в каталоге — добавить для всех мастеров?`"
      confirm-label="Добавить в каталог"
      cancel-label="Только этому мастеру"
      :loading="verifying"
      @confirm="onPromoteConfirm"
      @cancel="onPromoteCancel"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  VBackButton,
  VCard,
  VChip,
  VInput,
  VTextarea,
  VButton,
  VLoader,
  VEmptyState,
  VBottomSheet,
  VConfirmDialog,
  VAccordion,
} from '@/components/ui'
import { IconIdCard, IconEdit, IconView, IconClock } from '@/components/icons'
import { useToast } from '@/composables/useToast'
import {
  getMasterById,
  verifyMaster,
  rejectMaster,
  editMasterMethods,
  editMasterProfile,
  getRevokePreview,
  revokeMaster,
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

// Honest skeleton (operator В): rich fields are not on AdminMasterListItem → «—» /
// empty until Zod extends the endpoint. Sample data lives in the design preview only.
// Honest skeleton (operator В): email / language / documents / history are not
// on the detail endpoint yet → «—» / empty. methods / experience / bio are REAL
// (T3 — pulled from data.profile via GET /admin/masters/:id).
const PLACEHOLDER = '—'
// «Имя аккаунта» = User first/last (also the profile-card header + revoke msg).
const displayName = computed<string>(() => (master.value ? masterDisplayName(master.value) : ''))
const accountName = displayName
// «Имя-визитка» = data.profile.display_name (shown to users on the public page).
const displayNameField = computed<string>(() => master.value?.display_name || PLACEHOLDER)
// Batch H: real fields now returned by the detail endpoint.
const email = computed<string>(() => master.value?.email || PLACEHOLDER)
const phone = computed<string>(() => master.value?.phone || PLACEHOLDER)
const languages = computed<string[]>(() => master.value?.languages ?? [])
const certifications = computed<string[]>(() => master.value?.certifications ?? [])
const methods = computed<string[]>(() => master.value?.methods ?? [])
// Q2: true when at least one method maps to the direction/вид taxonomy — then the
// two-level readonly picker has something to render; otherwise (fully-legacy flat
// methods) we fall back to verbatim chips so nothing vanishes.
const hasParsedMethods = computed<boolean>(
  () => flattenMethods(parseMethods(methods.value)).length > 0,
)
const experience = computed<string>(() =>
  master.value ? `${master.value.experience_years ?? 0} лет` : PLACEHOLDER,
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
  const base =
    `Мастер ${displayName.value} снова станет обычным пользователем. Все данные ` +
    `(профиль, практики, история) сохраняются — доступ можно вернуть кнопкой ` +
    `«Сделать мастером».`
  const a = revokeAdvisory.value
  if (!a || !a.has_warnings) return base
  const warns: string[] = []
  if (a.scheduled_or_live_practices > 0) {
    warns.push(`${a.scheduled_or_live_practices} практик(и) в расписании`)
  }
  if (a.available_cents > 0 || a.frozen_cents > 0) warns.push('ненулевой баланс')
  if (a.pending_withdrawals > 0) {
    warns.push(`${a.pending_withdrawals} выплат(ы) в ожидании`)
  }
  return `${base} Внимание: ${warns.join(', ')} — отзыв не блокируется, данные останутся.`
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
    toast.success('Мастер отозван — аккаунт стал пользователем')
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось отозвать мастера'))
  } finally {
    revoking.value = false
  }
}

async function loadMaster(): Promise<void> {
  // The list hands a subset (AdminMasterListItem) via router state for an
  // instant paint (our `history` ref shadows the global History, so reach it
  // through window.history.state). Always fetch the detail afterwards to fill
  // the real methods / experience / bio (T3).
  const handed = (window.history.state as { master?: AdminMasterListItem }).master
  if (handed && handed.id === masterId) master.value = handed
  if (!master.value) loading.value = true
  error.value = null
  try {
    // Bug 2 fix (ПРОМТ №405): prime the taxonomy catalog cache alongside the
    // detail fetch so a promoted custom method already resolves to a plain
    // chip. Note: the `handed` instant-paint above can still render one frame
    // of stale (pre-catalog) chips before this resolves -- that flash predates
    // this fix and is a property of the instant-paint design, not this bug.
    const [detail] = await Promise.all([getMasterById(masterId), primeMethodTaxonomyCatalog()])
    master.value = detail
  } catch (e) {
    const msg = extractApiError(e, 'Ошибка загрузки данных')
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
    methodsError.value = 'Выберите хотя бы одно направление'
    return
  }
  savingMethods.value = true
  try {
    await editMasterMethods(masterId, methodsDraft.value)
    if (master.value) master.value.methods = [...methodsDraft.value]
    editingMethods.value = false
    toast.success('Направления обновлены')
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось сохранить направления'))
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

/** Send a partial patch; reflect it locally + toast. Returns on error with the
 *  message surfaced inline (fieldError). */
async function saveProfile(patch: AdminMasterProfileUpdate): Promise<void> {
  if (savingField.value) return
  savingField.value = true
  fieldError.value = ''
  try {
    await editMasterProfile(masterId, patch)
    if (master.value) Object.assign(master.value, patch)
    editing.value = null
    toast.success('Сохранено')
  } catch (e) {
    fieldError.value = extractApiError(e, 'Не удалось сохранить')
  } finally {
    savingField.value = false
  }
}

async function saveDisplayName(): Promise<void> {
  const v = draftText.value.trim()
  if (!v) {
    fieldError.value = 'Введите имя-визитку'
    return
  }
  await saveProfile({ display_name: v })
}

async function saveBio(): Promise<void> {
  await saveProfile({ bio: draftText.value.trim() || null })
}

async function saveEmail(): Promise<void> {
  await saveProfile({ email: draftText.value.trim() || null })
}

async function savePhone(): Promise<void> {
  await saveProfile({ phone: draftText.value.trim() || null })
}

async function saveExperience(): Promise<void> {
  const n = Number(draftText.value)
  if (!Number.isInteger(n) || n < 0 || n > 50) {
    fieldError.value = 'Опыт: целое число 0–50'
    return
  }
  await saveProfile({ experience_years: n })
}

async function saveAccountName(): Promise<void> {
  await saveProfile({
    first_name: draftFirst.value.trim() || null,
    last_name: draftLast.value.trim() || null,
  })
}

async function saveLanguages(): Promise<void> {
  await saveProfile({ languages: [...draftLangs.value] })
}

async function saveCertifications(): Promise<void> {
  await saveProfile({ certifications: [...draftCerts.value] })
}

// Stub: document viewing has no backend yet → Zod (documents are empty until then).
function viewDoc(): void {
  toast.info('Просмотр документа пока недоступен')
}

function openReject(): void {
  rejectReason.value = ''
  rejectError.value = ''
  showReject.value = true
}

function closeReject(): void {
  showReject.value = false
}

// -- Promote-on-verify (ПРОМТ №505): mirrors AdminMethodRequestsView's own
// onApprove/doApprove/onPromoteConfirm/onPromoteCancel verbatim, same
// VConfirmDialog component (already imported+used on this screen for
// revoke), same copy. A custom/unmatched method in the applicant's own
// methods (parseMethods, already used for hasParsedMethods above) pauses
// verify on a confirm; dismissing (overlay tap) and the explicit "Только
// этому мастеру" button fire the SAME `cancel` event (VConfirmDialog wraps
// VModal's @close straight into its own @cancel) -- so an accidental
// dismiss can never fail to verify, by construction, not by a separate
// guard. No custom text -> straight to doVerify(), unchanged from before.
const showPromote = ref(false)
const promoteLabel = ref('')

function onVerify(): void {
  if (anyLoading.value) return
  const parsed = parseMethods(methods.value)
  if (parsed.customEnabled && parsed.customText) {
    promoteLabel.value = parsed.customText
    showPromote.value = true
    return
  }
  void doVerify()
}

async function doVerify(promote?: string[], masterOnly?: string[]): Promise<void> {
  verifying.value = true
  try {
    await verifyMaster(masterId, promote, masterOnly)
    toast.success('Мастер верифицирован')
    // S-1/S-2: push to the list (fresh mount) instead of back().
    router.push({ name: 'admin-masters' })
  } catch (e) {
    toast.error(extractApiError(e, 'Ошибка верификации'))
  } finally {
    verifying.value = false
    showPromote.value = false
  }
}

/** «Добавить в каталог» -- verify AND promote the custom label. */
function onPromoteConfirm(): void {
  void doVerify([promoteLabel.value])
}

/** «Только этому мастеру» (or the dialog dismissed) -- verify, scoped to this
 *  master only (T22-6, ПРОМТ №561): a real taxonomy row, just not a shared
 *  one -- was silently nothing before this. */
function onPromoteCancel(): void {
  void doVerify(undefined, [promoteLabel.value])
}

async function onReject(): Promise<void> {
  if (anyLoading.value) return
  rejectError.value = ''
  if (!rejectReason.value.trim()) {
    rejectError.value = 'Укажите причину отказа'
    return
  }
  rejecting.value = true
  try {
    await rejectMaster(masterId, rejectReason.value.trim())
    toast.success('Заявка отклонена')
    showReject.value = false
    // S-1/S-2: push to the list (fresh mount) instead of back().
    router.push({ name: 'admin-masters' })
  } catch (e) {
    toast.error(extractApiError(e, 'Ошибка при отклонении'))
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
  font-size: var(--text-sm);
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
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.mreview__email {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
}

/* -- Section label -- */
.mreview__seclabel {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: var(--velo-gap-2) var(--velo-gap-2) calc(-1 * var(--velo-gap-6));
}

/* -- Информация -- */
.mreview__info {
  padding: var(--space-1) var(--velo-inset-row);
}

.mreview__row {
  position: relative;
  padding: var(--space-3) 0;
}

.mreview__row + .mreview__row {
  border-top: var(--velo-border-width) solid var(--velo-border);
}

.mreview__k {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
}

.mreview__v {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin-top: var(--velo-gap-3);
}

.mreview__v--bio {
  line-height: 1.35;
}

.mreview__pen {
  position: absolute;
  top: var(--space-3);
  right: 0;
  display: flex;
  padding: 0;
  background: none;
  border: none;
  color: var(--velo-primary);
  cursor: pointer;
}

/* -- Methods (Направления практик) display + editor (T3) -- */
.mreview__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.mreview__muted {
  color: var(--velo-text-muted);
}

.mreview__methods-edit {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-2);
}

.mreview__methods-err {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--velo-error);
}

.mreview__methods-actions {
  display: flex;
  gap: var(--space-2);
}

.mreview__methods-actions :deep(.v-btn) {
  flex: 1;
}

/* -- Batch H: generic per-field inline editor (text / number / chips) -- */
.mreview__edit {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-2);
}

.mreview__edit-err {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--velo-error);
}

.mreview__edit-actions {
  display: flex;
  gap: var(--space-2);
}

.mreview__edit-actions :deep(.v-btn) {
  flex: 1;
}

.mreview__cert-add {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

.mreview__cert-add :deep(.v-input) {
  flex: 1;
}

/* -- Документы -- */
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
  font-size: var(--text-base);
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
  font-size: var(--text-sm);
  padding: var(--space-3) var(--space-2);
}

/* -- История заявок (accordion) -- */
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
  font-size: var(--text-base);
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
  font-size: var(--text-xs);
  color: var(--velo-peach-500);
  letter-spacing: 0.02em;
}

.mreview__hist-title {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin-top: var(--space-2);
}

.mreview__hist-q {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
  margin-top: var(--velo-gap-6);
  line-height: 1.35;
}

.mreview__first {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--velo-text-muted);
  letter-spacing: 0.02em;
}

/* -- Sticky action footer (pending only) -- */
.mreview__foot {
  position: sticky;
  bottom: 0;
  z-index: var(--z-sticky);
  display: flex;
  gap: var(--velo-gap-15);
  margin-top: var(--space-1);
  padding: var(--space-3) 0;
  /* Soft scrim so the content fades under the floating glass buttons. */
  background: linear-gradient(to top, var(--velo-bg-start) 55%, transparent);
}

.mreview__foot :deep(.v-btn) {
  flex: 1;
}

/* -- Processed (non-pending) note -- */
.mreview__processed {
  text-align: center;
  font-size: var(--text-sm);
  color: var(--velo-text-muted);
}
</style>
