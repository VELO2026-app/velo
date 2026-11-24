<!--
  VELO Frontend -- RequestChip (FE-262, slice 2)

  A chip of the console screens: a static tag (a master's method) or a
  filter button (the verdict of the decided complaints, the closing status of
  the closed tickets). The kit's VChip leaves the gold skin under 4.5:1 for
  its resting chip; here the text is the primary text color on a pale tint,
  and the pressed state is the primary color with white text.
-->

<template>
  <component
    :is="clickable ? 'button' : 'span'"
    :type="clickable ? 'button' : undefined"
    class="request-chip"
    :class="{ 'request-chip--filter': clickable, 'request-chip--active': active }"
    :aria-pressed="clickable ? active : undefined"
  >
    <slot />
  </component>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    /** A filter button instead of a static tag. */
    clickable?: boolean
    /** The pressed filter. */
    active?: boolean
  }>(),
  { clickable: false, active: false },
)
</script>

<style scoped>
.request-chip {
  display: inline-flex;
  align-items: center;
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--velo-border-light);
  border-radius: var(--velo-radius-badge);
  background: var(--velo-bg-card-solid);
  font: inherit;
  font-size: var(--velo-fs-14);
  color: var(--velo-text-primary);
}

.request-chip--filter {
  border-color: transparent;
  background: var(--velo-glass-blue-15);
  cursor: pointer;
}

.request-chip--filter:focus-visible {
  outline: 2px solid var(--velo-primary);
  outline-offset: 2px;
}

.request-chip--active {
  background: var(--velo-primary);
  color: var(--velo-white);
}
</style>
