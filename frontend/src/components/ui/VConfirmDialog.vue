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

  G6/G8 (ПРОМТ №609): `title`'s font-size stepped down from --text-xl (32px)
  to --text-lg (20px) so a two-word question fits one line -- affects every
  caller that actually passes a title (checked: 3 total across the app, not
  every VConfirmDialog instance, since most never set this prop).

  Optional `compactActions` (ПРОМТ №609, G10): renders both action buttons
  at size="sm" instead of the default "md", for a caller whose confirm
  label is long enough that "md" wraps the row onto two lines
  (MasterStudentProfileView's report-offer dialog: «Сообщить в
  поддержку» + «Не сейчас»). Sizing-only fix, not a label change -- the
  row layout itself (flex, wrap-when-too-wide) is unchanged. Default false,
  every pre-existing caller renders byte-identically.

  Default SLOT (ПРОМТ №610, owner Q9): optional content rendered between
  `title` and `message` -- e.g. MasterStudentProfileView's TargetUserCard,
  which now appears in both this component's callers there AND in
  ReportUserSheet, all three built from the SAME shared card. Empty by
  default (no slot content passed = renders nothing), byte-identical to
  before for every caller that doesn't use it.

  Optional `warningPanel` (ПРОМТ №610, owner Q9): renders `message` inside
  a peach panel with a warning icon instead of plain centered text --
  reuses the SAME --velo-warning-bg recipe ReportUserSheet's own support
  notice uses, but WITH an icon (the report sheet's notice deliberately
  has none -- that difference is real, not an oversight, see both files).
  Default false, every pre-existing caller renders byte-identically.
-->

<template>
  <VModal :open="open" :show-close="false" :close-on-overlay="!loading" @close="$emit('cancel')">
    <h2 v-if="title" class="v-confirm__title">{{ title }}</h2>
    <slot />
    <div v-if="warningPanel" class="v-confirm__panel">
      <IconWarning class="v-confirm__panel-icon" :size="20" />
      <p class="v-confirm__panel-text">{{ message }}</p>
    </div>
    <p v-else class="v-confirm__text">{{ message }}</p>
    <div class="v-confirm__actions">
      <VButton
        variant="ghost"
        :size="compactActions ? 'sm' : 'md'"
        :disabled="loading"
        @click="$emit('cancel')"
      >
        {{ cancelLabel }}
      </VButton>
      <VButton
        :variant="danger ? 'danger' : 'primary'"
        :size="compactActions ? 'sm' : 'md'"
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
import { IconWarning } from '@/components/icons'

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
    /** Sizing-only fix for a long confirm label (ПРОМТ №609, G10) -- see
     *  the file header. Default false = byte-identical to before. */
    compactActions?: boolean
    /** Peach warning panel + icon around `message` (ПРОМТ №610, owner Q9)
     *  -- see the file header. Default false = byte-identical to before. */
    warningPanel?: boolean
  }>(),
  {
    title: '',
    confirmLabel: 'Подтвердить',
    cancelLabel: 'Отмена',
    danger: false,
    loading: false,
    compactActions: false,
    warningPanel: false,
  },
)

defineEmits<{
  confirm: []
  cancel: []
}>()
</script>

<style scoped>
/* Mirrors VBottomSheet's .v-sheet__title exactly -- same heading token
   recipe across the app's two confirm/sheet primitives. Stepped down to
   --text-lg (ПРОМТ №609, G6/G8) so a two-word title question fits one
   line -- was --text-xl. */
.v-confirm__title {
  font-family: var(--font-heading);
  font-size: var(--text-lg);
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

/* warningPanel (ПРОМТ №610, owner Q9): SAME peach recipe as
   ReportUserSheet's own support notice (--velo-warning-bg, --radius-md,
   --velo-peach-500 text), WITH an icon -- the report sheet deliberately
   has none, this is the real, kept difference between the two. */
.v-confirm__panel {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  background: var(--velo-warning-bg);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
  margin: 0 0 var(--space-4);
}

.v-confirm__panel-icon {
  flex-shrink: 0;
  color: var(--velo-peach-500);
  margin-top: 2px;
}

.v-confirm__panel-text {
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-peach-500);
  text-align: left;
  line-height: 1.5;
  margin: 0;
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
