<!--
  VELO Frontend -- LoadErrorState (FE-256..FE-259)

  The block a screen or a section shows when a READ failed: the warning icon,
  "load error" (or the caller's own title), an optional description that names
  what failed, and a Retry button that emits `retry`. One place for the pair
  FE-242 repeated per screen (`VEmptyState icon="warning"` + a Retry button),
  so a failed read looks and works the same everywhere it is wired.

  It is a VEmptyState with the warning icon, so it carries
  data-testid="screen-error" (the e2e crash detector's signal).

  Where the block replaces something (a picker, a list), the caller decides what
  stands in the retry window: this block does not know whether a request is
  running. A caller that wants a loader during the retry shows it instead.
-->

<template>
  <VEmptyState icon="warning" :title="title ?? t('common.loadError')" :description="description">
    <VButton size="sm" :variant="variant" @click="emit('retry')">{{ t('common.retry') }}</VButton>
  </VEmptyState>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { VButton, VEmptyState } from '@/components/ui'

withDefaults(
  defineProps<{
    /** The headline; when absent, the shared "load error" copy (i18n:common.loadError). */
    title?: string | undefined
    /** A line under the headline that names what failed (a list, a section). */
    description?: string | undefined
    /** The Retry button style; `outline` unless the block is the screen's only action. */
    variant?: 'primary' | 'outline' | undefined
  }>(),
  { title: undefined, description: undefined, variant: 'outline' },
)

const emit = defineEmits<{ retry: [] }>()
</script>
