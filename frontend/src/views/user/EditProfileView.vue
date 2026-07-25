<!--
  VELO Frontend -- EditProfileView (Profile redesign Screens C + D)

  Edit-profile form (Figma node 4715:3685, 72_Edit Profile) plus the
  delete-account confirmation modal (Figma node 73, 73_Delete-confirm).

  FIELDS:
    - Name      -> first_name (real column; last_name left as-is, per the
                  master-name convention _master_full_name = first + last).
    - E-mail    -> DISABLED stub. The app has no email capture yet (see the
                  main profile screen decision); shown greyed out with a
                  "появится позже" placeholder, never sent.
    - Phone     -> credentials JSONB "phone". Soft, international validation
                  (digits/space/+()-, >=5 digits). Empty string clears it.
    - About     -> credentials JSONB "bio", max 2000 chars. Empty clears.
    - Change photo -> stub toast (no upload infra; avatar comes from Telegram).

  SAVE: collects only changed fields and sends them via updateProfile (PATCH
  /users/me). phone/bio cleared by sending "" (not null) -- matches the
  backend variant (b) semantics.

  DELETE (Screen D): the red "Удалить аккаунт" opens a confirm modal. The
  confirm action is a STUB — onConfirmDelete toasts «недоступно» and does NOT
  call any delete endpoint (real account-deletion + balance-forfeit pending
  backend; see the inline note in onConfirmDelete). deleteMe() only resets
  onboarding (not a real erase), so it is intentionally NOT wired here.

  VInput note: VInput has no `error` prop (unlike VTextarea), so the phone
  validation message is rendered as a sibling <p> under the field.

  Route: /user/profile/edit (name: 'user-edit-profile')
-->

