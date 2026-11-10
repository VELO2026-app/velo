<!--
  VELO Frontend -- EditableFieldRow (FE-157 s4/admin-review)

  One "label / value / pen" row of the admin master review card with its
  inline editor. The row owns only the chrome: the label, the value cell, the
  pen button, and the cancel/save actions. What is shown and what is edited
  goes in through slots; the owner decides what saving means.

    default slot -> the read-only value (wrapped in the value cell);
    #edit slot   -> the editor controls shown while `editing`.

  `variant="methods"` keeps the dedicated class names of the practice-directions
  editor (its own endpoint, its own save label), so the markup and the styles
  of both editors stay identical to the generic one.

  The class names keep the `mreview__` prefix on purpose: the row is a piece
  of the review screen, and the screen's tests address them.
-->

<template>
  <div class="mreview__row">
    <div class="mreview__k">{{ label }}</div>
    <div v-if="editing" :class="variant === 'methods' ? 'mreview__methods-edit' : 'mreview__edit'">
      <slot name="edit" />
      <p v-if="error" :class="variant === 'methods' ? 'mreview__methods-err' : 'mreview__edit-err'">
        {{ error }}
      </p>
      <div :class="variant === 'methods' ? 'mreview__methods-actions' : 'mreview__edit-actions'">
        <VButton variant="ghost" size="sm" :disabled="saving" @click="emit('cancel')">{{
          t('ui.cancel')
        }}</VButton>
        <VButton variant="primary" size="sm" :loading="saving" @click="emit('save')">{{
          saveLabel ?? t('ui.save')
        }}</VButton>
      </div>
    </div>
    <template v-else>
      <div class="mreview__v" :class="valueClass">
        <slot />
      </div>
      <button type="button" class="mreview__pen" :aria-label="editLabel" @click="emit('start')">
        <IconPen :size="22" />
      </button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { VButton } from '@/components/ui'
import { IconPen } from '@/components/icons'

/** Props of one editable row. */
withDefaults(
  defineProps<{
    /** Row caption (the key column). */
    label: string
    /** Accessible name of the pen button. */
    editLabel: string
    /** Whether the inline editor is open. */
    editing: boolean
    /** Save in flight: disables cancel, spins save. */
    saving?: boolean
    /** Error text shown under the editor controls; empty or absent hides it. */
    error?: string
    /** Override of the save button caption (default: i18n:ui.save). */
    saveLabel?: string
    /** Editor class set: the generic one or the practice-directions one. */
    variant?: 'field' | 'methods'
    /** Extra class(es) for the value cell. */
    valueClass?: string
  }>(),
  { saving: false, error: '', saveLabel: undefined, variant: 'field', valueClass: undefined },
)

const emit = defineEmits<{
  /** The pen was pressed. */
  (e: 'start'): void
  /** Cancel pressed in the editor. */
  (e: 'cancel'): void
  /** Save pressed in the editor. */
  (e: 'save'): void
}>()
</script>

<style scoped>
.mreview__row {
  position: relative;
  padding: var(--space-3) 0;
}

.mreview__row + .mreview__row {
  border-top: var(--velo-border-width) solid var(--velo-border);
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

.mreview__v--bio {
  line-height: 1.35;
}

/* Value cell that is itself a chip list (languages, certificates). */
.mreview__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
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

.mreview__edit,
.mreview__methods-edit {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-2);
}

.mreview__edit-err,
.mreview__methods-err {
  margin: 0;
  font-size: var(--velo-fs-16);
  color: var(--velo-error);
}

.mreview__edit-actions,
.mreview__methods-actions {
  display: flex;
  gap: var(--space-2);
}

.mreview__edit-actions :deep(.v-btn),
.mreview__methods-actions :deep(.v-btn) {
  flex: 1;
}
</style>
