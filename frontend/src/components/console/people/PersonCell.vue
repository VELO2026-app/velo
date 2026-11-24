<!--
  VELO Frontend -- PersonCell (FE-262)

  The "who" cell of a console table row: an avatar, the name and a muted line
  under it (an id, a role). Used by the masters, users and schools tables.
-->

<template>
  <div class="person-cell">
    <VAvatar :name="name" :url="url ?? undefined" size="sm" />
    <div class="person-cell__text">
      <span class="person-cell__name">{{ name }}</span>
      <span v-if="sub" class="person-cell__sub">{{ sub }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { VAvatar } from '@/components/ui'

defineProps<{
  /** The person's name. */
  name: string
  /** Avatar image; none -- the initials. */
  url?: string | null | undefined
  /** The muted line under the name. */
  sub?: string | undefined
}>()
</script>

<style scoped>
.person-cell {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.person-cell__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.person-cell__name {
  overflow: hidden;
  font-size: var(--velo-fs-14);
  color: var(--velo-text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.person-cell__sub {
  overflow: hidden;
  font-size: var(--velo-fs-12);
  color: var(--velo-text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
