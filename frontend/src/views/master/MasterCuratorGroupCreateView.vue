<!--
  VELO Frontend -- MasterCuratorGroupCreateView (schools FE-20 / GT P3; §1.5)

  «Новая школа» -- banner+avatar (behind the kill-switch), «Название школы» +
  optional «Описание школы», POST /masters/me/curator-groups, ON SUCCESS the
  TZ's §1.6 rule: creation lands on the SCHOOL PAGE, not the list. A close
  structural clone of MasterGroupCreateView (the custom student group's own
  create form): same required-fields legend, same pinned submit, same 409
  handling (inline field error + toast -- curator_group_name_taken means
  "you already have a school by this name", a per-curator uniqueness, I-7).

  BE-18: founding is a right an admin grants, so the route is only
  offered with it (the lists' «+»). A direct visit without the right is
  answered 403 group_creation_not_allowed -- rendered here as an honest
  refusal state, never as a retryable error (retrying a right cannot work).

  MEDIA (§1.5): the avatar/banner pickers render only behind
  SCHOOL_MEDIA_UPLOAD_ENABLED -- there is no upload backend yet (§7.1 №4),
  the pickers hold a LOCAL preview and nothing is sent to the server.
-->

<template>
  <div class="ncg">
    <VHeader title="Новая школа" show-back @back="router.back()" />

    <div class="ncg__content">
      <!-- BE-18: 403 group_creation_not_allowed -- the right itself is
           missing, and no amount of retrying the POST changes that. The form
           is replaced by the refusal; only the back button remains. -->
      <VEmptyState
        v-if="refused"
        icon="warning"
        title="Создание школ недоступно"
        description="Заводить школы может мастер, которому администратор выдал это право."
      >
        <template #action>
          <VButton variant="outline" @click="router.replace({ name: 'master-curator-groups' })">
            К моим школам
          </VButton>
        </template>
      </VEmptyState>

      <template v-else>
        <!-- Required-fields legend: HIDDEN for now (owner 2026-10-01) -- the
             section-title asterisk reads without an explanation. Restore the
             block below when an explanation is needed again. -->
        <!--
        <div class="ncg__legend">
          <IconRequired class="ncg__legend-seal" :size="22" />
          <span>— поля, обязательные для заполнения</span>
        </div>
        -->

        <h2 class="velo-section-title">Основное <span class="ncg__req">*</span></h2>

        <VInput
          v-model="name"
          label="Название"
          placeholder="Название"
          hide-label
          :error="fieldError"
          @focus="onFieldFocus"
        />
        <!-- Constant-height slot (owner 2026-10-01): the message fades in
             without growing its block, so an error never shifts the layout. -->
        <span class="ncg__field-error" :class="{ 'ncg__field-error--show': !!fieldError }">{{
          fieldError
        }}</span>

        <VTextarea
          v-model="description"
          label="Описание"
          placeholder="Описание"
          hide-label
          :rows="3"
          autogrow
        />

        <!-- §1.5 media, kill-switched until the upload backend exists: TWO
             sequential sections AFTER «Основное» (avatar first, then banner
             -- the mockup order), each a full-width upload card with its own
             hint. No overlay, no reserve when the flag is off; the modelValues
             ride NOTHING to the server (createCuratorGroup takes
             name/description only). -->
        <template v-if="SCHOOL_MEDIA_UPLOAD_ENABLED">
          <h2 class="velo-section-title">Аватар школы</h2>
          <p class="ncg__media-hint">
            Фото будет использовано на платформе в открытом доступе для участников
          </p>
          <SchoolAvatarPicker v-model="avatarUrl" aria-label="Аватар школы" />

          <h2 class="velo-section-title">Фон школы</h2>
          <p class="ncg__media-hint">
            Фото будет использовано на платформе в открытом доступе для участников
          </p>
          <SchoolBannerPicker v-model="bannerUrl" aria-label="Фон школы" />
        </template>

        <VButton class="ncg__submit" variant="primary" block :loading="creating" @click="onCreate">
          Создать школу
        </VButton>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { useRouter } from 'vue-router'
import { createCuratorGroup } from '@/api/curatorGroups'
import { ApiResponseError } from '@/api/client'
import { extractApiError } from '@/composables/useApiError'
import { useKeyboardFieldScroll } from '@/composables/useKeyboardFieldScroll'
import { useToast } from '@/composables/useToast'
import { queryDocument } from '@/platform/dom'
import { SCHOOL_MEDIA_UPLOAD_ENABLED } from '@/utils/constants'
import { VButton, VEmptyState } from '@/components/ui'
import VHeader from '@/components/layout/VHeader.vue'
import { VInput, VTextarea } from '@/components/ui'
import SchoolAvatarPicker from '@/components/shared/SchoolAvatarPicker.vue'
import SchoolBannerPicker from '@/components/shared/SchoolBannerPicker.vue'

const router = useRouter()
const toast = useToast()
const { onFieldFocus } = useKeyboardFieldScroll()

const name = ref('')
const description = ref('')
const fieldError = ref('')
const creating = ref(false)
// §1.5 media previews -- LOCAL object URLs only (see SCHOOL_MEDIA_UPLOAD_ENABLED).
const avatarUrl = ref<string | null>(null)
const bannerUrl = ref<string | null>(null)
/** BE-18: set by 403 group_creation_not_allowed -- swaps the form for the
 *  refusal state. Sticky: a right cannot appear mid-screen, so nothing
 *  resets it short of leaving the route. */
const refused = ref(false)

/* Inline field error through the constant slot (owner 2026-10-01 canon). */
async function showFieldError(message: string): Promise<void> {
  fieldError.value = message
  await nextTick()
  queryDocument('.ncg__field-error--show')?.scrollIntoView({
    behavior: 'smooth',
    block: 'center',
  })
}

async function onCreate(): Promise<void> {
  const trimmed = name.value.trim()
  fieldError.value = ''

  if (!trimmed) {
    await showFieldError('Введите название школы')
    return
  }

  creating.value = true
  try {
    // Blank description is normalized to undefined here; the backend's own
    // "never store ''" rule is the belt to this suspend (same as groups).
    const desc = description.value.trim()
    const created = await createCuratorGroup(trimmed, desc || undefined)
    toast.success(`Школа «${trimmed}» создана`)
    // §1.6 (owner): after creating, the school PAGE is the destination -- one
    // page component for both zones; this master-zone route keeps the guard
    // chain the creator just passed.
    void router.replace({ name: 'master-curator-group', params: { id: created.id } })
  } catch (e) {
    if (e instanceof ApiResponseError && e.code === 'curator_group_name_taken') {
      await showFieldError('У вас уже есть школа с таким названием')
    }
    if (e instanceof ApiResponseError && e.code === 'group_creation_not_allowed') {
      // Not a field error and not a retryable failure -- the RIGHT is
      // missing. The refusal state replaces the form; the toast adds the
      // phrase errorMessages.ts already carries.
      refused.value = true
    }
    toast.error(extractApiError(e, 'Не удалось создать школу'))
  } finally {
    creating.value = false
  }
}
</script>

<style scoped>
.ncg {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

/* Section-title required marker + constant-height error slot (owner
   2026-10-01 canon, same as the practice create form). VInput's own error
   line is hidden -- its red border still marks the field. */
.ncg__req {
  color: var(--velo-error);
}

.ncg__field-error {
  display: block;
  min-height: 17px;
  margin-top: 0;
  font-size: var(--text-xs);
  line-height: 1.2;
  color: var(--velo-error);
  opacity: 0;
}

.ncg__field-error--show {
  opacity: 1;
}

.ncg :deep(.v-input__error) {
  display: none;
}

/* [FE-45 follow-up] Keep the column at its AT-REST height while the keyboard
   is open -- same recipe as MasterGroupCreateView's own .new-group rule. */
html.is-keyboard-open .ncg {
  min-height: var(--velo-frozen-vh, 100lvh);
}

.ncg__content {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-4) 0 var(--space-8);
}

/* Required-fields legend -- verbatim MasterGroupCreateView recipe. */
.ncg__legend {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--velo-error-bg-strong);
  border: 1.5px solid var(--velo-error-border);
  color: var(--velo-danger-text);
  font-size: var(--text-sm);
}

.ncg__legend-seal {
  flex-shrink: 0;
  color: var(--velo-error);
}

/* T24-7 equivalent: kill VInput/VTextarea's own margin-bottom inside this
   gapped column (the double-counted gap), scoped to the Название field. */
.ncg__content > :deep(.v-input) {
  margin-bottom: 0;
}

/* §1.5 media sections (kill-switched OFF today): the mockup's two-line hint
   under each section title. */
.ncg__media-hint {
  margin: calc(-1 * var(--space-2)) 0 0;
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  line-height: 1.5;
}

/* Pinned to the screen's bottom edge -- mirrors MasterApplyView's recipe. */
.ncg__submit {
  margin-top: auto;
}
</style>
