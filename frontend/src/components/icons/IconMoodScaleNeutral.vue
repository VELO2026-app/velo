<!--
  VELO Frontend -- IconMoodScaleNeutral (mood-scale "Нормально")

  Approved mood-scale face (FE-85, tz-mood-scale.md §6): kept 1:1 from the approved source art: geometry, colors and gradients
  exactly as delivered. This component is the in-repo source of truth (raw
  svg sources are not kept). Full-color illustrative asset, not
  a currentColor glyph.
-->
<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    viewBox="0 0 356 356"
    fill="none"
  >
    <rect width="355.699" height="355.699" rx="177.85" fill="#F9CBD1" />
    <circle cx="73.8014" cy="190.783" r="17.7518" fill="#4C6589" />
    <circle cx="286.823" cy="190.783" r="17.7518" fill="#4C6589" />
    <path
      d="M128.914 241.013H229.803"
      stroke="#4C6589"
      stroke-width="11.2099"
      stroke-linecap="round"
    />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number | string }>(), { size: 40 })
</script>
