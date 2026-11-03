<template>
  <!-- Right-pointing arrow. Used for the "Подробнее" forward link on the
       dashboard (it visually sits left of the label but points forward,
       matching Figma Group_2738). Color via currentColor. -->
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M5 12H19" />
    <path d="M13 6L19 12L13 18" />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number | string }>(), { size: 24 })
</script>
