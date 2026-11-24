<!--
  VELO Frontend -- ConsoleStatusBadge (FE-262)

  A status pill of the web console: a coloured dot and the status word in
  the primary text colour on a light tint of the status colour. The dot says
  the tone, the word says the status: the text keeps its contrast on every
  skin (the kit's VBadge paints the word in the status colour, which is
  under 4.5:1 on a tint).
-->

<template>
  <span class="console-status" :class="`console-status--${tone}`">
    <span class="console-status__dot" aria-hidden="true" />
    <slot />
  </span>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    /** The status colour: a good state, a bad one, one to look at, a plain one, none. */
    tone?: 'success' | 'error' | 'warning' | 'info' | 'neutral'
  }>(),
  { tone: 'neutral' },
)
</script>

<style scoped>
.console-status {
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

.console-status__dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--velo-text-muted);
}

.console-status--success {
  background: var(--velo-glass-teal-30);
}

.console-status--success .console-status__dot {
  background: var(--velo-teal-600);
}

.console-status--error {
  background: var(--velo-error-bg);
}

.console-status--error .console-status__dot {
  background: var(--velo-pink-500);
}

.console-status--warning {
  background: var(--velo-warning-bg);
}

.console-status--warning .console-status__dot {
  background: var(--velo-warning-text);
}

.console-status--info {
  background: var(--velo-glass-blue-15);
}

.console-status--info .console-status__dot {
  background: var(--velo-primary);
}
</style>
