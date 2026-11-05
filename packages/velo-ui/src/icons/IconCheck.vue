<template>
  <!-- Checkmark. Stroke-based so it stays crisp at small sizes (badges,
       verified marks). Color comes from currentColor (set via CSS `color`). -->
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M5 12.5L10 17.5L19 6.5" />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number | string }>(), { size: 24 })
</script>
