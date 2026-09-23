<!--
  VELO Frontend -- IconMoodScaleBad (mood-scale "Плохо")

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
    <rect width="355.699" height="355.699" rx="177.85" fill="#BDECF1" />
    <path
      d="M304.34 188.625L272.012 214.617L310.16 230.91"
      stroke="#4C6589"
      stroke-width="11.2308"
      stroke-linecap="round"
    />
    <path
      d="M55.5952 188.625L87.9229 214.617L49.7752 230.91"
      stroke="#4C6589"
      stroke-width="11.2308"
      stroke-linecap="round"
    />
    <path
      d="M227.64 251.323C197.305 231.822 158.379 231.822 128.044 251.323"
      stroke="#4C6589"
      stroke-width="11.2308"
      stroke-linecap="round"
    />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number | string }>(), { size: 40 })
</script>
