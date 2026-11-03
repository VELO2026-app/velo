<template>
  <!-- Plus / add. Stroke-based primitive (same family as IconCheck/IconArrowRight),
       used on the create-practice action button
       (i18n:masterScreens.masterPractices.createAria). Color via currentColor. -->
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
    <path d="M12 5V19" />
    <path d="M5 12H19" />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number | string }>(), { size: 24 })
</script>
