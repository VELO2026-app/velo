<!--
  @velo/ui -- VTag Component (DS-3; migrated FE-117 batch A)

  Pill-shaped category tag. VELΘ glass tint design.

  Variants: blue | pink | sand
  Usage:
    <VTag variant="blue">Йога</VTag>
    <VTag variant="pink">Медитация</VTag>
    <VTag variant="sand">Дыхание</VTag>
-->

<template>
  <span class="v-tag" :class="`v-tag--${variant}`" :data-velo-variant="variant">
    <slot />
  </span>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: 'blue' | 'pink' | 'sand'
  }>(),
  {
    variant: 'blue',
  },
)
</script>

<style scoped>
.v-tag {
  display: inline-flex;
  align-items: center;
  /* Icon + label pills (method chips): the icon and the text are two flex
     items, so the gap separates them; text-only pills have a single item and
     are unaffected. */
  gap: var(--space-1);
  padding: var(--space-1) var(--velo-inset-12);
  font-size: var(--velo-fs-14);
  /* Rect badge canon (--velo-radius-badge 5px), matching VBadge — tags and
     status badges share one shape across the app. */
  border-radius: var(--velo-radius-badge);
  white-space: nowrap;
}

.v-tag--blue {
  background: var(--velo-blue-100);
  color: var(--velo-primary);
}

.v-tag--pink {
  background: var(--velo-pink-100);
  color: var(--velo-pink-300);
}

.v-tag--sand {
  background: var(--velo-sand-100);
  color: var(--velo-peach-700);
}
</style>
