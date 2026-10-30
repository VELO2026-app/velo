<!--
  VELO Frontend -- VLoader Component (Phase F2.1)

  CSS-only loading spinner. Matches LoadingView spinner style.

  Loading rule (report §8.3): it fades in only after --velo-skeleton-delay,
  so a fast answer never flashes it; the turn is unhurried (1.1 s). For a
  whole screen block prefer a VSkeleton* placeholder in the content's own
  geometry -- a spinner says "wait", a skeleton says "this is what is coming".

  Usage:
    <VLoader />
    <VLoader size="lg" />
-->

<template>
  <div
    class="v-loader"
    :class="`v-loader--${size}`"
    role="status"
    :aria-label="t('common.loading')"
  />
</template>

<script setup lang="ts">
import { t } from '@/locales'

withDefaults(
  defineProps<{
    size?: 'sm' | 'md' | 'lg'
  }>(),
  {
    size: 'md',
  },
)
</script>

<style scoped>
.v-loader {
  border-style: solid;
  border-color: var(--velo-border);
  border-top-color: var(--velo-primary);
  border-radius: var(--radius-full);
  animation:
    v-loader-appear var(--velo-dur-base) var(--velo-ease-out) var(--velo-skeleton-delay) both,
    v-loader-spin 1.1s linear infinite;
}

@keyframes v-loader-appear {
  from {
    opacity: 0;
  }
}

.v-loader--sm {
  width: 20px;
  height: 20px;
  border-width: 2px;
}

.v-loader--md {
  width: 32px;
  height: 32px;
  border-width: 3px;
}

.v-loader--lg {
  width: 48px;
  height: 48px;
  border-width: 4px;
}

@keyframes v-loader-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
