<!--
  VELO Frontend -- VEmptyState Component (Phase F2.1; F-9 icons 2026-06)

  Empty state placeholder. Matches mockup .empty-state styles.

  The `icon` prop takes a SEMANTIC KEY (not an emoji) — the DS picks the glyph:
    warning | notfound | calendar | list | group | success | empty
  Usage:
    <VEmptyState icon="calendar" title="Нет практик" description="Создайте первую практику" />
    <VEmptyState icon="warning" title="Ошибка">
      <VButton size="sm" @click="reload">Обновить</VButton>
    </VEmptyState>

  Custom icon via slot (any DS icon component, overrides the key):
    <VEmptyState title="Нет практик">
      <template #icon><IconClock :size="48" /></template>
    </VEmptyState>

  variant="note" (WS-3b T2) — a compact card-wrapped one-liner: solid card plate,
  NO icon, NO title/desc split, NO action. The single message comes from `title`
  (or the default slot). Replaces the bespoke `__empty` plates in the master views.
    <VEmptyState variant="note" title="Данных пока нет" />

  The action button takes EITHER slot — both render into `.v-empty__action`:
    <VEmptyState icon="warning" title="Ошибка">
      <template #action><VButton @click="load">Повторить</VButton></template>
    </VEmptyState>

  Why both (T8, PROMPT №433): 11 views were already written against `#action`, a
  slot this component did not declare. Vue drops an unmatched named slot SILENTLY
  — no warning, no error — so all eleven rendered an error state with no button
  and no way out. 24 other sites use the default slot for the same purpose and
  work. `action` is now declared and is the canonical spelling; the default slot
  stays supported so those 24 keep working and because `note` renders its MESSAGE
  through it. Do not remove the default fallback without migrating all 24 first.
-->

<template>
  <!-- note: compact card-wrapped single-line placeholder (no icon / action). -->
  <div v-if="variant === 'note'" class="v-empty-note">
    <slot>{{ title }}</slot>
  </div>

  <!-- full (default): icon + title + optional description + optional action. -->
  <div v-else class="v-empty">
    <span class="v-empty__icon">
      <slot name="icon"><component :is="resolvedIcon" v-if="resolvedIcon" :size="48" /></slot>
    </span>
    <p class="v-empty__title">{{ title }}</p>
    <p v-if="description" class="v-empty__desc">{{ description }}</p>
    <div v-if="$slots.action || $slots.default" class="v-empty__action">
      <slot name="action" />
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, type Component } from 'vue'
import {
  IconWarning,
  IconCalendar,
  IconList,
  IconGroup,
  IconSuccess,
  IconFile,
} from '@/components/icons'

const props = withDefaults(
  defineProps<{
    /** Semantic key -> DS glyph (see ICON_MAP). Not an emoji. */
    icon?: string
    title: string
    description?: string
    /** 'full' (default) = icon + title + desc + action; 'note' = compact card line. */
    variant?: 'full' | 'note'
  }>(),
  {
    icon: 'empty',
    description: '',
    variant: 'full',
  },
)

const ICON_MAP: Record<string, Component> = {
  warning: IconWarning,
  notfound: IconWarning,
  calendar: IconCalendar,
  list: IconList,
  group: IconGroup,
  success: IconSuccess,
  empty: IconFile,
}

const resolvedIcon = computed<Component | null>(() => ICON_MAP[props.icon] ?? null)
</script>

<style scoped>
.v-empty {
  text-align: center;
  padding: var(--space-8) var(--space-4);
}

.v-empty__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 48px;
  line-height: 1;
  margin-bottom: var(--space-3);
  /* Vector DS icon (resolved from the semantic key) inherits this as currentColor. */
  color: var(--velo-text-muted);
}

.v-empty__title {
  font-size: var(--text-base);
  color: var(--velo-text-secondary);
  margin-bottom: var(--space-1);
}

.v-empty__desc {
  font-size: var(--text-sm);
  color: var(--velo-text-muted);
  line-height: 1.5;
}

.v-empty__action {
  margin-top: var(--space-4);
}

/* ===== note variant — compact card-wrapped one-liner (WS-3b T2) ===== */
.v-empty-note {
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-4);
  text-align: center;
  color: var(--velo-text-muted);
  font-size: var(--text-sm);
  line-height: 1.5;
}
</style>
