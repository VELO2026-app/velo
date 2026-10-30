<!--
  VELO Frontend -- VSkeletonRow

  Loading placeholder for a list row: a lead circle (avatar / icon) and two
  text lines, on the white card surface (VCard canon) -- chat lists, school
  and member lists, notification feeds.
-->

<template>
  <div class="v-skeleton-row" :class="{ 'v-skeleton-row--bare': bare }" aria-hidden="true">
    <VSkeleton shape="circle" :size="lead" />
    <div class="v-skeleton-row__lines">
      <VSkeleton width="58%" />
      <VSkeleton width="82%" height="0.75em" />
    </div>
  </div>
</template>

<script setup lang="ts">
import VSkeleton from './VSkeleton.vue'

withDefaults(
  defineProps<{
    /** Lead circle diameter (avatar size of the real row). */
    lead?: string
    /** No card surface -- for rows that sit inside an existing card. */
    bare?: boolean
  }>(),
  {
    lead: 'var(--velo-size-46)',
    bare: false,
  },
)
</script>

<style scoped>
.v-skeleton-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  font-size: var(--text-base);
}

.v-skeleton-row--bare {
  background: transparent;
  border-color: transparent;
  padding-inline: 0;
}

.v-skeleton-row__lines {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
</style>
