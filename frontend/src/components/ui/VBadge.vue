<!--
  VELO Frontend -- VBadge Component (Phase F2.1)

  Pill-shaped status badge. Matches mockup .badge styles.

  Usage:
    <VBadge variant="success">Confirmed</VBadge>
    <VBadge variant="warning">Pending</VBadge>
    <VBadge variant="error">Canceled</VBadge>
    <VBadge variant="info">New</VBadge>
    <VBadge variant="blue">Free</VBadge>
    <VBadge variant="muted">Did not happen</VBadge>

  `blue` is the calm price/free tone (blue-100 / primary), shared by the
  practice-card free (i18n:common.free) / price badges so they no longer
  hand-roll their own span. `muted` is the low-key blue-grey tone
  (glass-blue-15 / text-secondary) for non-alarming "didn't happen" states
  (no_show, a did-not-happen label); VELO has no pure grey, so it reuses
  existing DS tokens rather than a new colour. Same 4×10 / radius-badge
  shape as every other variant.

  NOTE: `info` is a duplicate of `success` (same teal) — prefer `success`/`blue`;
  `info` is kept only for backward compatibility.
-->

<template>
  <span class="v-badge" :class="`v-badge--${variant}`">
    <slot />
  </span>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: 'success' | 'warning' | 'error' | 'info' | 'blue' | 'muted'
  }>(),
  {
    variant: 'info',
  },
)
</script>

<style scoped>
.v-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--velo-gap-11);
  font-size: var(--velo-fs-14);
  border-radius: var(--velo-radius-badge);
  white-space: nowrap;
}

.v-badge--success {
  background: var(--velo-glass-teal-30);
  color: var(--velo-teal-600);
}

.v-badge--warning {
  background: var(--velo-glass-peach-40);
  color: var(--velo-peach-700);
}

.v-badge--error {
  background: var(--velo-pink-100);
  color: var(--velo-pink-300);
}

.v-badge--info {
  background: var(--velo-glass-teal-30);
  color: var(--velo-teal-600);
}

/* Blue -- calm price / "free" tone (matches VTag blue colours) */
.v-badge--blue {
  background: var(--velo-blue-100);
  color: var(--velo-primary);
}

/* Muted -- low-key blue-grey for non-alarming "didn't happen" (no_show).
   Reuses existing DS tokens (no pure-grey in the palette). */
.v-badge--muted {
  background: var(--velo-glass-blue-15);
  color: var(--velo-text-secondary);
}
</style>
