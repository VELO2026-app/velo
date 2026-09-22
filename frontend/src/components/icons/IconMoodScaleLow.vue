<!--
  VELO Frontend -- IconMoodScaleLow (mood-scale "Не очень")

  Approved mood-scale face (FE-85, tz-mood-scale.md §6): the raw asset
  frontend/src/assets/mood-scale/mood-low.svg with geometry, colors and
  gradients kept exactly as delivered. Full-color illustrative asset, not
  a currentColor glyph. Gradient id is unique per instance.
-->
<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    viewBox="0 0 356 356"
    fill="none"
  >
    <rect width="355.037" height="355.037" rx="177.518" :fill="`url(#${gid})`" />
    <circle cx="67.452" cy="208.32" r="17.7518" fill="#4C6589" />
    <circle cx="280.473" cy="208.32" r="17.7518" fill="#4C6589" />
    <path
      d="M224.198 261.459C193.863 241.958 154.937 241.958 124.603 261.459"
      stroke="#4C6589"
      stroke-width="11.2308"
      stroke-linecap="round"
    />
    <defs>
      <linearGradient
        :id="gid"
        x1="0"
        y1="177.518"
        x2="355.037"
        y2="177.518"
        gradientUnits="userSpaceOnUse"
      >
        <stop stop-color="#BDECF1" />
        <stop offset="1" stop-color="#F9CBD1" />
      </linearGradient>
    </defs>
  </svg>
</template>

<script setup lang="ts">
import { useId } from 'vue'

withDefaults(defineProps<{ size?: number | string }>(), { size: 40 })

// Unique gradient id per component instance (avoids duplicate-id clashes
// when several mood-scale faces render on the same screen).
const gid = `mood-scale-low-${useId()}`
</script>
