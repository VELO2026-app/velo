<!--
  VELO Frontend -- ConsoleCard (FE-262)

  A white card of the web console: optional header (title, a muted note
  after it, and a right-hand slot for links or buttons), then the content.

  Slots: `header-right`, default.
-->

<template>
  <section class="console-card" :class="{ 'console-card--flush': flush }">
    <header v-if="title || $slots['header-right']" class="console-card__head">
      <h2 v-if="title" class="console-card__title">{{ title }}</h2>
      <span v-if="note" class="console-card__note">{{ note }}</span>
      <div v-if="$slots['header-right']" class="console-card__right">
        <slot name="header-right" />
      </div>
    </header>
    <slot />
  </section>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    /** Card title. */
    title?: string | undefined
    /** A muted note after the title (a period, a count). */
    note?: string | undefined
    /** Tight padding for a card that holds a table edge to edge. */
    flush?: boolean
  }>(),
  { title: undefined, note: undefined, flush: false },
)
</script>

<style scoped>
.console-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
  box-sizing: border-box;
  padding: var(--space-5);
  border-radius: var(--velo-radius-22);
  background: var(--velo-bg-card-solid);
  box-shadow: var(--velo-shadow-glass);
}

.console-card--flush {
  padding: var(--space-2);
}

.console-card__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.console-card--flush .console-card__head {
  padding: var(--space-3) var(--space-3) 0;
}

.console-card__title {
  margin: 0;
  font-size: var(--velo-fs-18);
  font-weight: inherit;
  color: var(--velo-text-primary);
  -webkit-text-stroke: var(--velo-text-stroke-strong);
}

.console-card__note {
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
}

.console-card__right {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
}
</style>
