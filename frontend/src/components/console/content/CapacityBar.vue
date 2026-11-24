<!--
  VELO Frontend -- CapacityBar (FE-262)

  "booked / capacity" with a thin fill bar under it. The bar takes the
  warning tone when the practice is full; a practice with no capacity limit
  shows an infinity sign and no bar.
-->

<template>
  <div class="capacity-bar">
    <span class="capacity-bar__text">{{ booked }} / {{ capacity ?? '∞' }}</span>
    <span v-if="capacity !== null && capacity > 0" class="capacity-bar__track" aria-hidden="true">
      <span
        class="capacity-bar__fill"
        :class="{ 'capacity-bar__fill--full': booked >= capacity }"
        :style="{ width: `${fillPercent}%` }"
      />
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  /** Booked seats. */
  booked: number
  /** Seats in total; null -- no limit. */
  capacity: number | null
}>()

const fillPercent = computed(() =>
  props.capacity === null || props.capacity <= 0
    ? 0
    : Math.min(100, Math.round((props.booked / props.capacity) * 100)),
)
</script>

<style scoped>
.capacity-bar {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  width: 100%;
}

.capacity-bar__text {
  font-size: var(--velo-fs-14);
  color: var(--velo-text-primary);
}

.capacity-bar__track {
  display: block;
  height: var(--space-1);
  overflow: hidden;
  border-radius: var(--radius-full);
  background: var(--velo-border-light);
}

.capacity-bar__fill {
  display: block;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--velo-primary);
}

.capacity-bar__fill--full {
  background: var(--velo-warning);
}
</style>
