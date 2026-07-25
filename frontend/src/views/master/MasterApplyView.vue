<!--
  VELO Frontend -- MasterApplyView (Phase B redesign, slice-2)

  3-step master application form, restyled to the operator Figma. Standalone
  route (no MasterShell, no tab bar) — accessible to role='user'.

  Steps:
    1. Профиль   -- display_name (required), email, phone + privacy consent
    2. Опыт      -- methods (VChip pills + «Свой вариант»), experience_years
                    (VSelect), bio (kept), language (Русский/English — honest
                    stub, no backend field yet → Zod E16)
    3. Документы -- passport / certificates / profile-photo upload zones
                    (honest stub → Zod E13: tap shows «недоступно», no file POST)
                    + privacy paragraph + processing consent

  FORKS (operator-locked): NO password fields (Telegram initData auth, F1) ·
  bio retained (F2) · language stub (F3) · full method list incl. «Кундалини
  йога» (F6). Step indicator = the canonical VPaginationDots (top-left).

  All collected data is sent as one POST /api/v1/masters/apply on step-3 submit
  (language + uploaded files are NOT in the request yet — Zod E16/E13). On
  success -> /master/pending.

  Back on step 1 -> router.back() (typically /user/profile); steps 2-3 -> prev step.
-->

<template>
  <div class="apply-view">
    <!-- Non-scrolling top block: «Заявка» header + step dots float ABOVE the
         fogged feed, so scrolling body text can never ride up over them (J2g). -->
    <div class="apply-view__top">
      <VHeader title="Заявка" show-back @back="onBack" />
      <!-- Canonical step dots, top-left (operator 2026-06-27). -->
      <VPaginationDots :total="3" :active="step - 1" class="apply-view__dots" />
    </div>

    <!-- Scrolling feed: top fog-mask dissolves content at the header edge (reuses
         the dashboard/diary island gradient). Tap-to-dismiss keyboard is
         app-global now (useKeyboardDismiss, B1). -->
    <div ref="contentEl" class="apply-view__content velo-kbd-scroll">
      <!-- ================================================================
           STEP 1: Профиль
           ================================================================ -->
      <template v-if="step === 1">
        <h3 class="apply-view__step-title">Шаг 1: Профиль</h3>

        <VInput
          v-model="form.display_name"
          floating-label
          label="Имя"
          :error="errors.display_name"
        />
        <VInput v-model="form.email" floating-label label="E-mail" type="email" />
        <VInput v-model="form.phone" floating-label label="Телефон" type="tel" />

        <VCard class="apply-view__consent" padding="none">
          <VCheckbox v-model="form.privacyAccepted" size="sm">
            Я принимаю Условия использования и ознакомлен(а) с Политикой конфиденциальности
          </VCheckbox>
        </VCard>
        <p v-if="errors.privacy" class="apply-view__field-error">{{ errors.privacy }}</p>

        <VButton variant="primary" block size="lg" class="apply-view__next" @click="goToStep2">
          Далее
        </VButton>
      </template>

      <!-- ================================================================
           STEP 2: Опыт
           ================================================================ -->
      <template v-else-if="step === 2">
        <h3 class="apply-view__step-title">Шаг 2: Опыт</h3>

        <!-- Направления практик — TWO-LEVEL taxonomy, extracted into the shared
             MethodTaxonomyPicker (batch L, single source of truth). The outer
             label + validation error stay here; the picker owns the direction
             chips, the per-direction style cards and «Свой вариант». v-model is
             the flat `methods: string[]` payload (unchanged schema). -->
        <div class="apply-view__field">
          <label class="apply-view__label">Направления практик *</label>
          <MethodTaxonomyPicker v-model="methods" />
          <p v-if="errors.methods" class="apply-view__field-error">{{ errors.methods }}</p>
        </div>

        <VSelect
          v-model="experienceLabel"
          label="Опыт преподавания *"
          :options="EXPERIENCE_OPTIONS"
          :error="errors.experience_years"
        />

        <VTextarea
          v-model="form.bio"
          label="О себе *"
          placeholder="Расскажите о вашем опыте и подходе к практикам…"
          :rows="4"
          :error="errors.bio"
        />

        <!-- Язык проведения практик — honest stub (no backend field, Zod E16):
             toggles locally, not sent with the application. -->
        <div class="apply-view__field">
          <label class="apply-view__label">Язык проведения практик</label>
          <VCard class="apply-view__langs" padding="none">
            <VCheckbox v-model="langRu" label="Русский" />
            <VCheckbox v-model="langEn" label="English" />
          </VCard>
        </div>

        <VButton variant="primary" block size="lg" class="apply-view__next" @click="goToStep3">
          Далее
        </VButton>
      </template>

      <!-- ================================================================
           STEP 3: Документы (upload = honest stub, Zod E13)
           ================================================================ -->
      <template v-else>
        <h3 class="apply-view__step-title">Шаг 3: Документы</h3>
        <p class="apply-view__intro">
          Сертификаты хранятся в зашифрованном виде и используются для внутренней верификации
          вашей квалификации. Удостоверение личности используется только для подтверждения
          личности и автоматически удаляется через 30 дней после верификации.
        </p>

        <!-- Documents are OPTIONAL right now: file upload/storage is not built
             yet (E13 / S3 — SELF-later, see the onUpload stub + submit()). The
             applicant MUST be able to proceed without uploading, otherwise the
             required-looking passport «*» + a disabled upload traps them and
             nobody can become a master. «Пропустить» below submits with an
             empty documents list (the backend already accepts that). -->
        <VCard class="apply-view__skip-note" padding="none">
          Загрузка документов пока недоступна. Вы можете отправить заявку без
          документов и пройти верификацию позже — нажмите «Пропустить».
        </VCard>

        <!-- Passport -->
        <div class="apply-view__field">
          <label class="apply-view__label">Паспорт (скан или фото) *</label>
          <p class="apply-view__hint">Для верификации личности. Не публикуется.</p>
          <VCard class="apply-view__upload-card" padding="sm">
            <button type="button" class="apply-view__upload" @click="onUpload">
              <IconFile :size="26" class="apply-view__upload-icon" />
              <span class="apply-view__upload-text">Загрузить документ</span>
            </button>
          </VCard>
        </div>

        <!-- Certificates (multi-file UI; chip list renders once E13 stores files) -->
        <div class="apply-view__field">
          <label class="apply-view__label">Сертификаты</label>
          <p class="apply-view__hint">Можно загрузить несколько файлов.</p>
          <div v-for="cert in uploadedCerts" :key="cert" class="apply-view__filechip">
            <IconCheck :size="18" />
            <span class="apply-view__filechip-name">{{ cert }}</span>
          </div>
          <VCard class="apply-view__upload-card" padding="sm">
            <button type="button" class="apply-view__upload" @click="onUpload">
              <IconFile :size="26" class="apply-view__upload-icon" />
              <span class="apply-view__upload-text">Добавить сертификат</span>
            </button>
          </VCard>
        </div>

        <!-- Profile photo -->
        <div class="apply-view__field">
          <label class="apply-view__label">Фото профиля</label>
          <p class="apply-view__hint">
            Будет использовано на платформе в открытом доступе для участников.
          </p>
          <VCard class="apply-view__upload-card" padding="sm">
            <button type="button" class="apply-view__upload" @click="onUpload">
              <IconFile :size="26" class="apply-view__upload-icon" />
              <span class="apply-view__upload-text">Загрузить фото</span>
            </button>
          </VCard>
        </div>

        <VCard class="apply-view__consent" padding="none">
          <VCheckbox v-model="form.docsConsent">
            Я даю согласие на обработку загруженных документов для верификации
          </VCheckbox>
        </VCard>
        <p v-if="errors.docs" class="apply-view__field-error">{{ errors.docs }}</p>

        <VButton
          variant="primary"
          block
          size="lg"
          class="apply-view__next"
          :loading="submitting"
          @click="submit()"
        >
          Отправить
        </VButton>

        <!-- Skip the (currently unavailable) document upload. Submits with an
             empty documents list; bypasses the docs-consent gate since there is
             nothing uploaded to consent to. Steps 1-2 (name/methods/experience)
             stay mandatory. Remove this button once E13 file upload ships. -->
        <VButton
          variant="ghost"
          block
          size="lg"
          class="apply-view__skip"
          :disabled="submitting"
          @click="submit(true)"
        >
          Пропустить
        </VButton>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import {
  VButton,
  VInput,
  VTextarea,
  VSelect,
  VCard,
  VCheckbox,
  VPaginationDots,
} from '@/components/ui'
import { IconCheck, IconFile } from '@/components/icons'
import { useToast } from '@/composables/useToast'
import { applyMaster } from '@/api/masters'
import { extractApiError } from '@/composables/useApiError'
import { MASTER_APPLIED_KEY, masterRejectionSeenKey } from '@/utils/constants'
import { LANGUAGES } from '@/utils/languages'
import MethodTaxonomyPicker from '@/components/shared/MethodTaxonomyPicker.vue'
import { useMasterStore } from '@/stores/master'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const toast = useToast()
const masterStore = useMasterStore()
const authStore = useAuthStore()

