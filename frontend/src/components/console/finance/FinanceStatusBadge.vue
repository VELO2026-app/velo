<!--
  VELO Frontend -- FinanceStatusBadge (FE-267)

  A status pill of the finance tables: a coloured dot and the status word in
  the primary text colour on a light tint of the status colour. The dot says
  the tone, the word says the status, so the text keeps its contrast on every
  skin (the kit's VBadge paints the word in the status colour, which falls
  under 4.5:1 on a tint).
-->

<template>
  <span class="finance-status" :class="`finance-status--${tone}`">
    <span class="finance-status__dot" aria-hidden="true" />
    <slot />
  </span>
</template>

<script setup lang="ts">
/** The colour of a pill: a good state, a refusal, or a quiet one. */
export type FinanceTone = 'success' | 'error' | 'muted'

withDefaults(
  defineProps<{
    /** The status colour (a quiet one by default). */
    tone?: FinanceTone
  }>(),
  { tone: 'muted' },
)
</script>

<style scoped>
.finance-status {
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

.finance-status__dot {
  flex: 0 0 auto;
  width: var(--space-2);
  height: var(--space-2);
  border-radius: var(--radius-full);
  background: var(--velo-text-muted);
}

.finance-status--success {
  background: var(--velo-glass-teal-30);
}

.finance-status--success .finance-status__dot {
  background: var(--velo-teal-600);
}

.finance-status--error {
  background: var(--velo-error-bg);
}

.finance-status--error .finance-status__dot {
  background: var(--velo-pink-500);
}
</style>
