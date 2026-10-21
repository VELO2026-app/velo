<!--
  VELO Frontend -- VAccordion Component (DS-3)

  Expandable row with header and collapsible content.

  Usage:
    <VAccordion title="Подробности">
      <p>Hidden content here</p>
    </VAccordion>

  Optional slots (additive, backward-compatible — default render unchanged):
    #icon    — leading icon before the title (e.g. <IconClock />).
    #chevron — override the default «›» chevron; receives { open } so the
               caller can drive its own open-state rotation. The default
               chevron keeps its 90° rotate-on-open.
-->

<template>
  <div class="v-accordion" :class="{ 'v-accordion--open': open }">
    <button
      class="v-accordion__header"
      :aria-label="open ? t('ui.collapse') : t('ui.expand')"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="v-accordion__lead">
        <span v-if="$slots.icon" class="v-accordion__icon">
          <slot name="icon" :open="open" />
        </span>
        <span class="v-accordion__title">{{ title }}</span>
      </span>
      <span class="v-accordion__arrow">
        <slot name="chevron" :open="open">
          <span class="v-accordion__arrow-default">›</span>
        </slot>
      </span>
    </button>
    <div v-if="open" class="v-accordion__body">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { ref } from 'vue'

// tz-i18n 1.3: aria labels from the ui.* catalog.

const props = withDefaults(
  defineProps<{
    title: string
    /** Start expanded instead of collapsed (default: collapsed). */
    defaultOpen?: boolean
  }>(),
  { defaultOpen: false },
)

const open = ref(props.defaultOpen)
</script>

<style scoped>
.v-accordion {
  border-bottom: 1px solid var(--velo-border-light);
}

.v-accordion__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: var(--space-3) 0;
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  text-align: left;
}

/* Leading group: optional icon + title. When no #icon slot is passed this
   holds only the title, so existing callers render identically. */
.v-accordion__lead {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.v-accordion__icon {
  display: flex;
  flex-shrink: 0;
}

.v-accordion__arrow {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  font-size: var(--text-lg);
  color: var(--velo-text-muted);
}

/* Default «›» chevron — rotates on open. A #chevron slot override is NOT
   rotated by this rule, so the caller controls its own animation. */
.v-accordion__arrow-default {
  display: inline-block;
  transition: transform var(--transition-fast);
}

.v-accordion--open .v-accordion__arrow-default {
  transform: rotate(90deg);
}

.v-accordion__body {
  padding: 0 0 var(--space-3);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
}
</style>