// -- Step state --
const step = ref(1)
const submitting = ref(false)

// ПРОМТ №565 (T23-2): .apply-view__content is ONE persistent scrolling
// container across all 3 steps (the v-if/v-else-if chain swaps only its
// children, never the container itself, .vue:460-479) -- so whatever
// scrollTop a step was left at carries straight into the next one. All FOUR
// transitions share this same code path (goToStep2 1->2, goToStep3 2->3,
// onBack's step.value-- covers both 3->2 and 2->1), so a single watch here
// -- not a per-button scrollTo -- covers every direction at once.
const contentEl = ref<HTMLElement | null>(null)
watch(step, () => {
  if (contentEl.value) contentEl.value.scrollTop = 0
})

// -- Experience years options: label -> integer value mapping --
const EXPERIENCE_OPTIONS = [
  { label: 'Менее 1 года', value: '0' },
  { label: '1-3 года', value: '2' },
  { label: '3-5 лет', value: '4' },
  { label: '5-10 лет', value: '7' },
  { label: 'Более 10 лет', value: '11' },
]

// -- Form state --
const form = reactive({
  // Step 1
  display_name: '',
  email: '',
  phone: '',
  privacyAccepted: false,
  // Step 2
  bio: '',
  // Step 3
  docsConsent: false,
})

