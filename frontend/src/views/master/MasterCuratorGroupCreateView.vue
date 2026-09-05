<!--
  VELO Frontend -- MasterCuratorGroupCreateView (schools FE-20 / GT P3)

  "Новая группа" for SCHOOLS -- «Название» + optional «Описание», POST
  /masters/me/curator-groups, back to the master list on success. A close
  structural clone of MasterGroupCreateView (the custom student group's own
  create form): same required-fields legend, same pinned submit, same 409
  handling (inline field error + toast -- curator_group_name_taken means
  "you already have a school by this name", a per-curator uniqueness, I-7).

  BE-18: founding is a right an admin grants, so the route is only
  offered with it (the list's «+»). A direct visit without the right is
  answered 403 group_creation_not_allowed -- rendered here as an honest
  refusal state, never as a retryable error (retrying a right cannot work).
-->

<template>
  <div class="ncg">
    <VHeader title="Новая группа" show-back @back="router.back()" />

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
        <div class="ncg__legend">
          <IconRequired class="ncg__legend-seal" :size="22" />
          <span>— поля, обязательные для заполнения</span>
        </div>

        <h2 class="velo-section-title">Основное</h2>

        <VInput
          v-model="name"
          label="Название"
          placeholder="Название"
          hide-label
          :error="fieldError"
          required
          @focus="onFieldFocus"
        />

        <VTextarea
          v-model="description"
          label="Описание"
          placeholder="Описание"
          hide-label
          :rows="3"
          autogrow
        />

        <VButton class="ncg__submit" variant="primary" block :loading="creating" @click="onCreate">
          Создать группу
        </VButton>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { createCuratorGroup } from '@/api/curatorGroups'
import { ApiResponseError } from '@/api/client'
import { extractApiError } from '@/composables/useApiError'
import { useKeyboardFieldScroll } from '@/composables/useKeyboardFieldScroll'
import { useToast } from '@/composables/useToast'
import IconRequired from '@/components/icons/IconRequired.vue'
import VButton from '@/components/ui/VButton.vue'
import VEmptyState from '@/components/ui/VEmptyState.vue'
import VHeader from '@/components/layout/VHeader.vue'
import VInput from '@/components/ui/VInput.vue'
import VTextarea from '@/components/ui/VTextarea.vue'

const router = useRouter()
const toast = useToast()
const { onFieldFocus } = useKeyboardFieldScroll()

const name = ref('')
const description = ref('')
const fieldError = ref('')
const creating = ref(false)
/** BE-18: set by 403 group_creation_not_allowed -- swaps the form for the
 *  refusal state. Sticky: a right cannot appear mid-screen, so nothing
 *  resets it short of leaving the route. */
const refused = ref(false)

async function onCreate(): Promise<void> {
  const trimmed = name.value.trim()
  fieldError.value = ''

  if (!trimmed) {
    fieldError.value = 'Введите название группы'
    return
  }

  creating.value = true
  try {
    // Blank description is normalized to undefined here; the backend's own
    // "never store ''" rule is the belt to this suspend (same as groups).
    const desc = description.value.trim()
    await createCuratorGroup(trimmed, desc || undefined)
    toast.success(`Группа «${trimmed}» создана`)
    void router.replace({ name: 'master-curator-groups' })
  } catch (e) {
    if (e instanceof ApiResponseError && e.code === 'curator_group_name_taken') {
      fieldError.value = 'У вас уже есть группа с таким названием'
    }
    if (e instanceof ApiResponseError && e.code === 'group_creation_not_allowed') {
      // Not a field error and not a retryable failure -- the RIGHT is
      // missing. The refusal state replaces the form; the toast adds the
      // phrase errorMessages.ts already carries.
      refused.value = true
    }
    toast.error(extractApiError(e, 'Не удалось создать группу'))
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

/* T24-8 equivalent: equalize the two visible plates (required seal reserve). */
.ncg__content :deep(.v-textarea__field) {
  margin-right: 30px;
}

/* Pinned to the screen's bottom edge -- mirrors MasterApplyView's recipe. */
.ncg__submit {
  margin-top: auto;
}
</style>
