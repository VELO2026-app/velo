<!--
  VELO Frontend -- VMenuItem (action button inside VMenu)

  A round 40x40 icon button on the brand-blue fill, no label. Used as a child
  of VMenu for each action (edit / delete / filter / search ...). The glyph is
  supplied either via the `icon` prop (an icon component, e.g. IconPen) or via
  the default slot (for inline SVG paths that are not icon components yet).

  The parent wires @click and, after running the action, calls the `close`
  slot-prop that VMenu exposes so the popover dismisses.
-->
<template>
  <button
    type="button"
    class="v-menu-item"
    :class="{ 'v-menu-item--danger': danger }"
    :aria-label="ariaLabel"
  >
    <component :is="icon" v-if="icon" :size="iconSize" />
    <slot v-else />
  </button>
</template>

<script setup lang="ts">
import type { Component } from 'vue'

withDefaults(
  defineProps<{
    /** Icon component to render (e.g. IconPen). Omit to use the default slot. */
    icon?: Component
    /** Accessible label -- there is no visible text. */
    ariaLabel: string
    /** Size passed to the icon component (ignored when using the slot). */
    iconSize?: number
    /** Destructive action — renders the pink (error) fill instead of brand blue. */
    danger?: boolean
  }>(),
  { iconSize: 20, danger: false },
)
</script>

<style scoped>
.v-menu-item {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--velo-size-40);
  height: var(--velo-size-40);
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-full);
  background: var(--velo-nav-active-bg);
  color: var(--velo-white);
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.v-menu-item:hover {
  opacity: 0.85;
}

/* Destructive action (delete) — pink error fill, white glyph. */
.v-menu-item--danger {
  background: var(--velo-error);
}
</style>