// -- Method selection (batch L) ----------------------------------------------
// The two-level направление→вид taxonomy now lives in MethodTaxonomyPicker; this
// view only holds the flat `methods: string[]` payload it emits (v-model). The
// picker owns seeding/flattening, «Свой вариант» and its own focus-scroll.
const methods = ref<string[]>([])

// Experience years stored as string value label, mapped to int on submit
const experienceLabel = ref('')

// Languages the master runs practices in (E16). Sent with the application as
// experience.languages (flat list); surfaced + freely editable on the profile.
const langRu = ref(true)
const langEn = ref(false)
const selectedLanguages = computed((): string[] => {
  const langs: string[] = []
  if (langRu.value) langs.push(LANGUAGES[0]) // Русский
  if (langEn.value) langs.push(LANGUAGES[1]) // English
  return langs
})

// Certificates chip list — empty until E13 file storage ships (no faked data).
const uploadedCerts = ref<string[]>([])

// -- Validation errors --
const errors = reactive({
  display_name: '',
  privacy: '',
  methods: '',
  experience_years: '',
  bio: '',
  docs: '',
})

// -- Experience years numeric value --
const experienceYears = computed((): number => {
  const opt = EXPERIENCE_OPTIONS.find((o) => o.value === experienceLabel.value)
  return opt ? parseInt(opt.value, 10) : 0
})

// -- Upload stub (Zod E13: no file storage yet) --
function onUpload(): void {
  toast.info('Загрузка файлов пока недоступна')
}

// -- Navigation --
function onBack(): void {
  if (step.value > 1) {
    step.value -= 1
  } else {
    router.back()
  }
}

// -- Step 1 validation and advance --
function goToStep2(): void {
  errors.display_name = ''
  errors.privacy = ''
  if (!form.display_name.trim()) {
    errors.display_name = 'Пожалуйста, введите имя'
    return
  }
  if (!form.privacyAccepted) {
    errors.privacy = 'Необходимо принять условия использования'
    return
  }
  step.value = 2
}

