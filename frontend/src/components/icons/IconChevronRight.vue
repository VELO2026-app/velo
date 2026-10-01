<!--
  VELO Frontend -- IconChevronRight

  DS-5 set addition (2026-09-30): the «Предстоящие практики» nav row on the
  master's public profile. Simple 24px stroke chevron, monochrome
  currentColor per the icon-set canon (no baked colours).
-->

<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <path
      d="M9 6l6 6-6 6"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number | string }>(), { size: 24 })
</script>
