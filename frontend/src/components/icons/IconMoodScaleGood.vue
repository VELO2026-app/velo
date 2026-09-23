<!--
  VELO Frontend -- IconMoodScaleGood (mood-scale "Хорошо")

  Approved mood-scale face (FE-85, tz-mood-scale.md §6): kept 1:1 from the approved source art: geometry, colors and gradients
  exactly as delivered. This component is the in-repo source of truth (raw
  svg sources are not kept). Full-color illustrative asset, not
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
    <rect width="355.699" height="355.699" rx="177.85" :fill="`url(#${gid})`" />
    <path
      d="M128.055 206.305C158.39 225.806 197.316 225.806 227.651 206.305"
      stroke="#4C6589"
      stroke-width="11.2308"
      stroke-linecap="round"
    />
    <path
      d="M42.6741 163.622C54.7736 180.907 80.3725 180.907 92.472 163.622"
      stroke="#4C6589"
      stroke-width="11.2308"
      stroke-linecap="round"
    />
    <path
      d="M256.104 163.622C268.204 180.907 293.803 180.907 305.902 163.622"
      stroke="#4C6589"
      stroke-width="11.2308"
      stroke-linecap="round"
    />
    <defs>
      <linearGradient
        :id="gid"
        x1="0"
        y1="177.85"
        x2="355.699"
        y2="177.85"
        gradientUnits="userSpaceOnUse"
      >
        <stop stop-color="#F9CBD1" />
        <stop offset="1" stop-color="#FDDFC4" />
      </linearGradient>
    </defs>
  </svg>
</template>

<script setup lang="ts">
import { useId } from 'vue'

withDefaults(defineProps<{ size?: number | string }>(), { size: 40 })

// Unique gradient id per component instance (avoids duplicate-id clashes
// when several mood-scale faces render on the same screen).
const gid = `mood-scale-good-${useId()}`
</script>