// -- Step 2 validation and advance --
function goToStep3(): void {
  errors.methods = ''
  errors.experience_years = ''
  errors.bio = ''
  if (methods.value.length === 0) {
    errors.methods = 'Выберите хотя бы одно направление'
    return
  }
  if (!experienceLabel.value) {
    errors.experience_years = 'Выберите опыт преподавания'
    return
  }
  if (!form.bio.trim()) {
    errors.bio = 'Пожалуйста, расскажите о себе'
    return
  }
  step.value = 3
}

// -- Final submit --
// FP-04: double-submit guard must come before validation — parallel clicks both
// pass the consent check before the guard fires.
//
// `skipDocuments` (the «Пропустить» button): the applicant proceeds WITHOUT
// documents. File upload/storage is not built yet (E13 / S3 — SELF-later; the
// onUpload() stub only toasts «недоступно»), so requiring a document — or the
// consent-to-process-documents checkbox — would trap every applicant. The
// backend already accepts an empty documents list, so skip is a pure
// client-side path: it bypasses the docs-consent gate. Steps 1-2
// (name / methods / experience) were already enforced by goToStep2 /
// goToStep3 and are untouched.
async function submit(skipDocuments = false): Promise<void> {
  if (submitting.value) return

  errors.docs = ''
  if (!skipDocuments && !form.docsConsent) {
    errors.docs = 'Необходимо дать согласие на обработку документов'
    return
  }

  submitting.value = true
  try {
    const res = await applyMaster({
      profile: {
        display_name: form.display_name.trim(),
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
      },
      experience: {
        methods: methods.value,
        languages: selectedLanguages.value,
        experience_years: experienceYears.value,
        bio: form.bio.trim() || null,
        certifications: [],
      },
      documents: [],
    })

    if (res.status === 'verified') {
      // Self-provision (ПРОМТ №307): a no-profile role='master' account (an
      // admin who switched into master mode) is verified immediately -- go
      // straight to the master zone, no pending screen, no applicant marker.
      // Refresh the store so masterNoProfileGuard sees the fresh profile
      // instead of the stale profileMissing from the earlier 403.
      await masterStore.fetchMyProfile(true)
      toast.success('Профиль создан')
      router.push({ name: 'master-dashboard' })
    } else {
      // Normal application (role='user') -> pending verdict flow. Mark this
      // session as an actual applicant so the master-pending guard lets a
      // still-role='user' applicant through (backend promotes role later).
      sessionStorage.setItem(MASTER_APPLIED_KEY, '1')
      // Bug 1 follow-up (ПРОМТ №406): re-arm the rejection screen for this new
      // application. Without this, a second rejection would be invisible
      // forever -- the per-user seen-key set by the FIRST rejection would
      // still be there. Safe: the backend always resets status to "pending"
      // on submit/resubmit (masters/service.py:76 _build_data, reused by
      // _build_reapply_data), so roleRedirect's `status === 'rejected'` check
      // cannot fire in the interim -- this only re-arms visibility for a
      // genuine future rejection, it does not resurrect the old screen.
      if (authStore.user?.id) {
        localStorage.removeItem(masterRejectionSeenKey(authStore.user.id))
      }
      toast.success('Заявка отправлена!')
      router.push({ name: 'master-pending' })
    }
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось отправить заявку'))
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.apply-view {
  /* Bounded to AppFrame's height (its `> *` rule gives flex:1; min-height:0), so
     the inner feed scrolls instead of the whole page — the precondition for the
     header fog (J2g). */
  height: 100%;
  min-height: 0;
  background: transparent;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Non-scrolling top block — header + dots sit above the fogged feed (J2g). */
.apply-view__top {
  flex-shrink: 0;
  position: relative;
  z-index: var(--z-sticky);
}

/* Step dots — top-left at the screen rail (standalone route, WS-1 24px rail). */
.apply-view__dots {
  padding: var(--space-2) var(--velo-rail-pad-x) 0;
}

/* -- Content area (the scrolling feed) -- */
.apply-view__content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* Scrollbar hidden (app-wide convention) so content rides the single 24px rail. */
  scrollbar-width: none;
  -ms-overflow-style: none;
  /* Top fog-mask: content dissolves at the header edge on scroll (reuses the
     dashboard/diary island gradient — not a new mechanism). The fade sits inside
     the top padding, so at rest the first block is fully crisp (layout
     unchanged). Bottom stays crisp — the «Далее/Отправить» actions must not fade. */
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 var(--space-4), #000 100%);
  mask-image: linear-gradient(to bottom, transparent 0, #000 var(--space-4), #000 100%);
  /* Standalone route (outside MobileLayout) — apply the screen rail directly. */
  padding: var(--space-4) var(--velo-rail-pad-x) var(--space-8);
  display: flex;
  flex-direction: column;
  /* Tightened inter-block spacing per the right mockup (J1d / J2a). */
  gap: var(--space-3);
}

.apply-view__content::-webkit-scrollbar {
  display: none;
}

/* Tightened spacing (J1d / J2a): the DS field wrappers carry their own
   margin-bottom, which would stack on top of the flex gap. Zero it here so the
   single gap governs the rhythm. */
.apply-view__content :deep(.v-input),
.apply-view__content :deep(.v-select),
.apply-view__content :deep(.v-textarea) {
  margin-bottom: 0;
}

.apply-view__step-title {
  font-family: var(--font-body);
  font-size: var(--text-xl);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  -webkit-text-stroke: var(--velo-text-stroke-strong) var(--velo-text-primary);
  margin-bottom: var(--space-1);
}

.apply-view__intro {
  font-size: var(--text-xs);
  /* Brightened from --velo-text-muted → secondary so the privacy copy is legible
     over the photo background (J3a). */
  color: var(--velo-text-secondary);
  line-height: 1.4;
  margin: 0;
}

/* -- Fields -- */
.apply-view__field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.apply-view__label {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  -webkit-text-stroke: var(--velo-text-stroke-strong) var(--velo-text-primary);
}

.apply-view__hint {
  font-size: var(--text-xs);
  /* MA2 (operator 2026-07-12): brightened to match .apply-view__intro so the
     Step-3 upload captions (Паспорт/Сертификаты/Фото профиля) read at the same
     legibility as the top privacy paragraph, not the fainter muted tone. */
  color: var(--velo-text-secondary);
  line-height: 1.4;
  margin: 0;
}

.apply-view__field-error {
  font-size: var(--text-sm);
  color: var(--velo-error);
}

/* -- Language stub card -- */
.apply-view__langs {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3);
}

/* -- Upload zones (stub) — each wrapped in a white VCard подложка (J3b) -- */
.apply-view__upload-card {
  /* The white plate; the bespoke dropzone button sits inside it. */
  padding: var(--space-2);
}

.apply-view__upload {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--velo-gap-6);
  width: 100%;
  height: 80px;
  border: 1px solid var(--velo-text-primary);
  border-radius: var(--velo-radius-9);
  background: transparent;
  cursor: pointer;
  color: var(--velo-text-primary);
  transition: opacity var(--transition-fast);
}

.apply-view__upload:hover {
  opacity: 0.85;
}

.apply-view__upload-icon {
  color: var(--velo-text-primary);
}

.apply-view__upload-text {
  font-size: var(--text-base);
  letter-spacing: 0.02em;
}

/* -- Uploaded-file chip (teal; renders once E13 stores files) -- */
.apply-view__filechip {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: var(--velo-size-44);
  padding: 0 var(--space-3);
  border-radius: var(--velo-radius-9);
  background: var(--velo-glass-teal-30);
  border: 1px solid var(--velo-teal-400);
  color: var(--velo-teal-700);
}

.apply-view__filechip-name {
  flex: 1;
  min-width: 0;
  font-size: var(--text-base);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* -- Consent cards -- */
.apply-view__consent {
  padding: var(--space-3);
}

.apply-view__next {
  margin-top: auto;
}

/* Skip-documents info note (documents optional until E13 upload ships). */
.apply-view__skip-note {
  padding: var(--space-3);
  font-size: var(--text-sm);
  color: var(--velo-text-muted);
  line-height: 1.4;
}

/* «Пропустить» — secondary path directly under «Отправить». */
.apply-view__skip {
  margin-top: var(--space-2);
}
</style>
