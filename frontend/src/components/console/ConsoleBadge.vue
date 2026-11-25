<!--
  VELO Frontend -- ConsoleBadge (FE-262, FE-272)

  The one status badge of the web console: a tinted pill with a dot whose
  color says the state (success, error, warning, info, muted) and the label
  in the primary text colour (the tint alone never carries the meaning, and
  the label keeps its contrast on every skin). Replaces the three badges the
  slices had (status badge, request badge, people pill).
-->

<template>
  <span class="console-badge" :class="`console-badge--${tone}`">
    <span class="console-badge__dot" aria-hidden="true" />
    <slot />
  </span>
</template>

<script setup lang="ts">
import type { ConsoleTone } from '@/utils/console/tone'

withDefaults(
  defineProps<{
    /** The status colour (a quiet one by default). */
    tone?: ConsoleTone
  }>(),
  { tone: 'muted' },
)
</script>

<style scoped>
.console-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--velo-radius-badge);
  background: var(--velo-bg-subtle);
  font-size: var(--velo-fs-14);
  color: var(--velo-text-primary);
  white-space: nowrap;
}

.console-badge__dot {
  flex: 0 0 auto;
  width: var(--space-2);
  height: var(--space-2);
  border-radius: var(--radius-full);
  background: var(--velo-text-muted);
}

.console-badge--success {
  background: var(--velo-glass-teal-30);
}

.console-badge--success .console-badge__dot {
  background: var(--velo-teal-600);
}

.console-badge--error {
  background: var(--velo-error-bg);
}

.console-badge--error .console-badge__dot {
  background: var(--velo-pink-500);
}

.console-badge--warning {
  background: var(--velo-warning-bg);
}

.console-badge--warning .console-badge__dot {
  background: var(--velo-warning-text);
}

.console-badge--info {
  background: var(--velo-glass-blue-15);
}

.console-badge--info .console-badge__dot {
  background: var(--velo-primary);
}
</style>
