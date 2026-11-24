<!--
  VELO Frontend -- ConsoleStat (FE-262)

  One figure of a console screen: a small caption over a big number. The
  tone colours the number (a good count, a bad one).
-->

<template>
  <div class="console-stat">
    <span class="console-stat__label">{{ label }}</span>
    <span class="console-stat__value" :class="`console-stat__value--${tone}`">{{ value }}</span>
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    /** Caption over the number. */
    label: string
    /** The number (or a text such as the infinity sign). */
    value: string | number
    /** Colour of the number. */
    tone?: 'neutral' | 'good' | 'bad'
  }>(),
  { tone: 'neutral' },
)
</script>

<style scoped>
.console-stat {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  box-sizing: border-box;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--velo-radius-22);
  background: var(--velo-bg-card-solid);
  box-shadow: var(--velo-shadow-glass);
}

.console-stat__label {
  font-size: var(--velo-fs-12);
  color: var(--velo-text-secondary);
}

.console-stat__value {
  font-size: var(--velo-fs-28);
  -webkit-text-stroke: var(--velo-text-stroke-strong);
}

.console-stat__value--neutral {
  color: var(--velo-text-primary);
}

.console-stat__value--good {
  color: var(--velo-teal-600);
}

.console-stat__value--bad {
  color: var(--velo-pink-500);
}
</style>
