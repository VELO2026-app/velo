<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
  >
    <!-- A question mark in a circle, outline (FE-100: the support topic
         «Другое», owner's mockup 25.10). Same weight as the set's outline
         glyphs; monochrome currentColor, no baked colours. -->
    <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.8" />
    <path
      d="M9.3 9.2a2.75 2.75 0 0 1 5.35.85c0 1.85-2.65 2.35-2.65 4.1"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <circle cx="12" cy="17.3" r="1.1" fill="currentColor" />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number | string }>(), { size: 24 })
</script>
