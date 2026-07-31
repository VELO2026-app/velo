<!--
  VELO Frontend -- MasterGroupCreateView (Master GROUPS P2, PROMPT №591;
  description field + layout fix batch PROMPT №610)

  "Новая группа" -- «Название» + optional «Описание», POST /masters/me/groups,
  back to the list on success. 409 (duplicate name for this master) surfaces
  as an inline VInput error + a toast (mirrors MasterNewPromocodeView's
  create-form pattern: extractApiError + toast.error).

  G17/G18 (PROMPT №609): «Основное» section heading, reusing the existing
  velo-section-title class CreatePracticeView already uses -- no new DS
  class. Placeholder shortened to «Название» (was «Название группы»); the
  VInput label above the field already says «Название», so the placeholder
  no longer needs to repeat it.

  Owner Q4 (PROMPT №610): «Описание» -- optional, VTextarea/autogrow (same
  shape CreatePracticeView's own optional description field uses), no
  required-seal. Trimmed + blank-normalized-to-undefined client-side before
  POST -- createGroup() forwards that as `undefined` to the backend, which
  normalizes again server-side (belt + suspenders, matches the backend's
  own "never store ''" rule).

  Owner Q5 (PROMPT №610): submit button PINNED to the bottom of the screen,
  not merely placed after the last field -- `.new-group` is a full-height
  flex column, `.new-group__submit` gets `margin-top: auto` (same recipe
  MasterApplyView.vue's `.apply-view__next` already uses). With this form's
  two short fields the button always sits at the screen's bottom edge; if
  a future field ever makes the content taller than the viewport it falls
  back to sitting right after the last field, same graceful degradation as
  that existing precedent.

  Owner Q6 (PROMPT №610): required-fields legend, reusing
  MasterNewPromocodeView's exact recipe (`.new-promo__legend` -- the later,
  operator-brightened iteration; CreatePracticeView's own earlier version
  of this SAME banner uses a paler alpha (0.25 vs 0.40) and a different
  seal-icon color (--velo-rating-good vs --velo-error) despite resolving to
  the identical base hex for its border/text tokens -- picked the newer one
  verbatim rather than silently reconciling the two). Only «Название» is
  marked `required` -- «Описание» is genuinely optional, so it carries no
  seal, matching the client-side validation this form already had
  ("Введите название группы").
-->

<template>
  <div class="new-group">
    <VHeader title="Новая группа" show-back @back="router.back()" />

    <div class="new-group__content">
      <div class="new-group__legend">
        <IconRequired class="new-group__legend-seal" :size="22" />
        <span>— поля, обязательные для заполнения</span>
      </div>

      <h2 class="velo-section-title">Основное</h2>

      <VInput
        v-model="name"
        label="Название"
        placeholder="Название"
        :error="fieldError"
        required
        @focus="onFieldFocus"
      />

      <VTextarea
        v-model="description"
        label="Описание"
        placeholder="Описание"
        :rows="3"
        autogrow
        @focus="onFieldFocus"
      />

      <VButton
        variant="primary"
        block
        class="new-group__submit"
        :loading="creating"
        @click="onCreate"
      >
        Создать группу
      </VButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VInput, VTextarea, VButton } from '@/components/ui'
import { IconRequired } from '@/components/icons'
import { createGroup } from '@/api/groups'
import { useToast } from '@/composables/useToast'
import { useKeyboardFieldScroll } from '@/composables/useKeyboardFieldScroll'
import { extractApiError } from '@/composables/useApiError'

const router = useRouter()
const toast = useToast()
const { onFieldFocus } = useKeyboardFieldScroll()

const name = ref('')
const description = ref('')
const creating = ref(false)
const fieldError = ref('')

async function onCreate(): Promise<void> {
  if (creating.value) return
  if (!name.value.trim()) {
    toast.error('Введите название группы')
    return
  }
  creating.value = true
  fieldError.value = ''
  try {
    await createGroup(name.value.trim(), description.value.trim())
    toast.success('Группа создана')
    router.push({ name: 'master-groups' })
  } catch (e) {
    const message = extractApiError(e, 'Не удалось создать группу')
    fieldError.value = message
    toast.error(message)
  } finally {
    creating.value = false
  }
}
</script>

<style scoped>
.new-group {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.new-group__content {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-4) 0 var(--space-8);
}

/* Required-fields legend -- verbatim MasterNewPromocodeView recipe (see
   this file's header for why that one, not CreatePracticeView's). */
.new-group__legend {
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

.new-group__legend-seal {
  flex-shrink: 0;
  color: var(--velo-error);
}

/* Pinned to the screen's bottom edge (owner Q5) -- mirrors
   MasterApplyView.vue's `.apply-view__next`. */
.new-group__submit {
  margin-top: auto;
}
</style>
