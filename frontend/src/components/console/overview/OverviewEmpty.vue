<!--
  VELO Frontend -- OverviewEmpty (FE-268)

  The kit's empty / failed state on a white console card. The kit paints the
  description in the muted text colour, which is under 2.2:1 on white in the
  gold skin; the card takes the secondary text colour instead, the pair every
  skin declares for text on a card (the skin's own contrast declaration).

  Slot: the action under the text (a Retry button).
-->

<template>
  <VEmptyState class="overview-empty" :icon="icon" :title="title" :description="description">
    <slot />
  </VEmptyState>
</template>

<script setup lang="ts">
import { VEmptyState } from '@/components/ui'

withDefaults(
  defineProps<{
    /** The kit's glyph key (`warning` for a failure). */
    icon?: string
    /** The headline. */
    title: string
    /** The line under it. */
    description?: string | undefined
  }>(),
  { icon: 'empty', description: undefined },
)
</script>

<style scoped>
.overview-empty :deep(.v-empty__desc) {
  color: var(--velo-text-secondary);
}
</style>
