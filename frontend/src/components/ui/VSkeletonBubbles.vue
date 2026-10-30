<!--
  VELO Frontend -- VSkeletonBubbles

  Loading placeholder for a message thread (chat, diary thread): alternating
  incoming / outgoing bubbles of varied width, so the first real messages
  land where the eye already is.
-->

<template>
  <div class="v-skeleton-bubbles" aria-hidden="true">
    <VSkeleton
      v-for="(b, i) in bubbles"
      :key="i"
      shape="rect"
      class="v-skeleton-bubbles__bubble"
      :class="{ 'v-skeleton-bubbles__bubble--out': b.out }"
      :width="b.width"
      :height="b.height"
    />
  </div>
</template>

<script setup lang="ts">
import VSkeleton from './VSkeleton.vue'

const bubbles = [
  { out: false, width: '62%', height: '56px' },
  { out: true, width: '48%', height: '40px' },
  { out: false, width: '74%', height: '72px' },
  { out: true, width: '56%', height: '40px' },
] as const
</script>

<style scoped>
.v-skeleton-bubbles {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.v-skeleton-bubbles__bubble {
  align-self: flex-start;
}

.v-skeleton-bubbles__bubble--out {
  align-self: flex-end;
}
</style>
