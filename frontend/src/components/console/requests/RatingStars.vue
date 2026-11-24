<!--
  VELO Frontend -- RatingStars (FE-262, slice 2)

  The person's rating of a ticket as five stars filled to the score: in a list
  row (small) and in the person's panel. Decoration only -- the score is not
  read from the stars; the screens print what the rating says around them.
-->

<template>
  <span class="rating-stars">
    <IconStar
      v-for="n in VALUES"
      :key="n"
      :size="size"
      :filled="n <= stars"
      :class="{ 'rating-stars__star--on': n <= stars }"
    />
  </span>
</template>

<script setup lang="ts">
import { IconStar } from '@/components/icons'

defineProps<{
  /** The score, 1 to 5. */
  stars: number
  /** Star size, px. */
  size: number
}>()

/** The five stars, one value at a time. */
const VALUES = [1, 2, 3, 4, 5] as const
</script>

<style scoped>
.rating-stars {
  display: flex;
  gap: var(--space-1);
  color: var(--velo-text-muted);
}

.rating-stars__star--on {
  color: var(--velo-peach-500);
}
</style>