<template>
  <div class="edit-profile">
    <VHeader title="Редактировать профиль" show-back @back="router.back()" />

    <div class="edit-profile__content">
      <!-- Avatar + change photo (stub) -->
      <div class="edit-profile__avatar-block">
        <VAvatar :name="displayName" :url="user?.avatar_url ?? undefined" size="xl" />
        <button type="button" class="edit-profile__change-photo" @click="onChangePhoto">
          Изменить фото
        </button>
      </div>

      <!-- Name + surname (two explicit fields — operator Q C2=Б) -->
      <VInput v-model="form.firstName" label="Имя" placeholder="Имя" />
      <VInput v-model="form.lastName" label="Фамилия" placeholder="Фамилия" @focus="onFieldFocus" />

      <!-- E-mail (E11: captured here — Telegram provides none) -->
      <VInput
        v-model="form.email"
        label="E-mail"
        type="email"
        placeholder="you@example.com"
        @focus="onFieldFocus"
      />
      <p v-if="emailError" class="edit-profile__field-error">{{ emailError }}</p>

      <!-- Методы практик (мастер): flat set + admin-approved change-request (M3).
           Order (L2): below Имя/Фамилия/E-mail, above Языки/О себе. -->
      <div v-if="isMaster" class="edit-profile__methods">
        <label class="edit-profile__methods-label">Методы</label>

        <!-- Pending: the proposed set is locked while an admin reviews it —
             shown in the SAME направление→вид white cards (batch L, readonly
             picker), not a flat chip row. Unmatched (custom) strings now
             surface as their own chip (Q3=А, ПРОМТ №391 — was drop, Q3=В). -->
        <template v-if="methodRequestPending">
          <MethodTaxonomyPicker :model-value="pendingProposedMethods" readonly />
          <div class="edit-profile__methods-status">
            <VBadge variant="warning">Ожидает подтверждения</VBadge>
          </div>
          <p class="edit-profile__methods-note">{{ METHOD_CHANGE_NOTE }}</p>
        </template>

        <!-- Editable: two-level направление→вид picker (batch L, shared
             MethodTaxonomyPicker), seeded from the master's current methods
             (surface-unmatched as custom, Q3=А). On submit the flat
             new-vocabulary methods[]
             goes to submitMethodChangeRequest (schema unchanged). PC3
             (2026-07-12): «Свой вариант» re-enabled (default allowCustom=true,
             same as the apply wizard) -- the custom string flows through the
             SAME flattenMethods()/submitMethodChangeRequest() path already
             used here, and the backend's proposed_methods field has no
             taxonomy validation (ShortStr list, length-only) -- it already
             accepts off-taxonomy strings pending admin approval. -->
        <template v-else>
          <MethodTaxonomyPicker v-model="selectedMethods" />
          <p v-if="methodRejectReason" class="edit-profile__methods-reject">
            Прошлый запрос отклонён: {{ methodRejectReason }}
          </p>
          <p class="edit-profile__methods-note">{{ METHOD_CHANGE_NOTE }}</p>
          <VButton
            variant="secondary"
            block
            :disabled="!methodsChanged"
            :loading="submittingMethods"
            @click="onSubmitMethods"
          >
            Отправить на проверку
          </VButton>
        </template>
      </div>

      <!-- Языки практик (мастер): freely editable, no moderation (E16, Q2=А). -->
      <div v-if="isMaster" class="edit-profile__methods">
        <label class="edit-profile__methods-label">Языки практик</label>
        <div class="edit-profile__methods-chips">
          <VChip
            v-for="l in LANGUAGES"
            :key="l"
            size="md"
            clickable
            :active="selectedLanguages.includes(l)"
            @click="toggleLanguage(l)"
          >
            {{ l }}
          </VChip>
        </div>
        <VButton
          variant="secondary"
          block
          :disabled="!languagesChanged"
          :loading="savingLanguages"
          @click="onSaveLanguages"
        >
          Сохранить языки
        </VButton>
      </div>

      <!-- About -->
      <VTextarea
        v-model="form.bio"
        label="О себе"
        :rows="4"
        placeholder="Расскажите немного о себе"
        :error="bioError"
        @focus="onFieldFocus"
      />

      <!-- Save -->
      <VButton variant="primary" block :loading="saving" @click="onSave"> Сохранить </VButton>

      <!-- Delete account (opens modal D) -->
      <button type="button" class="edit-profile__delete" @click="showDeleteModal = true">
        Удалить аккаунт
      </button>
    </div>

    <!-- ===== Screen D: delete account modal (design «Delete account») ===== -->
    <VModal :open="showDeleteModal" @close="closeDeleteModal">
      <div class="edit-profile__del">
        <h2 class="edit-profile__del-title">Удалить аккаунт?</h2>

        <div class="edit-profile__del-warning">
          <IconWarning :size="20" />
          <span>Это действие необратимо!</span>
        </div>

        <p class="edit-profile__del-intro">При удалении:</p>
        <ul class="edit-profile__del-list">
          <li>Все ваши практики будут отменены</li>
          <li>История будет удалена</li>
          <li>Доступ к статистике будет потерян</li>
        </ul>

        <template v-if="hasBalance">
          <div class="edit-profile__del-balance">На вашем балансе {{ formattedBalance }}</div>
          <VButton variant="primary" block @click="onWithdrawFirst">
            Сначала вывести средства
          </VButton>
          <VCheckbox
            v-model="delConsent"
            label="Согласен на списание остатка"
            class="edit-profile__del-consent"
          />
        </template>

        <template v-if="showConfirmField">
          <div ref="confirmFieldEl">
            <p class="edit-profile__del-confirm-hint">Введите «УДАЛИТЬ» для подтверждения</p>
            <VInput v-model="delConfirmText" placeholder="УДАЛИТЬ" />
          </div>
        </template>

        <div class="edit-profile__del-actions">
          <VButton variant="secondary" @click="closeDeleteModal">Отмена</VButton>
          <VButton variant="danger" :disabled="!canDelete" @click="onConfirmDelete">
            Удалить навсегда
          </VButton>
        </div>
      </div>
    </VModal>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, onMounted, nextTick, watch } from 'vue'
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import {
  VInput,
  VTextarea,
  VButton,
  VAvatar,
  VModal,
  VCheckbox,
  VChip,
  VBadge,
} from '@/components/ui'
import { IconWarning } from '@/components/icons'
import { useToast } from '@/composables/useToast'
import { useAuthStore } from '@/stores/auth'
import { useMasterStore } from '@/stores/master'
import { extractApiError } from '@/composables/useApiError'
import { submitMethodChangeRequest, updateMasterLanguages } from '@/api/masters'
import { formatMoney } from '@/utils/format'
import { LANGUAGES } from '@/utils/languages'
import MethodTaxonomyPicker from '@/components/shared/MethodTaxonomyPicker.vue'
import { flattenMethods, parseMethods, primeMethodTaxonomyCatalog } from '@/utils/methodTaxonomy'
import { useKeyboardFieldScroll } from '@/composables/useKeyboardFieldScroll'
import type { UserUpdate } from '@/api/types'

