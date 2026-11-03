<!--
  @velo/ui -- VLoader Component (Phase F2.1; migrated FE-140 -- tail of
  FE-117 batch A)

  CSS-only loading spinner. Matches LoadingView spinner style.

  Loading rule (report §8.3): it fades in only after --velo-skeleton-delay,
  so a fast answer never flashes it; the turn is unhurried (1.1 s). For a
  whole screen block prefer a skeleton placeholder in the content's own
  geometry -- a spinner says "wait", a skeleton says "this is what is coming".

  §7.2 (FE-140): the batch A deferral's i18n seam is cut -- the kit is pure
  and the localized loading label arrives through attrs on the root (the
  application barrel re-anchors the t('common.loading') default until P3
  gives the kit its own i18n story; pinned app-side by
  VLoader.localized.test.ts).

  Usage:
    <VLoader />
    <VLoader size="lg" />
-->

<template>
  <div class="v-loader" :class="`v-loader--${size}`" role="status" :data-velo-size="size" />
</template>

<script setup lang="ts">
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
