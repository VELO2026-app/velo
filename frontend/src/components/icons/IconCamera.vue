<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="currentColor"
  >
    <!-- Camera: body, top hump, lens ring (cut out via the even-odd hole). -->
    <path
      fill-rule="evenodd"
      d="M9.4 3.6h5.2c.55 0 1.05.3 1.31.79l.86 1.61h2.43A2.8 2.8 0 0 1 22 8.8v8.6a2.8 2.8 0 0 1-2.8 2.8H4.8A2.8 2.8 0 0 1 2 17.4V8.8a2.8 2.8 0 0 1 2.8-2.8h2.43l.86-1.61c.26-.49.76-.79 1.31-.79Zm2.6 5.2a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 0 0 0-8.8Zm0 1.9a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z"
    />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number | string }>(), { size: 24 })
</script>
