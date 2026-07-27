<template>
  <!-- Filled plus -- a SOLID cross (two overlapping bars), not the stroked
       two-line cross IconPlus draws. Sibling component, not a variant prop
       on IconPlus: the two are different SVG techniques (fill vs stroke),
       matching how this icon set already keeps visually-distinct shapes as
       separate files rather than one parameterized component.
       Measured from the owner's SVG (3 My groups.svg, ПРОМТ №609): 20x20
       bounding box, 2px-thick bars. Color via currentColor. -->
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    viewBox="0 0 20 20"
    fill="currentColor"
  >
    <rect x="9" y="0" width="2" height="20" rx="1" />
    <rect x="0" y="9" width="20" height="2" rx="1" />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number | string }>(), { size: 20 })
</script>