const router = useRouter()

// Scroll the «Фамилия» / «О себе» fields above the soft keyboard once it settles (M6).
const { onFieldFocus } = useKeyboardFieldScroll()
const toast = useToast()
const authStore = useAuthStore()
const masterStore = useMasterStore()

const user = computed(() => authStore.user)
const isMaster = computed(() => authStore.role === 'master')

// -- Master methods: two-level направление→вид picker gated by admin approval
// (batch L). Selection is held as the flat «Направление — Вид» methods[] the
// shared MethodTaxonomyPicker emits; the change-request payload/schema is
// unchanged (still a flat string[] to submitMethodChangeRequest).
const METHOD_CHANGE_NOTE =
  'Изменение методов практики требует подтверждения администратора. ' +
  'Запрос отправляется автоматически. Обработка запроса обычно занимает ' +
  'не более 3 рабочих дней.'

// The master's current live methods (from the profile).
const currentMethods = computed((): string[] => masterStore.profile?.methods ?? [])

// Normalised current = the live methods run through the two-level taxonomy
// (drop-unmatched, Q3). This is the baseline the picker seeds to and that
// `methodsChanged` compares against — so opening the screen shows «no change»
// even when the stored set contained strings outside the taxonomy.
const normalizedCurrent = computed((): string[] => flattenMethods(parseMethods(currentMethods.value)))

// The outstanding / recently-decided change-request (null when none).
const methodRequest = computed(() => masterStore.profile?.method_change_request ?? null)
const methodRequestPending = computed((): boolean => methodRequest.value?.status === 'pending')
const pendingProposedMethods = computed((): string[] => methodRequest.value?.proposed_methods ?? [])
const methodRejectReason = computed((): string =>
  methodRequest.value?.status === 'rejected' ? (methodRequest.value.reject_reason ?? '') : '',
)

// Local editable selection, seeded from the current methods and re-synced
// whenever the profile (re)loads.
const selectedMethods = ref<string[]>([])
watch(
  normalizedCurrent,
  (next) => {
    selectedMethods.value = [...next]
  },
  { immediate: true },
)

// Order-insensitive: the proposed set must be non-empty and differ from the
// normalised baseline (both in the two-level vocabulary).
const methodsChanged = computed((): boolean => {
  const sel = selectedMethods.value
  if (sel.length === 0) return false
  const cur = normalizedCurrent.value
  if (sel.length !== cur.length) return true
  const curSet = new Set(cur)
  return sel.some((m) => !curSet.has(m))
})

const submittingMethods = ref(false)
async function onSubmitMethods(): Promise<void> {
  if (submittingMethods.value || !methodsChanged.value) return
  submittingMethods.value = true
  try {
    await submitMethodChangeRequest([...selectedMethods.value])
    // Refetch so the pending badge appears (method_change_request now set).
    await masterStore.fetchMyProfile(true)
    toast.info('Запрос на смену методов отправлен на проверку')
  } catch (error) {
    toast.error(extractApiError(error, 'Не удалось отправить запрос'))
  } finally {
    submittingMethods.value = false
  }
}

// -- Master languages (E16): freely editable, no moderation -----------------
const currentLanguages = computed((): string[] => masterStore.profile?.languages ?? [])
const selectedLanguages = ref<string[]>([])
watch(
  currentLanguages,
  (next) => {
    selectedLanguages.value = [...next]
  },
  { immediate: true },
)

function toggleLanguage(l: string): void {
  const idx = selectedLanguages.value.indexOf(l)
  if (idx === -1) selectedLanguages.value.push(l)
  else selectedLanguages.value.splice(idx, 1)
}

// Differs from live (clearing to empty is allowed, unlike methods).
const languagesChanged = computed((): boolean => {
  const sel = selectedLanguages.value
  const cur = currentLanguages.value
  if (sel.length !== cur.length) return true
  const curSet = new Set(cur)
  return sel.some((l) => !curSet.has(l))
})

