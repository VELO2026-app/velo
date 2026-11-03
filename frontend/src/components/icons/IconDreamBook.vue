<template>
  <!-- Open book with a crescent moon + star for diary "dream" cards
       (i18n:diary.categories.dreams). Monochrome currentColor, card-icon DS contract. -->
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="currentColor"
  >
    <!-- Open book: two pages meeting at the spine. -->
    <path
      d="M12 5.4C10.3 4.2 8.1 3.6 5.7 3.6c-.9 0-1.8.1-2.6.3a1 1 0 0 0-.8 1v12.2a1 1 0 0 0 1.25.97c.7-.18 1.45-.27 2.15-.27 2 0 3.85.5 5.3 1.5a1 1 0 0 0 1.1 0c1.45-1 3.3-1.5 5.3-1.5.7 0 1.45.09 2.15.27A1 1 0 0 0 21.7 17V4.9a1 1 0 0 0-.8-1c-.8-.2-1.7-.3-2.6-.3-2.4 0-4.6.6-6.3 1.8Zm-.9 1.9v10.05c-1.4-.7-3.05-1.05-4.8-1.05-.5 0-1 .03-1.5.1V5.7c.43-.06.86-.1 1.3-.1 1.95 0 3.7.55 5 1.7Zm1.8 10.05V7.3c1.3-1.15 3.05-1.7 5-1.7.44 0 .87.04 1.3.1v10.7c-.5-.07-1-.1-1.5-.1-1.75 0-3.4.35-4.8 1.05Z"
    />
    <!-- Crescent moon + star above the book. -->
    <path d="M16.4 2.1a2.4 2.4 0 1 0 2.5 3.9 3 3 0 0 1-2.5-3.9Z" opacity="0.7" />
    <circle cx="13.7" cy="3.2" r="0.7" opacity="0.7" />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number | string }>(), { size: 24 })
</script>
