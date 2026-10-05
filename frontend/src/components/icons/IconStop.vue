<template>
  <!-- Stop glyph: a filled rounded square (the classic recording-stop mark).
       currentColor so it inherits the disc button's white glyph color, same
       size-prop contract as every other icon in this barrel. -->
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="currentColor"
  >
    <rect x="5.5" y="5.5" width="13" height="13" rx="2.5" />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number | string }>(), { size: 24 })
</script>