const savingLanguages = ref(false)
async function onSaveLanguages(): Promise<void> {
  if (savingLanguages.value || !languagesChanged.value) return
  savingLanguages.value = true
  try {
    await updateMasterLanguages([...selectedLanguages.value])
    await masterStore.fetchMyProfile(true)
    toast.info('Языки сохранены')
  } catch (error) {
    toast.error(extractApiError(error, 'Не удалось сохранить языки'))
  } finally {
    savingLanguages.value = false
  }
}

// Load the master profile so the delete modal can show the balance to forfeit
// and the methods/languages blocks reflect the current set + any pending request.
// Bug 2 fix (ПРОМТ №405): prime the taxonomy catalog cache in parallel so a
// promoted custom method already resolves to a plain chip on first render
// instead of flashing "custom".
onMounted(() => {
  if (isMaster.value) {
    void Promise.all([masterStore.fetchMyProfile(), primeMethodTaxonomyCatalog()])
  }
})

const displayName = computed(() => {
  const u = user.value
  if (!u) return ''
  const parts = [u.first_name, u.last_name].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : 'Пользователь'
})

// Editable form, initialised from the current profile. Phone + bio restored to
// match the «2 Edit Profile» design (the 2026-06-04 trim was unintended).
// email (E11) is captured here — Telegram provides none.
const form = reactive({
  firstName: user.value?.first_name ?? '',
  lastName: user.value?.last_name ?? '',
  bio: user.value?.bio ?? '',
  email: user.value?.email ?? '',
})

// -- Validation (mirrors backend soft rules) --------------------------------
const bioError = computed((): string => (form.bio.length > 2000 ? 'Не более 2000 символов' : ''))

// Soft email check (backend also 422s). Empty is allowed (clears the field).
const emailError = computed((): string => {
  const v = form.email.trim()
  if (v === '') return ''
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? '' : 'Введите корректный e-mail'
})

const hasErrors = computed(() => !!bioError.value || !!emailError.value)

// -- Actions ----------------------------------------------------------------
function onChangePhoto(): void {
  toast.info('Опция временно недоступна')
}

const saving = ref(false)

async function onSave(): Promise<void> {
  if (saving.value) return
  if (hasErrors.value) {
    toast.error('Проверьте правильность заполнения полей')
    return
  }

  // Build a partial update with only the changed fields. phone/bio: send "" to
  // clear (backend variant b). first_name: only a non-empty value (backend
  // rejects an empty name via min_length).
  const body: UserUpdate = {}
  const nextName = form.firstName.trim()
  if (nextName && nextName !== (user.value?.first_name ?? '')) {
    body.first_name = nextName
  }
  const nextLast = form.lastName.trim()
  if (nextLast !== (user.value?.last_name ?? '')) {
    body.last_name = nextLast
  }
  const nextBio = form.bio.trimEnd()
  if (nextBio !== (user.value?.bio ?? '')) {
    body.bio = nextBio
  }
  // email (E11): send "" to clear (phone/bio semantics); only when changed.
  const nextEmail = form.email.trim()
  if (nextEmail !== (user.value?.email ?? '')) {
    body.email = nextEmail
  }

  if (Object.keys(body).length === 0) {
    toast.info('Нет изменений')
    return
  }

  saving.value = true
  try {
    await authStore.updateProfile(body)
    toast.info('Профиль сохранён')
    router.back()
  } catch (error) {
    toast.error(extractApiError(error, 'Не удалось сохранить профиль'))
  } finally {
    saving.value = false
  }
}

// -- Delete account (design «Delete account») -------------------------------
// Full design built now; the real "delete forever + forfeit balance" backend
// isn't wired (the MVP deleteMe only resets onboarding), so «Удалить навсегда»
// is a stub-toast per the operator rule. -> Zod: real account-deletion + balance
// forfeiture endpoint; a user-side balance source for this modal.
const showDeleteModal = ref(false)
const delConsent = ref(false)
const delConfirmText = ref('')

// Balance to forfeit -- master earnings (0 / section hidden for plain users).
const balanceCents = computed(() => masterStore.profile?.available_cents ?? 0)
const hasBalance = computed(() => balanceCents.value > 0)
const formattedBalance = computed(() => formatMoney(balanceCents.value, 'EUR', 'ru', true))

// «Удалить навсегда» unlocks once any balance is consented to and the user
// typed the confirmation word.
// Confirmation word accepted in any case — «удалить» / «УДАЛИТЬ» both unlock (C7).
const canDelete = computed(
  () =>
    (!hasBalance.value || delConsent.value) &&
    delConfirmText.value.trim().toUpperCase() === 'УДАЛИТЬ',
)

