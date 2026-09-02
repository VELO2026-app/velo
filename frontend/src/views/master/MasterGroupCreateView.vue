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

      <!-- T24-5/6 (PROMPT №639): the placeholder alone carries the visible
           hint now -- it already matched `label` before this batch
           (measured: was already true), so T24-5 needed no text change,
           only T24-6's label removal. `hideLabel` keeps `label` as the
           accessible name (a placeholder disappears on typing and is not
           announced the way a label is) without rendering it visibly. -->
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

/* [FE-45 follow-up, owner: "не так сильно двигается"] While typing, the
   scroll region (.velo-kbd-scroll main) correctly shrinks to the visible
   area -- but this form pins its submit via margin-top:auto inside a
   min-height:100% column, so the whole form used to compress and the button
   flew up ~300px with the keyboard. Keep the column at its AT-REST height
   (the frozen-vh px) instead: header/legend/fields stay exactly where they
   were, the submit waits under the keyboard (reachable by scrolling main --
   that is what the capped scroller is for), and on close nothing jumps
   (the column never changed height). Inert at rest: the class is absent.
   The practice/promocode forms need nothing -- their CTAs are in-flow, so
   their content was already stationary. */
html.is-keyboard-open .new-group {
  min-height: var(--velo-frozen-vh, 100lvh);
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

/* T24-7 (PROMPT №639): MEASURED finding -- the visible gap between the two
   fields was DOUBLE-COUNTED, not merely "too much by feel". `.new-group__content`
   is a flex column with `gap: var(--space-4)` between EVERY pair of children,
   but VInput/VTextarea ALSO carry their OWN `margin-bottom: var(--space-4)`
   (their shared default, needed by every OTHER caller that isn't inside a
   gapped flex column) -- the two stacked to 32px between Название and
   Описание where one space-4 (16px) was ever intended. Zeroing the Название
   field's own margin-bottom here removes exactly the duplicate, leaving a
   single space-4 gap -- scoped to THIS one transition (heading->Название and
   Описание->button keep their normal spacing, untouched). */
.new-group__content > :deep(.v-input) {
  margin-bottom: 0;
}

/* T24-8 (PROMPT №639): MEASURED finding -- the wrapper divs were ALREADY the
   same width (both stretch via the parent flex column's default
   align-items:stretch); the VISIBLE PLATE was not. Название is `required`,
   so its row reserves ~30px (IconRequired 22px + --space-2 gap) for the seal
   INSIDE `.v-input__row`, shrinking the field's own flex:1 share by that much.
   Описание has no seal (genuinely optional) so its row gives the field the
   full width. Reserving the same 30px on the textarea's side (as invisible
   margin, not a fake seal) equalizes the two visible plates without touching
   VInput's shared required-seal layout used everywhere else. */
.new-group__content :deep(.v-textarea__field) {
  margin-right: 30px;
}

/* Pinned to the screen's bottom edge (owner Q5) -- mirrors
   MasterApplyView.vue's `.apply-view__next`. */
.new-group__submit {
  margin-top: auto;
}
</style>
