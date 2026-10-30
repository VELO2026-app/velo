<!--
  VELO Frontend -- VSkeleton (loading system, report §8.3.3)

  One placeholder shape. Composites (VSkeletonPracticeCard, VSkeletonRow,
  VSkeletonBubbles) build the geometry of a real component out of these, so
  the swap to content does not move the layout.

  Calm by design: a slow opacity "breath" (compositor-only), never a moving
  shimmer -- a sweep repaints every frame and pulls the eye. It fades in only
  after --velo-skeleton-delay, so a fast answer never flashes a placeholder;
  reduced motion = a still fill. Decorative: always aria-hidden -- the
  screen's header / container carries the meaning.

  Usage:
    <VSkeleton width="60%" />                    text line
    <VSkeleton shape="circle" size="46px" />     avatar / icon
    <VSkeleton shape="rect" height="104px" />    block
-->

<template>
  <span
    class="v-skeleton"
    :class="`v-skeleton--${shape}`"
    :style="{
      width: shape === 'circle' ? size : width,
      height: shape === 'circle' ? size : height,
    }"
    aria-hidden="true"
  />
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    shape?: 'line' | 'circle' | 'rect' | 'pill'
    width?: string
    height?: string
    /** Diameter for shape="circle". */
    size?: string
  }>(),
  {
    shape: 'line',
    width: '100%',
    height: undefined,
    size: 'var(--velo-size-40)',
  },
)
</script>

<style scoped>
.v-skeleton {
  display: block;
  flex-shrink: 0;
  background: var(--velo-skeleton-fill);
  border-radius: var(--velo-radius-9);
  animation:
    v-skeleton-appear var(--velo-dur-base) var(--velo-ease-out) var(--velo-skeleton-delay) both,
    v-skeleton-breath var(--velo-dur-pulse) var(--velo-ease-breath)
      calc(var(--velo-skeleton-delay) + var(--velo-dur-base)) infinite;
}

.v-skeleton--line {
  height: 0.9em;
  border-radius: var(--radius-full);
}

.v-skeleton--circle {
  border-radius: var(--radius-full);
}

.v-skeleton--rect {
  border-radius: var(--radius-md);
}

.v-skeleton--pill {
  height: var(--velo-size-44);
  border-radius: var(--radius-full);
}

@keyframes v-skeleton-appear {
  from {
    opacity: 0;
  }
}

@keyframes v-skeleton-breath {
  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.55;
  }
}

@media (prefers-reduced-motion: reduce) {
  .v-skeleton {
    animation: v-skeleton-appear var(--velo-dur-base) linear var(--velo-skeleton-delay) both;
  }
}
</style>
