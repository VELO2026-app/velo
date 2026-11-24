<!--
  VELO Frontend -- ConsolePage (FE-262)

  The frame of one web console screen: breadcrumbs, the title with optional
  badges next to it, actions on the right, an optional row of tabs under the
  title, then the screen's content. The page owns its scroll; the menu stays.

  Slots: `title-extra` (badges after the title), `actions` (buttons right of
  the title), `tabs` (a row under the title), default (the content).
-->

<template>
  <section class="console-page" :class="{ 'console-page--fill': fill }" :data-testid="testid">
    <header class="console-page__top">
      <div class="console-page__heading">
        <p v-if="crumbs" class="console-page__crumbs">{{ crumbs }}</p>
        <div class="console-page__title-row">
          <h1 class="console-page__title">{{ title }}</h1>
          <slot name="title-extra" />
        </div>
      </div>
      <div v-if="$slots.actions" class="console-page__actions">
        <slot name="actions" />
      </div>
    </header>
    <div v-if="$slots.tabs" class="console-page__tabs">
      <slot name="tabs" />
    </div>
    <div class="console-page__body">
      <slot />
    </div>
  </section>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    /** Screen title. */
    title: string
    /** Breadcrumbs line over the title (the module group, the parent). */
    crumbs?: string | undefined
    /** data-testid of the page root. */
    testid?: string | undefined
    /** The content fills the page height and scrolls inside (ConsoleSplit)
     *  instead of the whole page scrolling. */
    fill?: boolean
  }>(),
  { crumbs: undefined, testid: 'console-page', fill: false },
)
</script>

<style scoped>
.console-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  height: 100%;
  box-sizing: border-box;
  padding: var(--space-5) var(--space-8) var(--space-10);
  overflow-y: auto;
}

.console-page__top {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.console-page__heading {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.console-page__crumbs {
  margin: 0;
  font-size: var(--velo-fs-12);
  color: var(--velo-text-muted);
}

.console-page__title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}

.console-page__title {
  margin: 0;
  font-size: var(--velo-fs-28);
  font-weight: inherit;
  color: var(--velo-text-primary);
  -webkit-text-stroke: var(--velo-text-stroke-strong);
}

.console-page__actions,
.console-page__tabs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.console-page__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.console-page--fill {
  overflow: hidden;
}

.console-page--fill .console-page__body {
  flex: 1 1 auto;
  min-height: 0;
}

/* A tablet or a small laptop: tighter side padding. */
@media (max-width: 1199px) {
  .console-page {
    padding: var(--space-4) var(--space-5) var(--space-8);
  }
}
</style>
