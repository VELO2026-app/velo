<!--
  VELO Frontend -- VConfirmDialog Component (Phase B4.4)

  Confirmation dialog over the shared <VModal> canon (white sheet). Message +
  Cancel/Confirm buttons, danger variant, loading guard (overlay/cancel blocked
  while a request is in-flight).

  Usage:
    <VConfirmDialog
      :open="dlg.visible"
      :message="dlg.message"
      :confirm-label="dlg.confirmLabel"
      :danger="dlg.danger"
      :loading="dlg.loading"
      @confirm="dlg.onConfirm"
      @cancel="dlg.visible = false"
    />

  Optional `title` (Master GROUPS P3, ПРОМТ №592): a bold heading line above
  the message, for the two-part "title? / consequences." copy shape (e.g.
  block-confirm, report-offer). Omitted by every existing caller -- default
  empty, renders nothing extra, byte-identical to before this prop existed.
    <VConfirmDialog title="Заблокировать пользователя?" :message="..." ... />
-->

<template>
  <VModal :open="open" :show-close="false" :close-on-overlay="!loading" @close="$emit('cancel')">
    <h2 v-if="title" class="v-confirm__title">{{ title }}</h2>
    <p class="v-confirm__text">{{ message }}</p>
    <div class="v-confirm__actions">
      <VButton variant="ghost" :disabled="loading" @click="$emit('cancel')">
        {{ cancelLabel }}
      </VButton>
      <VButton
        :variant="danger ? 'danger' : 'primary'"
        :loading="loading"
        @click="$emit('confirm')"
      >
        {{ confirmLabel }}
      </VButton>
    </div>
  </VModal>
</template>

<script setup lang="ts">
import VModal from './VModal.vue'
import VButton from './VButton.vue'

withDefaults(
  defineProps<{
    open: boolean
    /** Optional bold heading above `message` (P3, ПРОМТ №592). Omit for the
     *  original single-paragraph shape every pre-existing caller still uses. */
    title?: string
    message: string
    confirmLabel?: string
    cancelLabel?: string
    danger?: boolean
    loading?: boolean
  }>(),
  {
    title: '',
    confirmLabel: 'Подтвердить',
    cancelLabel: 'Отмена',
    danger: false,
    loading: false,
  },
)

defineEmits<{
  confirm: []
  cancel: []
}>()
</script>

<style scoped>
/* Mirrors VBottomSheet's .v-sheet__title exactly -- same heading token
   recipe across the app's two confirm/sheet primitives. */
.v-confirm__title {
  font-family: var(--font-heading);
  font-size: var(--text-xl);
  font-weight: 400;
  color: var(--velo-text-primary);
  text-align: center;
  letter-spacing: 0.02em;
  margin: 0 0 var(--space-2);
}

.v-confirm__text {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  text-align: center;
  line-height: 1.5;
  margin: 0 0 var(--space-4);
}

.v-confirm__actions {
  display: flex;
  /* Wrap only when the buttons' real content width doesn't fit the row (bug
     4, ПРОМТ №408) -- a global flex-direction: column would restack every
     caller of this component (7 today), including short pairs that fit fine. */
  flex-wrap: wrap;
  gap: var(--space-3);
}

.v-confirm__actions > * {
  /* flex-basis: auto (was `flex: 1` = 0%) so a button's real content size
     counts toward the wrap decision above -- basis:0% hides it entirely from
     the wrap algorithm (same trap fixed in AdminCatalogView, bug 6b below). */
  flex: 1 1 auto;
}
</style>
