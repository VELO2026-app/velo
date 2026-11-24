<!--
  VELO Frontend -- ConsoleAddRow (FE-262)

  A one-line form to add an item: a name field, "Add" and "Cancel". Enter
  adds, Escape cancels; "Add" is off while the name is blank. The screen owns
  the text and the request.

  `testid` names the pieces for the tests: `<testid>-row` and `<testid>-confirm`.
-->

<template>
  <div class="console-add-row" :data-testid="`${testid}-row`">
    <VInput
      :model-value="modelValue"
      :label="placeholder"
      hide-label
      :placeholder="placeholder"
      maxlength="100"
      @update:model-value="emit('update:modelValue', $event)"
      @keydown.enter.prevent="emit('submit')"
      @keydown.esc="emit('cancel')"
    />
    <VButton
      size="sm"
      :loading="loading"
      :disabled="modelValue.trim() === ''"
      :data-testid="`${testid}-confirm`"
      @click="emit('submit')"
      >{{ t('ui.add') }}</VButton
    >
    <VButton variant="ghost" size="sm" @click="emit('cancel')">{{ t('ui.cancel') }}</VButton>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { VButton, VInput } from '@/components/ui'

defineProps<{
  /** The name typed so far. */
  modelValue: string
  /** The hint in the field (also its accessible name). */
  placeholder: string
  /** The request is in flight. */
  loading: boolean
  /** Prefix of the test ids. */
  testid: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  /** "Add", or Enter in the field. */
  submit: []
  /** "Cancel", or Escape in the field. */
  cancel: []
}>()
</script>

<style scoped>
.console-add-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

/* VInput keeps its attrs on the inner <input>: the flex rules go on its root. */
.console-add-row > .v-input {
  flex: 1;
  min-width: 0;
  margin-bottom: 0;
}
</style>
