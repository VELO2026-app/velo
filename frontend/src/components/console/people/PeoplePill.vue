<!--
  VELO Frontend -- PeoplePill (FE-262)

  A status or kind pill of the console people tables and the master card
  (verified, pending, rejected, a role, a curator). The meaning sits in the
  label and in the tint behind it; the text is always the primary text token,
  so the pill reads on every skin -- the kit's VBadge colors its text with the
  tone's own shade, which is under 4.5:1 on the gold skin.
-->

<template>
  <span class="people-pill" :class="`people-pill--${tone}`"><slot /></span>
</template>

<script setup lang="ts">
export type PillTone = 'success' | 'warning' | 'danger' | 'accent' | 'neutral'

withDefaults(
  defineProps<{
    /** The tint and the dot: what the label says, by color. */
    tone?: PillTone
  }>(),
  { tone: 'neutral' },
)
</script>

<style scoped>
.people-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--velo-radius-badge);
  font-size: var(--velo-fs-14);
  color: var(--velo-text-primary);
  white-space: nowrap;
}

.people-pill::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: var(--velo-radius-pill);
  background: currentColor;
}

.people-pill--success {
  background: var(--velo-glass-teal-30);
}

.people-pill--success::before {
  background: var(--velo-teal-600);
}

.people-pill--warning {
  background: var(--velo-glass-peach-40);
}

.people-pill--warning::before {
  background: var(--velo-peach-700);
}

.people-pill--danger {
  background: var(--velo-pink-100);
}

.people-pill--danger::before {
  background: var(--velo-pink-300);
}

.people-pill--accent {
  background: var(--velo-blue-100);
}

.people-pill--accent::before {
  background: var(--velo-primary);
}

.people-pill--neutral {
  background: var(--velo-glass-blue-15);
}

.people-pill--neutral::before {
  background: var(--velo-text-secondary);
}
</style>
