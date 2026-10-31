<template>
  <!-- A five-pointed star, monochrome currentColor (FE-107: the support
       rating's 1..5). `filled` picks the two states one glyph renders:
       fill=currentColor (chosen) or fill=none + the same stroke (empty). -->
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    :fill="filled ? 'currentColor' : 'none'"
    aria-hidden="true"
  >
    <path
      d="M12 3.2l2.6 5.3 5.9.85-4.25 4.14 1 5.86L12 16.6l-5.25 2.76 1-5.86L3.5 9.35l5.9-.85L12 3.2z"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linejoin="round"
      stroke-linecap="round"
    />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number | string; filled?: boolean }>(), {
  size: 24,
  filled: true,
})
</script>
