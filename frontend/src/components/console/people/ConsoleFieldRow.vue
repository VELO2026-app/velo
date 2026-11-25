<!--
  VELO Frontend -- ConsoleFieldRow (FE-262)

  One "label / value / pen" row of a console detail card with its inline
  editor. The row owns only the chrome: the caption on the left, the value
  and the pen button on the right, and the cancel / save actions while the
  editor is open. What is shown and what is edited goes in through slots;
  the owner decides what saving means.

    default slot -> the read-only value;
    #edit slot   -> the editor controls shown while `editing`.
-->

<template>
  <div class="field-row" data-testid="console-field-row">
    <div class="field-row__label">{{ label }}</div>
    <div class="field-row__body">
      <div v-if="editing" class="field-row__editor">
        <slot name="edit" />
        <p v-if="error" class="field-row__error" role="alert">{{ error }}</p>
        <div class="field-row__actions">
          <VButton variant="ghost" size="sm" :disabled="saving" @click="emit('cancel')">{{
            t('ui.cancel')
          }}</VButton>
          <VButton variant="primary" size="sm" :loading="saving" @click="emit('save')">{{
            t('ui.save')
          }}</VButton>
        </div>
      </div>
      <template v-else>
        <div class="field-row__value"><slot /></div>
        <button type="button" class="field-row__pen" :aria-label="editLabel" @click="emit('start')">
          <IconPen :size="18" />
        </button>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { VButton } from '@/components/ui'
import { IconPen } from '@/components/icons'

withDefaults(
  defineProps<{
    /** Row caption. */
    label: string
    /** Accessible name of the pen button. */
    editLabel: string
    /** Whether the inline editor is open. */
    editing: boolean
    /** Save in flight: disables cancel, spins save. */
    saving?: boolean
    /** Error text under the editor controls; empty hides it. */
    error?: string
  }>(),
  { saving: false, error: '' },
)

const emit = defineEmits<{
  /** The pen was pressed. */
  start: []
  /** Cancel pressed in the editor. */
  cancel: []
  /** Save pressed in the editor. */
  save: []
}>()
</script>

<style scoped>
.field-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-5);
  padding: var(--space-3) 0;
}

.field-row + .field-row {
  border-top: 1px solid var(--velo-border-light);
}

.field-row__label {
  flex: 0 0 180px;
  padding-top: var(--space-1);
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
}

.field-row__body {
  display: flex;
  flex: 1 1 auto;
  align-items: flex-start;
  gap: var(--space-3);
  min-width: 0;
}

.field-row__value {
  flex: 1 1 auto;
  min-width: 0;
  padding-top: var(--space-1);
  font-size: var(--velo-fs-14);
  color: var(--velo-text-primary);
  overflow-wrap: anywhere;
}

.field-row__pen {
  display: flex;
  flex: 0 0 auto;
  padding: var(--space-1);
  border: 0;
  background: none;
  color: var(--velo-primary);
  cursor: pointer;
}

.field-row__pen:focus-visible {
  outline: 2px solid var(--velo-primary);
  outline-offset: 2px;
}

.field-row__editor {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}

.field-row__error {
  margin: 0;
  font-size: var(--velo-fs-14);
  color: var(--velo-error-text);
}

.field-row__actions {
  display: flex;
  gap: var(--space-2);
}
</style>
