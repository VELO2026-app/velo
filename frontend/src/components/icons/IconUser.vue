<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="currentColor"
  >
    <!-- One person: head + rounded shoulders. -->
    <circle cx="12" cy="7.4" r="4.2" />
    <path
      d="M12 13.7c-4.5 0-8.1 2.6-8.1 5.8 0 .88.72 1.6 1.6 1.6h13c.88 0 1.6-.72 1.6-1.6 0-3.2-3.6-5.8-8.1-5.8Z"
    />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number | string }>(), { size: 24 })
</script>
