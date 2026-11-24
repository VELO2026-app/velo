<!--
  VELO Frontend -- VMenuRow Component (Phase B4.2)

  Settings/profile list row: white plate, optional leading icon, label, optional
  trailing arrow. Variants: default | primary (accent text) | danger.
  The root is a <button type="button">: the row is keyboard-focusable and
  activates on Enter and Space (it was a click-only <div>).

  Usage:
    <VMenuRow label="Edit profile" @click="onEdit">
      <template #icon><IconPen :size="20" /></template>
    </VMenuRow>
    <VMenuRow label="Log out" variant="danger" :show-arrow="false" @click="onLogout">
      <template #icon><IconLogout :size="20" /></template>
    </VMenuRow>
    <VMenuRow label="Messages" dot @click="onMessages">
      <template #icon><IconMessages :size="20" /></template>
    </VMenuRow>
-->

<template>
  <button
    type="button"
    class="v-menu-row"
    :class="{
      'v-menu-row--primary': variant === 'primary',
      'v-menu-row--danger': variant === 'danger',
    }"
    @click="$emit('click', $event)"
  >
    <span v-if="$slots.icon" class="v-menu-row__icon"><slot name="icon" /></span>
    <span class="v-menu-row__text">{{ label }}</span>
    <!-- B52: colour indicator only -- same 8px dot / --velo-primary the
         notification bell already uses (NotificationRow.vue), never a
         count. Mutually exclusive with `badge` in practice (nothing uses
         both today), but not enforced -- either can render alongside the
         arrow. -->
    <span v-if="dot" class="v-menu-row__dot" aria-hidden="true" />
    <span v-if="badge != null && badge !== ''" class="v-menu-row__badge">{{ badge }}</span>
    <span v-if="showArrow" class="v-menu-row__arrow"><IconArrowRight :size="16" /></span>
  </button>
</template>

<script setup lang="ts">
import { IconArrowRight } from '../../icons'

withDefaults(
  defineProps<{
    label: string
    variant?: 'default' | 'primary' | 'danger'
    showArrow?: boolean
    badge?: string | number | undefined
    /** Colour indicator, never a count (B52). */
    dot?: boolean
  }>(),
  {
    variant: 'default',
    showArrow: true,
    dot: false,
  },
)

defineEmits<{
  click: [event: MouseEvent]
}>()
</script>

<style scoped>
.v-menu-row {
  /* A real button, so the row takes keyboard focus and Enter/Space. The first
     block undoes what a button paints by default, to keep the look of the
     plain row it replaced. */
  width: 100%;
  font: inherit;
  letter-spacing: inherit;
  color: inherit;
  text-align: left;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.v-menu-row:active {
  opacity: 0.85;
}

.v-menu-row__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--velo-primary);
  flex-shrink: 0;
}

.v-menu-row__text {
  flex: 1;
  font-family: var(--font-body);
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
}

.v-menu-row__arrow {
  display: inline-flex;
  align-items: center;
  color: var(--velo-text-muted);
}

/* -- Variants -- */
.v-menu-row--primary .v-menu-row__text {
  color: var(--velo-primary);
}

.v-menu-row--danger .v-menu-row__icon,
.v-menu-row--danger .v-menu-row__text {
  color: var(--velo-danger-text);
}

/* Same 8px dot NotificationRow.vue uses for the bell's unread marker --
   one visual language for "unread", not two. */
.v-menu-row__dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--velo-primary);
  flex-shrink: 0;
}

.v-menu-row__badge {
  flex-shrink: 0;
  min-width: 22px;
  height: 22px;
  padding: 0 var(--velo-gap-6);
  border-radius: var(--radius-full);
  background: var(--velo-error);
  color: var(--velo-white);
  font-size: var(--velo-fs-14);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
</style>
