<!--
  VELO Frontend -- MasterCuratorGroupCreateView (schools FE-20 / GT P3)

  "Новая группа" for SCHOOLS -- «Название» + optional «Описание», POST
  /masters/me/curator-groups, back to the master list on success. A close
  structural clone of MasterGroupCreateView (the custom student group's own
  create form): same required-fields legend, same pinned submit, same 409
  handling (inline field error + toast -- curator_group_name_taken means
  "you already have a school by this name", a per-curator uniqueness, I-7).

  Creating the row IS becoming a curator -- no other grant exists, so this
  form is reachable to every verified master (route masterStatusGuard).
-->

<template>
  <div class="ncg">
    <VHeader title="Новая группа" show-back @back="router.back()" />

    <div class="ncg__content">
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
