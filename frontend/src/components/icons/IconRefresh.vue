<template>
  <!-- Refresh glyph (circular arrows) for the school invite field's rotation
       (§1.6). Monochrome currentColor, DS contract (size prop, no inline
       color). -->
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="currentColor"
  >
    <path
      d="M12 4a8 8 0 0 1 7.42 5H17a6 6 0 0 0-10.93.62L7.6 11.14H2.6V6.14l1.86 1.86A7.98 7.98 0 0 1 12 4Zm0 16a8 8 0 0 1-7.42-5H7a6 6 0 0 0 10.93-.62L16.4 12.86h5v5l-1.86-1.86A7.98 7.98 0 0 1 12 20Z"
    />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number | string }>(), { size: 24 })
</script>
