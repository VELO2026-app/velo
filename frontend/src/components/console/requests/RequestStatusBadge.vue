<!--
  VELO Frontend -- RequestStatusBadge (FE-262, slice 2)

  The status pill of a complaint, a ticket or an added method on the console
  screens. The kit's VBadge paints each tone's own text color, which the gold
  skin leaves under 4.5:1 on the tint; here the tint stays (the tone is still
  read at a glance) and the text takes the primary text color, which holds
  contrast on every skin.
-->

<template>
  <span class="request-badge" :class="`request-badge--${tone}`">
    <slot />
  </span>
</template>

<script setup lang="ts">
defineProps<{
  /** The status tone: the same names the kit badge has. */
  tone: 'success' | 'warning' | 'error' | 'info' | 'muted'
}>()
</script>

<style scoped>
.request-badge {
  display: inline-flex;
  align-items: center;
  padding: var(--space-1) var(--velo-gap-11);
  border-radius: var(--velo-radius-badge);
  font-size: var(--velo-fs-14);
  color: var(--velo-text-primary);
  white-space: nowrap;
}

.request-badge--success,
.request-badge--info {
  background: var(--velo-glass-teal-30);
}

.request-badge--warning {
  background: var(--velo-glass-peach-40);
}

.request-badge--error {
  background: var(--velo-pink-100);
}

.request-badge--muted {
  background: var(--velo-glass-blue-15);
}
</style>
