<!--
  VELO Frontend -- DiscardChangesDialog (FE-233, the tail of package 2)

  The "Discard changes?" question of a form in a bottom sheet or a modal. It
  is the confirm dialog ReportUserSheet built by hand, shared so each guarded
  form adds a few lines instead of nine. The state lives in the form's guard
  (`useDiscardGuard`); this component only renders the question:

    <DiscardChangesDialog
      :open="guard.confirming.value"
      @discard="guard.discard"
      @keep-editing="guard.keepEditing"
    />
-->

<template>
  <VConfirmDialog
    :open="open"
    :title="t('shared.discardChanges.title')"
    :message="t('shared.discardChanges.message')"
    :confirm-label="t('shared.discardChanges.confirm')"
    :cancel-label="t('shared.discardChanges.keepEditing')"
    danger
    @confirm="$emit('discard')"
    @cancel="$emit('keepEditing')"
  />
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { VConfirmDialog } from '@/components/ui'

defineProps<{
  /** The question is showing. */
  open: boolean
}>()

defineEmits<{
  /** The person chose to drop the edits. */
  discard: []
  /** The person chose to go back to the form. */
  keepEditing: []
}>()
</script>