// The «УДАЛИТЬ» confirm field sits below the balance / withdraw / consent block, so
// with a balance it only appears after consent and lands below the fold — the user
// had to hunt for it (operator PE-4). Scroll it into the modal's `.v-modal__scroll`
// region as soon as it renders: on modal open (the no-balance path shows it at once)
// and when consent reveals it (the balance path).
const confirmFieldEl = ref<HTMLElement | null>(null)
const showConfirmField = computed(() => !hasBalance.value || delConsent.value)
function revealConfirmField(): void {
  void nextTick(() => confirmFieldEl.value?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
}
watch(showDeleteModal, (open) => {
  if (open && showConfirmField.value) revealConfirmField()
})
watch(showConfirmField, (show) => {
  if (show && showDeleteModal.value) revealConfirmField()
})

function closeDeleteModal(): void {
  showDeleteModal.value = false
  delConsent.value = false
  delConfirmText.value = ''
}

function onWithdrawFirst(): void {
  closeDeleteModal()
  router.push({ name: 'master-finance' })
}

function onConfirmDelete(): void {
  // Stub per the operator rule -- real deletion isn't implemented (see note).
  toast.info('Удаление аккаунта пока недоступно, добавим позже')
}
</script>

<style scoped>
.edit-profile {
  display: flex;
  flex-direction: column;
  margin: calc(-1 * var(--space-4));
}

.edit-profile__content {
  padding: 0 var(--space-4) var(--space-8);
}

/* White plate around the photo (operator SVG mockup 2026-06-18). */
.edit-profile__avatar-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-2) 0 var(--space-5);
  padding: var(--space-5) 0;
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
}

.edit-profile__change-photo {
  background: transparent;
  border: none;
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-primary);
  cursor: pointer;
}

/* Locked onboarding methods (read-only chips + support note). */
.edit-profile__methods {
  margin-bottom: var(--space-4);
}

.edit-profile__methods-label {
  display: block;
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  margin-bottom: var(--space-2);
}

.edit-profile__methods-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.edit-profile__methods-note {
  margin: var(--space-2) 0 0;
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  line-height: 1.4;
}

.edit-profile__methods-status {
  margin-top: var(--space-3);
}

.edit-profile__methods-reject {
  margin: var(--space-2) 0 0;
  font-size: var(--text-xs);
  color: var(--velo-error);
  line-height: 1.4;
}

/* Inline field error (e-mail) — sibling <p> since VInput has no error prop. */
.edit-profile__field-error {
  margin: calc(-1 * var(--space-3)) 0 var(--space-4);
  font-size: var(--text-xs);
  color: var(--velo-error);
}

/* Submit button sits under the note with a little breathing room. */
.edit-profile__methods :deep(.v-btn) {
  margin-top: var(--space-3);
}

.edit-profile__delete {
  display: block;
  width: 100%;
  margin-top: var(--space-5);
  padding: var(--space-3);
  background: transparent;
  border: none;
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-error);
  cursor: pointer;
}

/* -- Delete account modal (design «Delete account») -- */
.edit-profile__del-title {
  font-family: var(--font-body);
  font-size: var(--text-lg);
  font-weight: 400;
  color: var(--velo-text-primary);
  text-align: center;
  margin: 0 0 var(--space-4);
}

.edit-profile__del-warning {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--velo-error-bg);
  color: var(--velo-danger-text);
  font-size: var(--text-sm);
  margin-bottom: var(--space-4);
}

.edit-profile__del-intro {
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  margin: 0 0 var(--space-2);
}

.edit-profile__del-list {
  margin: 0 0 var(--space-4);
  padding-left: var(--space-5);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  line-height: 1.7;
}

.edit-profile__del-balance {
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--velo-warning-bg);
  color: var(--velo-warning-text-light);
  font-size: var(--text-base);
  text-align: center;
  margin-bottom: var(--space-3);
}

.edit-profile__del-consent {
  margin: var(--space-4) 0;
}

.edit-profile__del-confirm-hint {
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  margin: var(--space-4) 0 var(--space-2);
}

.edit-profile__del-actions {
  display: flex;
  gap: var(--space-3);
  margin-top: var(--space-5);
}

.edit-profile__del-actions > * {
  flex: 1;
}
</style>
