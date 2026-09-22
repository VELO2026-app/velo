<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="currentColor"
  >
    <!-- Two people: front figure + a smaller back figure offset right. -->
    <circle cx="9.2" cy="7.8" r="3.9" />
    <path
      d="M9.2 13.5c-4 0-7.2 2.3-7.2 5.2 0 .86.7 1.56 1.56 1.56h11.28c.86 0 1.56-.7 1.56-1.56 0-2.9-3.2-5.2-7.2-5.2Z"
    />
    <circle cx="17.2" cy="8.4" r="3" />
    <path
      d="M17.6 13.7c2.9.5 5 2.5 5 5 0 .86-.7 1.56-1.56 1.56h-3.1c.32-.46.5-1 .5-1.56 0-1.9-.76-3.66-2.04-5h1.2Z"
    />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number | string }>(), { size: 24 })
</script>
