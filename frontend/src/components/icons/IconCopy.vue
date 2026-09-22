<template>
  <!-- Copy glyph for the school invite field (§1.6). Two rounded cards:
       the ghost back card at reduced opacity, the front card solid.
       Monochrome currentColor, DS contract (size prop, no inline color). -->
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="currentColor"
  >
    <path
      d="M4.75 15.5h.75V14h-.75A1.25 1.25 0 0 1 3.5 12.75v-8A1.25 1.25 0 0 1 4.75 3.5h8A1.25 1.25 0 0 1 14 4.75v.75h1.5V4.75A2.75 2.75 0 0 0 12.75 2h-8A2.75 2.75 0 0 0 2 4.75v8A2.75 2.75 0 0 0 4.75 15.5Z"
      opacity="0.55"
    />
    <path
      d="M11.25 21.5h7.5a2.75 2.75 0 0 0 2.75-2.75v-7.5a2.75 2.75 0 0 0-2.75-2.75h-7.5A2.75 2.75 0 0 0 8.5 11.25v7.5a2.75 2.75 0 0 0 2.75 2.75Zm.25-10.75a1.25 1.25 0 0 0-1.25 1.25v7a1.25 1.25 0 0 0 1.25 1.25h7A1.25 1.25 0 0 0 19.75 19v-7a1.25 1.25 0 0 0-1.25-1.25h-7Z"
    />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number | string }>(), { size: 24 })
</script>
